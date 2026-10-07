import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseRunAt, type ApprovalResult, type ScheduleOutcome, type WebApprovalChannel } from "./approval.js";
import type { EventBus } from "./events.js";
import type { ModelInfo } from "./models.js";

export interface UiServer {
  url: string;
  webApproval: WebApprovalChannel;
  /** Çalışan koşunun AbortController'ını kaydeder (POST /cancel bunu abort eder) */
  setRunAborter(ac: AbortController | null): void;
  close(): void;
}

export interface UiServerOptions {
  /** Panelden görev gönderimi (POST /task). resumeSessionId verilirse o architect
   *  oturumu sürdürülür, yoksa yeni oturum. Kabul edilmezse error döndür. */
  onTask?: (task: string, resumeSessionId?: string) => { ok: boolean; error?: string };
  /** İsimli architect oturumları listesi (GET /sessions) */
  getSessions?: () => unknown[];
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
  getModels?: () => Promise<{ current: string; models: ModelInfo[]; error?: string }>;
  /** Genel modeli değiştirir: çalışan sürece uygular, config.json'a yazar ("" = varsayılan) */
  setModel?: (model: string) => { ok: boolean; error?: string; model?: string };
  /** Düğümü devre dışı bırakır/açar: çalışan sürece uygular, config.json'a yazar */
  setNodeDisabled?: (key: string, disabled: boolean) => { ok: boolean; error?: string };
}

/**
 * İzleme paneli sunucusu — Node'un yerleşik http modülüyle, ek bağımlılıksız.
 *
 *   GET  /          panel sayfası (ui/index.html)
 *   GET  /theme.css paylaşılan Material 3 tema (ui/theme.css)
 *   GET  /logo.svg  marka logosu — favicon + üst şerit (ui/logo.svg)
 *   GET  /events    SSE akışı: önce koşu geçmişi tekrar oynatılır, sonra canlı
 *   POST /approval  { approved: boolean, comment?: string, runAt?: string } — bekleyen onayı çözer
 *   POST /schedule  { action: "run" | "cancel" } — bekleyen zamanlamayı erken çalıştırır/iptal eder
 *   POST /task      { task: string } — panelden yeni görev başlatır (sunucu modu)
 *   GET  /target-dir  şu an kullanılan hedef proje dizinini döner
 *   POST /target-dir  { dir: string } — hedef dizini değiştirir ve config.json'a yazar
 *   GET  /models      { current, models[], error? } — modelsUrl'den çekilen model listesi
 *   POST /model       { model: string } — genel modeli değiştirir ve config.json'a yazar
 *   POST /node-disabled { key: string, disabled: boolean } — düğümü kapatır/açar (canlı + config.json)
 */
