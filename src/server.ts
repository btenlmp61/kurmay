import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ApprovalResult, WebApprovalChannel } from "./approval.js";
import type { EventBus } from "./events.js";

export interface UiServer {
  url: string;
  webApproval: WebApprovalChannel;
  close(): void;
}

export interface UiServerOptions {
  /** Panelden görev gönderimi (POST /task). Kabul edilmezse error döndür. */
  onTask?: (task: string) => { ok: boolean; error?: string };
}

/**
 * İzleme paneli sunucusu — Node'un yerleşik http modülüyle, ek bağımlılıksız.
 *
 *   GET  /          panel sayfası (ui/index.html)
 *   GET  /events    SSE akışı: önce koşu geçmişi tekrar oynatılır, sonra canlı
 *   POST /approval  { approved: boolean, comment?: string } — bekleyen onayı çözer
 *   POST /task      { task: string } — panelden yeni görev başlatır (sunucu modu)
 */
export function startUiServer(
  bus: EventBus,
  port: number,
  options: UiServerOptions = {},
): Promise<UiServer> {
  const uiPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "ui", "index.html");
  const sseClients = new Set<http.ServerResponse>();
  let pendingApproval: ((r: ApprovalResult) => void) | null = null;

  const server = http.createServer((req, res) => {
    if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(fs.readFileSync(uiPath));
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
          const parsed = JSON.parse(body) as { approved?: unknown; comment?: unknown };
          const comment =
            typeof parsed.comment === "string" && parsed.comment.trim()
              ? parsed.comment.trim()
              : undefined;
          pendingApproval({ approved: Boolean(parsed.approved), comment });
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
          const parsed = JSON.parse(body) as { task?: unknown };
          const task = typeof parsed.task === "string" ? parsed.task.trim() : "";
          if (!task) {
            json(400, { ok: false, error: "görev boş olamaz" });
            return;
          }
          const result = options.onTask(task);
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
  };

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, () => {
      resolve({
        url: `http://localhost:${port}`,
        webApproval,
        close: () => {
          for (const client of sseClients) client.end();
          server.close();
        },
      });
    });
  });
}
