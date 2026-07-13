import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { loadAgents } from "./agents.js";
import { loadAppConfig } from "./config.js";
import { EventBus } from "./events.js";
import { runWorkflow } from "./orchestrator.js";
import { startUiServer, type UiServer } from "./server.js";
import { SessionStore } from "./sessions.js";
import type { AgentDefinition, AppConfig } from "./types.js";

function parseArgs(argv: string[]): {
  task: string;
  configPath: string;
  cwdFlag?: string;
  portFlag?: number;
  noUi: boolean;
} {
  let configPath = "config.json";
  let cwdFlag: string | undefined;
  let portFlag: number | undefined;
  let noUi = false;
  const taskParts: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--config") configPath = argv[++i];
    else if (argv[i] === "--cwd") cwdFlag = argv[++i];
    else if (argv[i] === "--port") portFlag = Number(argv[++i]);
    else if (argv[i] === "--no-ui") noUi = true;
    else taskParts.push(argv[i]);
  }

  return { task: taskParts.join(" ").trim(), configPath, cwdFlag, portFlag, noUi };
}

/** Tek bir görevi baştan sona koşturur; olaylar bus'a, kayıt runs/'a gider */
async function executeRun(
  task: string,
  cfg: AppConfig,
  agents: Map<string, AgentDefinition>,
  cwd: string,
  bus: EventBus,
  runsDir: string,
  sessionStore: { entrySessionId?: string },
  server?: UiServer,
): Promise<void> {
  bus.reset();
  const runLog = path.join(runsDir, `${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);
  const unsubscribe = bus.subscribe((e) => fs.appendFileSync(runLog, JSON.stringify(e) + "\n"));

  console.log(`\n🎯 Görev: ${task}`);
  bus.emit({
    type: "workflow_started",
    task,
    provider: cfg.provider,
    targetDir: cwd,
    entry: cfg.workflow.entry,
    maxCycles: cfg.workflow.maxCycles,
    agents: [...agents.keys()],
  });

  // Koşu başına iptal denetçisi: panelden POST /cancel bunu abort eder
  const abortController = new AbortController();
  server?.setRunAborter(abortController);

  try {
    await runWorkflow(cfg.workflow, agents, task, cwd, cfg, bus, abortController, server?.webApproval, sessionStore);
  } catch (err) {
    bus.emit({ type: "workflow_failed", error: err instanceof Error ? err.message : String(err) });
    throw err;
  } finally {
    server?.setRunAborter(null);
    unsubscribe();
    console.log(`🗒  Koşu kaydı: ${runLog}`);
  }
}

async function main() {
  const { task, configPath, cwdFlag, portFlag, noUi } = parseArgs(process.argv.slice(2));

  const cfg = loadAppConfig(configPath);
  const configRoot = path.dirname(path.resolve(configPath));
  // md dosya yolları config dosyasının bulunduğu dizine göre çözülür
  const agents = loadAgents(cfg.workflow, configRoot);

  // Hedef dizin önceliği: --cwd bayrağı > config'deki targetDir > bulunulan dizin
  const cwd = path.resolve(cwdFlag ?? cfg.targetDir ?? process.cwd());
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
    throw new Error(`Hedef proje dizini bulunamadı: ${cwd}`);
  }

  if (!task && noUi) {
    console.error(
      'Kullanım: npm start -- "görev" [--config config.json] [--cwd dizin] [--port 4141] [--no-ui]\n' +
        "Görev verilmezse sunucu modu açılır ve görev panelden beklenir (--no-ui ile birlikte kullanılamaz).",
    );
    process.exit(1);
  }

  const bus = new EventBus();
  const runsDir = path.join(configRoot, "runs");
  fs.mkdirSync(runsDir, { recursive: true });

  // İsimli architect oturumlarının kalıcı kataloğu (runs/sessions.json)
  const sessions = new SessionStore(runsDir);

  // Sunucu modunda panelden görev kabulü: aynı anda tek koşu
  let running = false;
  let wakeWithTask: ((v: { task: string; resumeSessionId?: string }) => void) | null = null;

  let server: UiServer | undefined;
  if (!noUi) {
    server = await startUiServer(bus, portFlag ?? cfg.uiPort ?? 4141, {
      getSessions: () => sessions.all(),
      onTask: task
        ? undefined // CLI görevli modda panelden görev alınmaz
        : (t, resumeSessionId) => {
            if (running || !wakeWithTask) return { ok: false, error: "şu an bir görev çalışıyor" };
            running = true;
            const wake = wakeWithTask;
            wakeWithTask = null;
            wake({ task: t, resumeSessionId });
            return { ok: true };
          },
    });
    console.log(`🖥  İzleme paneli: ${server.url}`);
  }

  console.log(`🔌 Sağlayıcı: ${cfg.provider}${cfg.baseUrl ? ` (${cfg.baseUrl})` : ""}${cfg.model ? ` | model: ${cfg.model}` : ""}`);
  console.log(`📁 Hedef proje dizini: ${cwd}`);
  console.log(`🗺  Akış: ${[...agents.keys()].join(" → ")} (entry: ${cfg.workflow.entry})`);

  if (task) {
    // Tek görev modu: çalıştır ve çık (yeni oturum)
    const sessionStore = { entrySessionId: undefined as string | undefined };
    try {
      await executeRun(task, cfg, agents, cwd, bus, runsDir, sessionStore, server);
    } finally {
      if (sessionStore.entrySessionId) sessions.record(sessionStore.entrySessionId, task);
      server?.close();
    }
    return;
  }

  // Sunucu modu: panelden görev bekle, bitince yenisini bekle
  console.log("⏳ Görev bekleniyor — panelden girebilirsin.");
  while (true) {
    const { task: nextTask, resumeSessionId } = await new Promise<{ task: string; resumeSessionId?: string }>(
      (resolve) => {
        wakeWithTask = resolve;
      },
    );
    // resumeSessionId verildiyse o architect oturumu sürdürülür; yoksa yeni oturum
    const sessionStore = { entrySessionId: resumeSessionId };
    try {
      await executeRun(nextTask, cfg, agents, cwd, bus, runsDir, sessionStore, server);
    } catch (err) {
      // Sunucu modunda tek koşunun hatası servisi düşürmez; panel workflow_failed gördü
      console.error("💥 Koşu hatası:", err instanceof Error ? err.message : err);
    } finally {
      running = false;
      // architect bir oturum ürettiyse katalogla (yeni id ise ismiyle eklenir)
      if (sessionStore.entrySessionId) sessions.record(sessionStore.entrySessionId, nextTask);
    }
    console.log("\n⏳ Yeni görev bekleniyor — panelden girebilirsin.");
  }
}

main().catch((err) => {
  console.error("\n💥 Hata:", err instanceof Error ? err.message : err);
  process.exit(1);
});
