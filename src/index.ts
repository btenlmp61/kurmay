import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { loadAgents } from "./agents.js";
import { loadAppConfig } from "./config.js";
import { EventBus } from "./events.js";
import { fetchModels } from "./models.js";
import { runWorkflow } from "./orchestrator.js";
import { startUiServer, type UiServer } from "./server.js";
import { SessionStore } from "./sessions.js";
import { isFanoutNode, type AgentDefinition, type AppConfig } from "./types.js";

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

/**
 * Koşu başına config kopyası: panelden canlı değişen alanlar (model, düğümlerin
 * `disabled`'ı) o an çalışan koşuyu ORTASINDA etkilemesin, sıradaki görevde
 * geçerli olsun. Workflow da kopyalanır çünkü `disabled` onun içinde.
 */
function snapshotConfig(cfg: AppConfig): AppConfig {
  return { ...cfg, workflow: structuredClone(cfg.workflow) };
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
  // Resume'lu koşuda panel geçmişini temizleme — konuşma birikiyormuş gibi görünsün
  const resumed = !!sessionStore.entrySessionId;
  if (!resumed) bus.reset();
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
    resumed,
    fanouts: Object.fromEntries(
      Object.entries(cfg.workflow.agents)
        .filter(([, n]) => isFanoutNode(n))
        .map(([key, n]) => [key, (n as { agent: string }).agent]),
    ),
    disabled: Object.entries(cfg.workflow.agents)
      .filter(([, n]) => n.disabled)
      .map(([key]) => key),
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
  const resolvedConfigPath = path.resolve(configPath);
  const configRoot = path.dirname(resolvedConfigPath);
  // md dosya yolları config dosyasının bulunduğu dizine göre çözülür
  const agents = loadAgents(cfg.workflow, configRoot);

  // Hedef dizin önceliği: --cwd bayrağı > config'deki targetDir > bulunulan dizin.
  // "let": panelden değiştirilebilir (bkz. setTargetDir) — bir sonraki görev yeni
  // değeri kullanır, config.json'a da yazılır (sürekli dosyayı elle açmamak için).
  let cwd = path.resolve(cwdFlag ?? cfg.targetDir ?? process.cwd());
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
      deleteSession: (id) => sessions.remove(id),
      getConfigData: () => {
        const raw = fs.readFileSync(resolvedConfigPath, "utf8");
        const ls = (sub: string) => {
          try {
            return fs.readdirSync(path.join(configRoot, ".claude", sub), { withFileTypes: true });
          } catch {
            return [];
          }
        };
        const rules = ls("rules")
          .filter((e) => e.isFile() && e.name.endsWith(".md"))
          .map((e) => e.name.replace(/\.md$/, ""));
        const skills = ls("skills").filter((e) => e.isDirectory()).map((e) => e.name);
        const agentMds = ls("agents")
          .filter((e) => e.isFile() && e.name.endsWith(".md"))
          .map((e) => e.name.replace(/\.md$/, ""));
        return { raw, rules, skills, agents: agentMds };
      },
      createAgentMd: (name) => {
        // path traversal'a karşı ad temizlenir; yalnızca .claude/agents altına yazılır
        const safe = String(name).trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/^-+|-+$/g, "");
        if (!safe) return { ok: false, error: "geçersiz persona adı" };
        const rel = `.claude/agents/${safe}.md`;
        const abs = path.join(configRoot, rel);
        if (fs.existsSync(abs)) return { ok: false, error: `zaten var: ${rel}` };
        const tpl =
          `---\nname: ${safe}\ndescription: ${safe} ajanı\n---\n\n` +
          `Sen ${safe} rolündeki bir ajansın. Görevini yerine getir; çıktın net ve uygulanabilir olsun.\n`;
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, tpl);
        return { ok: true, file: rel };
      },
      saveConfig: (text): string | null => {
        const prev = fs.readFileSync(resolvedConfigPath, "utf8");
        try {
          JSON.parse(text); // geçerli JSON mu
          fs.writeFileSync(resolvedConfigPath, text);
          const c = loadAppConfig(resolvedConfigPath); // yapı + mcp + komut doğrulaması
          loadAgents(c.workflow, configRoot); // kenar + md + kural/beceri doğrulaması
          return null;
        } catch (e) {
          fs.writeFileSync(resolvedConfigPath, prev); // geçersizse geri al
          return e instanceof Error ? e.message : String(e);
        }
      },
      getTargetDir: () => cwd,
      setTargetDir: (dir) => {
        const resolvedDir = path.resolve(dir);
        if (!fs.existsSync(resolvedDir) || !fs.statSync(resolvedDir).isDirectory()) {
          return { ok: false, error: `dizin bulunamadı: ${resolvedDir}` };
        }
        const prev = fs.readFileSync(resolvedConfigPath, "utf8");
        try {
          const parsed = JSON.parse(prev) as Record<string, unknown>;
          parsed.targetDir = resolvedDir; // yoksa eklenir, varsa güncellenir
          fs.writeFileSync(resolvedConfigPath, JSON.stringify(parsed, null, 2));
          loadAppConfig(resolvedConfigPath); // yapı doğrulaması
          cwd = resolvedDir; // sıradaki görev bu dizini kullanır
          return { ok: true, dir: resolvedDir };
        } catch (e) {
          fs.writeFileSync(resolvedConfigPath, prev); // geçersizse geri al
          return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
      },
      getModels: async () => {
        const current = cfg.model ?? "";
        if (!cfg.modelsUrl) {
          return { current, models: [], error: 'config\'te "modelsUrl" tanımlı değil' };
        }
        try {
          return { current, models: await fetchModels(cfg.modelsUrl, cfg.apiKey) };
        } catch (e) {
          return { current, models: [], error: e instanceof Error ? e.message : String(e) };
        }
      },
      setModel: (model) => {
        const prev = fs.readFileSync(resolvedConfigPath, "utf8");
        try {
          const parsed = JSON.parse(prev) as Record<string, unknown>;
          parsed.model = model; // "" = sağlayıcı varsayılanı (loadAppConfig tanımsız sayar)
          fs.writeFileSync(resolvedConfigPath, JSON.stringify(parsed, null, 2));
          loadAppConfig(resolvedConfigPath); // ör. ollama'da model zorunlu — boş geçilemez
          // Sıradaki görev bu modeli kullanır; çalışan koşu kendi kopyasıyla devam eder
          if (model) cfg.model = model;
          else delete cfg.model;
          return { ok: true, model };
        } catch (e) {
          fs.writeFileSync(resolvedConfigPath, prev); // geçersizse geri al
          return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
      },
      setNodeDisabled: (key, disabled) => {
        if (!cfg.workflow.agents[key]) return { ok: false, error: `düğüm bulunamadı: ${key}` };
        const prev = fs.readFileSync(resolvedConfigPath, "utf8");
        try {
          const parsed = JSON.parse(prev) as AppConfig;
          const node = parsed.workflow?.agents?.[key];
          if (!node) return { ok: false, error: `düğüm config dosyasında yok: ${key}` };
          if (disabled) node.disabled = true;
          else delete node.disabled;
          fs.writeFileSync(resolvedConfigPath, JSON.stringify(parsed, null, 2));
          loadAppConfig(resolvedConfigPath); // yapı doğrulaması
          // Sıradaki görev görür; çalışan koşu kendi workflow kopyasıyla devam eder
          if (disabled) cfg.workflow.agents[key].disabled = true;
          else delete cfg.workflow.agents[key].disabled;
          return { ok: true };
        } catch (e) {
          fs.writeFileSync(resolvedConfigPath, prev); // geçersizse geri al
          return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
      },
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
      await executeRun(task, snapshotConfig(cfg), agents, cwd, bus, runsDir, sessionStore, server);
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
      // Kopya: panelden model/düğüm değişirse çalışan koşunun kalan adımları etkilenmesin
      await executeRun(nextTask, snapshotConfig(cfg), agents, cwd, bus, runsDir, sessionStore, server);
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
