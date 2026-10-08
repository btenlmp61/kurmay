import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseRunAt } from "./approval.js";
import type { ModelInfo } from "./models.js";
import type { RuntimeRegistry, SessionRuntime } from "./runtime.js";

export interface UiServer {
  url: string;
  close(): void;
}

export interface UiServerOptions {
  /** Oturum çalışma zamanları — olay akışı, onay/zamanlama/iptal oturum başına */
  runtimes: RuntimeRegistry;
  /** Panelden görev (POST /task). session verilirse o oturumda devam (architect
   *  konuşması sürdürülür), yoksa yeni oturum açılır. Kabul edilirse oturum id'si döner. */
  onTask?: (
    task: string,
    session?: string,
    runAt?: number,
  ) => { ok: boolean; error?: string; session?: string; warning?: string };
  /** Oturum listesi + canlı durumları (GET /sessions ve /lobby SSE) */
  getSessions: () => unknown[];
  /** Oturum biliniyorsa runtime'ını verir (geçmişi diskten yükleyerek); yoksa undefined */
  openSession: (id: string) => SessionRuntime | undefined;
  /** Bir oturumu katalogdan siler (POST /session-delete); silindiyse true */
  deleteSession?: (id: string) => boolean;
  /** Config editörü verisi: ham config.json + kullanılabilir kural/beceri/ajan-md adları */
  getConfigData?: () => { raw: string; rules: string[]; skills: string[]; agents: string[] };
  /** Config'i doğrulayıp kaydeder; hata varsa mesaj döner, başarılıysa null */
  saveConfig?: (raw: string) => string | null;
  /** Yeni ajan düğümü için şablon persona .md oluşturur */
  createAgentMd?: (name: string) => { ok: boolean; file?: string; error?: string };
  /** Şu an kullanılan hedef proje dizini (GET /target-dir) */
  getTargetDir?: () => string;
  /** Hedef dizini değiştirir: doğrular, çalışan sürece uygular, config.json'a yazar */
  setTargetDir?: (dir: string) => { ok: boolean; error?: string; dir?: string };
  /** Seçili model + config'teki modelsUrl'den çekilen liste (GET /models).
   *  Liste alınamazsa error dolu döner ama seçili model yine gösterilir */
  getModels?: () => Promise<{ current: string; required?: boolean; models: ModelInfo[]; error?: string }>;
  /** Genel modeli değiştirir: çalışan sürece uygular, config.json'a yazar ("" = varsayılan) */
  setModel?: (model: string) => { ok: boolean; error?: string; model?: string };
  /** Akışın ana yolu + düğümlerin açık/kapalı durumu (GET /workflow) — görev kartı çipleri */
  getWorkflow?: () => { entry: string; nodes: Array<{ key: string; type: string; disabled: boolean; agent?: string }> };
  /** Düğümü devre dışı bırakır/açar: çalışan sürece uygular, config.json'a yazar */
  setNodeDisabled?: (key: string, disabled: boolean) => { ok: boolean; error?: string };
}

/**
 * İzleme paneli sunucusu — Node'un yerleşik http modülüyle, ek bağımlılıksız.
 *
 *   GET  /          panel sayfası (ui/index.html)
 *   GET  /theme.css paylaşılan Material 3 tema (ui/theme.css)
 *   GET  /logo.svg  marka logosu — favicon + üst şerit (ui/logo.svg)
 *   GET  /events?session=ID  SSE: o oturumun geçmişi (diskteki kayıtlar dahil) + canlı akışı
 *   GET  /lobby     SSE: oturum listesi + durumları, her değişiklikte tam liste
 *   POST /approval  { session, approved, comment?, runAt? } — o oturumun bekleyen onayını çözer
 *   POST /schedule  { session, action: "run" | "cancel" } — bekleyen zamanlamayı erken çalıştırır/iptal eder
 *   POST /cancel    { session } — o oturumun koşusunu durdurur
 *   POST /task      { task, session?, runAt? } — görev başlatır (session yoksa yeni oturum);
 *                   oturumlar birbirinden bağımsız, aynı anda koşabilir
 *   GET  /target-dir  { dir, exists } — hedef proje dizini ve diskte var mı (yoksa panel uyarır)
 *   POST /target-dir  { dir: string } — hedef dizini değiştirir ve config.json'a yazar
 *   GET  /models      { current, models[], error? } — modelsUrl'den çekilen model listesi
 *   POST /model       { model: string } — genel modeli değiştirir ve config.json'a yazar
 *   GET  /workflow      { entry, nodes[] } — ana yol sırasıyla düğümler ve açık/kapalı durumları
 *   POST /node-disabled { key: string, disabled: boolean } — düğümü kapatır/açar (canlı + config.json)
 */