export function startUiServer(
  bus: EventBus,
  port: number,
  options: UiServerOptions = {},
): Promise<UiServer> {
  const uiDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "ui");
  const uiPath = path.join(uiDir, "index.html");
  const configUiPath = path.join(uiDir, "config.html");
  const themeCssPath = path.join(uiDir, "theme.css");
  const logoPath = path.join(uiDir, "logo.svg");
  const sseClients = new Set<http.ServerResponse>();
  let pendingApproval: ((r: ApprovalResult) => void) | null = null;
  let pendingSchedule: ((o: Extract<ScheduleOutcome, "run_now" | "cancelled">) => void) | null = null;
  let runAborter: AbortController | null = null;

  const server = http.createServer((req, res) => {
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

    if (req.method === "GET" && req.url === "/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      // Geçmiş boşken de bağlantı hemen kurulsun diye ilk baytı şimdi gönder
      // (SSE yorum satırı) ve düzenli kalp atışıyla hattı canlı tut
      res.write(": bagli\n\n");
      const heartbeat = setInterval(() => res.write(": ping\n\n"), 25000);
      for (const e of bus.history) res.write(`data: ${JSON.stringify(e)}\n\n`);
      const unsubscribe = bus.subscribe((e) => res.write(`data: ${JSON.stringify(e)}\n\n`));
      sseClients.add(res);
      req.on("close", () => {
        clearInterval(heartbeat);
        unsubscribe();
        sseClients.delete(res);
      });
      return;
    }

    if (req.method === "POST" && req.url === "/approval") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        if (!pendingApproval) {
          res.writeHead(409, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, error: "bekleyen onay yok" }));
          return;
        }
        try {
          const parsed = JSON.parse(body) as { approved?: unknown; comment?: unknown; runAt?: unknown };
          const comment =
            typeof parsed.comment === "string" && parsed.comment.trim()
              ? parsed.comment.trim()
              : undefined;
          // runAt panelden ISO metin (datetime-local) ya da epoch ms gelebilir
          let runAt: number | undefined;
          if (typeof parsed.runAt === "number" && Number.isFinite(parsed.runAt)) {
            runAt = parsed.runAt;
          } else if (typeof parsed.runAt === "string") {
            runAt = parseRunAt(parsed.runAt);
          }
          pendingApproval({ approved: Boolean(parsed.approved), comment, runAt });
          pendingApproval = null;
          res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: true }));
        } catch {
          res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, error: "geçersiz JSON" }));
        }
      });
      return;
    }

    if (req.method === "POST" && req.url === "/schedule") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        if (!pendingSchedule) {
          res.writeHead(409, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, error: "bekleyen zamanlama yok" }));
          return;
        }
        try {
          const parsed = JSON.parse(body) as { action?: unknown };
          if (parsed.action !== "run" && parsed.action !== "cancel") {
            res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ ok: false, error: "action 'run' veya 'cancel' olmalı" }));
            return;
          }
          pendingSchedule(parsed.action === "run" ? "run_now" : "cancelled");
          pendingSchedule = null;
          res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: true }));
        } catch {
          res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, error: "geçersiz JSON" }));
        }
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
      res.end(JSON.stringify({ dir: options.getTargetDir?.() ?? "" }));
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
      res.end(JSON.stringify(options.getSessions?.() ?? []));
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
      if (!runAborter || runAborter.signal.aborted) {
        res.writeHead(409, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: "çalışan görev yok" }));
        return;
      }
      runAborter.abort();
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.method === "POST" && req.url === "/task") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const json = (code: number, payload: unknown) => {
          res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify(payload));
        };
        if (!options.onTask) {
          json(409, { ok: false, error: "bu koşu görevini CLI'dan aldı; panelden görev vermek için sunucu modunda başlat (görev argümanı olmadan)" });
          return;
        }
        try {
          const parsed = JSON.parse(body) as { task?: unknown; resumeSessionId?: unknown };
          const task = typeof parsed.task === "string" ? parsed.task.trim() : "";
          if (!task) {
            json(400, { ok: false, error: "görev boş olamaz" });
            return;
          }
          const resumeSessionId =
            typeof parsed.resumeSessionId === "string" && parsed.resumeSessionId
              ? parsed.resumeSessionId
              : undefined;
          const result = options.onTask(task, resumeSessionId);
          json(result.ok ? 202 : 409, result);
        } catch {
          json(400, { ok: false, error: "geçersiz JSON" });
        }
      });
      return;
    }

    res.writeHead(404);
    res.end();
  });

  const webApproval: WebApprovalChannel = {
    wait: () =>
      new Promise<ApprovalResult>((resolve) => {
        pendingApproval = resolve;
      }),
    cancel: () => {
      pendingApproval = null;
    },
    waitSchedule: () =>
      new Promise((resolve) => {
        pendingSchedule = resolve;
      }),
    cancelSchedule: () => {
      pendingSchedule = null;
    },
  };

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, () => {
      resolve({
        url: `http://localhost:${port}`,
        webApproval,
        setRunAborter: (ac) => {
          runAborter = ac;
        },
        close: () => {
          for (const client of sseClients) client.end();
          server.close();
        },
      });
    });
  });
}