export function startUiServer(port: number, options: UiServerOptions): Promise<UiServer> {
  const uiDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "ui");
  const uiPath = path.join(uiDir, "index.html");
  const configUiPath = path.join(uiDir, "config.html");
  const themeCssPath = path.join(uiDir, "theme.css");
  const logoPath = path.join(uiDir, "logo.svg");
  const sseClients = new Set<http.ServerResponse>();
  const json = (res: http.ServerResponse, code: number, payload: unknown) => {
    res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(payload));
  };
  /** SSE yanıtını açar: hemen ilk bayt + 25 sn kalp atışı; kapanınca temizlik */
  const openSse = (req: http.IncomingMessage, res: http.ServerResponse, onClose: () => void) => {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    res.write(": bagli\n\n");
    const heartbeat = setInterval(() => res.write(": ping\n\n"), 25000);
    sseClients.add(res);
    req.on("close", () => {
      clearInterval(heartbeat);
      onClose();
      sseClients.delete(res);
    });
  };
  /** Gövdeyi JSON nesnesi olarak okur; bozuksa null */
  const readJson = (req: http.IncomingMessage, cb: (body: Record<string, unknown> | null) => void) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        const v = JSON.parse(body) as unknown;
        cb(v && typeof v === "object" ? (v as Record<string, unknown>) : null);
      } catch {
        cb(null);
      }
    });
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(fs.readFileSync(uiPath));
      return;
    }

    if (req.method === "GET" && req.url === "/theme.css") {
      res.writeHead(200, { "content-type": "text/css; charset=utf-8" });
      res.end(fs.readFileSync(themeCssPath));
      return;
    }

    if (req.method === "GET" && req.url === "/logo.svg") {
      res.writeHead(200, { "content-type": "image/svg+xml; charset=utf-8" });
      res.end(fs.readFileSync(logoPath));
      return;
    }

    // Oturumun olay akışı: önce geçmiş (servis yeniden başladıysa diskten), sonra canlı
    if (req.method === "GET" && url.pathname === "/events") {
      const rt = options.openSession(url.searchParams.get("session") ?? "");
      if (!rt) {
        res.writeHead(404);
        res.end();
        return;
      }
      let unsubscribe = () => {};
      openSse(req, res, () => unsubscribe());
      for (const e of rt.bus.history) res.write(`data: ${JSON.stringify(e)}\n\n`);
      // Geçmiş bitti: panel yeniden oynatmayı burada kapatır, oturumun anlık durumunu uygular
      res.write(`event: ready\ndata: ${JSON.stringify({ status: rt.status, busy: rt.busy })}\n\n`);
      unsubscribe = rt.bus.subscribe((e) => res.write(`data: ${JSON.stringify(e)}\n\n`));
      return;
    }

    // Lobi: oturum listesi + durumları; her değişiklikte tam liste (küçük, sade)
    if (req.method === "GET" && url.pathname === "/lobby") {
      const send = () => res.write(`data: ${JSON.stringify(options.getSessions())}\n\n`);
      let off = () => {};
      openSse(req, res, () => off());
      send();
      off = options.runtimes.onLobby(send);
      return;
    }

    if (req.method === "POST" && req.url === "/approval") {
      readJson(req, (parsed) => {
        if (!parsed) return json(res, 400, { ok: false, error: "geçersiz JSON" });
        const rt = options.runtimes.peek(String(parsed.session ?? ""));
        const comment =
          typeof parsed.comment === "string" && parsed.comment.trim() ? parsed.comment.trim() : undefined;
        // runAt panelden ISO metin (datetime-local) ya da epoch ms gelebilir
        let runAt: number | undefined;
        if (typeof parsed.runAt === "number" && Number.isFinite(parsed.runAt)) runAt = parsed.runAt;
        else if (typeof parsed.runAt === "string") runAt = parseRunAt(parsed.runAt);
        if (!rt?.resolveApproval({ approved: Boolean(parsed.approved), comment, runAt })) {
          return json(res, 409, { ok: false, error: "bu oturumda bekleyen onay yok" });
        }
        json(res, 200, { ok: true });
      });
      return;
    }

    if (req.method === "POST" && req.url === "/schedule") {
      readJson(req, (parsed) => {
        if (!parsed) return json(res, 400, { ok: false, error: "geçersiz JSON" });
        if (parsed.action !== "run" && parsed.action !== "cancel") {
          return json(res, 400, { ok: false, error: "action 'run' veya 'cancel' olmalı" });
        }
        const rt = options.runtimes.peek(String(parsed.session ?? ""));
        if (!rt?.resolveSchedule(parsed.action === "run" ? "run_now" : "cancelled")) {
          return json(res, 409, { ok: false, error: "bu oturumda bekleyen zamanlama yok" });
        }
        json(res, 200, { ok: true });
      });
      return;
    }

    if (req.method === "GET" && req.url === "/config") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(fs.readFileSync(configUiPath));
      return;
    }

    if (req.method === "GET" && req.url === "/config-data") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(options.getConfigData?.() ?? { raw: "{}", rules: [], skills: [], agents: [] }));
      return;
    }

    if (req.method === "POST" && req.url === "/agent-md") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        let name = "";
        try {
          name = String((JSON.parse(body) as { name?: unknown }).name ?? "");
        } catch {
          /* boş ad → hata döner */
        }
        const r = options.createAgentMd ? options.createAgentMd(name) : { ok: false, error: "kapalı" };
        res.writeHead(r.ok ? 200 : 400, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(r));
      });
      return;
    }

    if (req.method === "POST" && req.url === "/config") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const err = options.saveConfig ? options.saveConfig(body) : "kaydetme kapalı";
        if (err) {
          res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, error: err }));
        } else {
          res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: true }));
        }
      });
      return;
    }

    if (req.method === "GET" && req.url === "/target-dir") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      // exists her istekte bakılır: dizin sonradan oluşturulursa uyarı kendiliğinden kalkar
      const dir = options.getTargetDir?.() ?? "";
      let exists = false;
      try {
        exists = !!dir && fs.statSync(dir).isDirectory();
      } catch {
        /* yok */
      }
      res.end(JSON.stringify({ dir, exists }));
      return;
    }

    if (req.method === "POST" && req.url === "/target-dir") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        let dir = "";
        try {
          dir = String((JSON.parse(body) as { dir?: unknown }).dir ?? "").trim();
        } catch {
          res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, error: "geçersiz JSON" }));
          return;
        }
        if (!dir) {
          res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, error: "dizin boş olamaz" }));
          return;
        }
        const r = options.setTargetDir ? options.setTargetDir(dir) : { ok: false, error: "kapalı" };
        res.writeHead(r.ok ? 200 : 400, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(r));
      });
      return;
    }

    if (req.method === "GET" && req.url === "/models") {
      const json = (payload: unknown) => {
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(payload));
      };
      if (!options.getModels) {
        json({ current: "", models: [], error: "kapalı" });
        return;
      }
      options.getModels().then(json, (e: unknown) =>
        json({ current: "", models: [], error: e instanceof Error ? e.message : String(e) }),
      );
      return;
    }

    if (req.method === "POST" && req.url === "/model") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        let model = "";
        try {
          model = String((JSON.parse(body) as { model?: unknown }).model ?? "").trim();
        } catch {
          res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, error: "geçersiz JSON" }));
          return;
        }
        const r = options.setModel ? options.setModel(model) : { ok: false, error: "kapalı" };
        res.writeHead(r.ok ? 200 : 400, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(r));
      });
      return;
    }

    if (req.method === "GET" && req.url === "/workflow") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(options.getWorkflow?.() ?? { entry: "", nodes: [] }));
      return;
    }

    if (req.method === "POST" && req.url === "/node-disabled") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        let key = "";
        let disabled = false;
        try {
          const parsed = JSON.parse(body) as { key?: unknown; disabled?: unknown };
          key = String(parsed.key ?? "");
          disabled = parsed.disabled === true;
        } catch {
          res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, error: "geçersiz JSON" }));
          return;
        }
        const r = options.setNodeDisabled ? options.setNodeDisabled(key, disabled) : { ok: false, error: "kapalı" };
        res.writeHead(r.ok ? 200 : 400, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(r));
      });
      return;
    }

    if (req.method === "GET" && req.url === "/sessions") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(options.getSessions()));
      return;
    }

    if (req.method === "POST" && req.url === "/session-delete") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        let id = "";
        try {
          id = String((JSON.parse(body) as { id?: unknown }).id ?? "");
        } catch {
          /* boş id → false */
        }
        const ok = id && options.deleteSession ? options.deleteSession(id) : false;
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok }));
      });
      return;
    }

    if (req.method === "POST" && req.url === "/cancel") {
      readJson(req, (parsed) => {
        const rt = options.runtimes.peek(String(parsed?.session ?? ""));
        if (!rt?.cancel()) return json(res, 409, { ok: false, error: "bu oturumda çalışan görev yok" });
        json(res, 200, { ok: true });
      });
      return;
    }

    if (req.method === "POST" && req.url === "/task") {
      readJson(req, (parsed) => {
        if (!options.onTask) {
          return json(res, 409, {
            ok: false,
            error: "bu koşu görevini CLI'dan aldı; panelden görev vermek için sunucu modunda başlat (görev argümanı olmadan)",
          });
        }
        if (!parsed) return json(res, 400, { ok: false, error: "geçersiz JSON" });
        const task = typeof parsed.task === "string" ? parsed.task.trim() : "";
        if (!task) return json(res, 400, { ok: false, error: "görev boş olamaz" });
        const session = typeof parsed.session === "string" && parsed.session ? parsed.session : undefined;
        // runAt: ileri bir başlangıç zamanı (epoch ms ya da "+30m"/"2026-07-10 14:00" metni)
        let runAt: number | undefined;
        if (typeof parsed.runAt === "number" && Number.isFinite(parsed.runAt)) runAt = parsed.runAt;
        else if (typeof parsed.runAt === "string" && parsed.runAt.trim()) {
          runAt = parseRunAt(parsed.runAt);
          if (runAt === undefined) {
            return json(res, 400, { ok: false, error: `başlangıç zamanı anlaşılamadı: ${parsed.runAt}` });
          }
        }
        const result = options.onTask(task, session, runAt);
        json(res, result.ok ? 202 : 409, result);
      });
      return;
    }

    res.writeHead(404);
    res.end();
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, () => {
      resolve({
        url: `http://localhost:${port}`,
        close: () => {
          for (const client of sseClients) client.end();
          server.close();
        },
      });
    });
  });
}
