import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { loadAgents } from "./agents.js";
import { fmtDate, parseRunAt } from "./approval.js";
import { loadAppConfig, modelMissing } from "./config.js";
import { fetchModels } from "./models.js";
import { runWorkflow } from "./orchestrator.js";
import { RuntimeRegistry, type SessionRuntime } from "./runtime.js";
import { startUiServer, type UiServer } from "./server.js";
import { SessionStore, type SessionEntry } from "./sessions.js";
import { isFanoutNode, mainPath, type AgentDefinition, type AppConfig } from "./types.js";

function parseArgs(argv: string[]): {
  task: string;
  configPath: string;
  cwdFlag?: string;
  portFlag?: number;
  noUi: boolean;
  /** --at: görevin başlama zamanı ("+30m", "+2h", "2026-07-10 14:00") */
  atFlag?: string;
} {
  let configPath = "config.json";
  let cwdFlag: string | undefined;
  let portFlag: number | undefined;
  let noUi = false;
  let atFlag: string | undefined;
  const taskParts: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--config") configPath = argv[++i];
    else if (argv[i] === "--cwd") cwdFlag = argv[++i];
    else if (argv[i] === "--port") portFlag = Number(argv[++i]);
    else if (argv[i] === "--no-ui") noUi = true;
    else if (argv[i] === "--at") atFlag = argv[++i];
    else taskParts.push(argv[i]);
  }

  return { task: taskParts.join(" ").trim(), configPath, cwdFlag, portFlag, noUi, atFlag };
}

/**
 * Koşu başına config kopyası: panelden canlı değişen alanlar (model, düğümlerin
 * `disabled`'ı) o an çalışan koşuyu ORTASINDA etkilemesin, sıradaki görevde
 * geçerli olsun. Workflow da kopyalanır çünkü `disabled` onun içinde.
 */
function snapshotConfig(cfg: AppConfig): AppConfig {
  return { ...cfg, workflow: structuredClone(cfg.workflow) };
}

/**
 * Bir oturumda tek bir görevi baştan sona koşturur; olaylar oturumun kanalına,
 * kayıt runs/'a gider. Oturumun ilk görevi değilse architect konuşması sürdürülür
 * (resume) ve panel önceki görevleri ekranda tutar. runtime.startRun ilk await'ten
 * ÖNCE çağrılır — oturum anında "meşgul" olur, çift başlatma olamaz.
 */
async function executeRun(o: {
  task: string;
  cfg: AppConfig;
  agents: Map<string, AgentDefinition>;
  cwd: string;
  runtime: SessionRuntime;
  runsDir: string;
  sessions: SessionStore;
  entry: SessionEntry;
  onDone: () => void;
  /** Verilirse akış bu zamana kadar bekler (zamanlanmış görev) */
  startAt?: number;
}): Promise<void> {
  const { task, cfg, agents, cwd, runtime, entry } = o;
  const bus = runtime.bus;
  const abortController = runtime.startRun(task, cwd);
  // Oturumda önceki görevler varsa panel akışı temizlemez, araya ayraç koyar
  const resumed = bus.history.length > 0 || !!entry.sdkSessionId;
  const logName = `${new Date().toISOString().replace(/[:.]/g, "-")}-${entry.id.slice(0, 8)}.jsonl`;
  const runLog = path.join(o.runsDir, logName);
  o.sessions.addRunLog(entry.id, logName, task);
  const unsubscribe = bus.subscribe((e) => fs.appendFileSync(runLog, JSON.stringify(e) + "\n"));
  // entrySessionId: architect'in SDK oturumu — varsa sürdürülür, koşu boyunca güncellenir
  const sessionStore = { entrySessionId: entry.sdkSessionId };

  console.log(`\n🎯 [${entry.name}] Görev: ${task}`);
  try {
    bus.emit({
      type: "workflow_started",
      task,
      provider: cfg.provider,
      model: cfg.model,
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
    await runWorkflow(cfg.workflow, agents, task, cwd, cfg, bus, abortController, runtime.web, sessionStore, o.startAt);
  } catch (err) {
    bus.emit({ type: "workflow_failed", error: err instanceof Error ? err.message : String(err) });
    throw err;
  } finally {
    runtime.endRun();
    unsubscribe();
    o.sessions.finishRun(entry.id, sessionStore.entrySessionId, runtime.status);
    o.onDone();
    console.log(`🗒  [${entry.name}] Koşu kaydı: ${runLog}`);
  }
}

async function main() {
  const { task, configPath, cwdFlag, portFlag, noUi, atFlag } = parseArgs(process.argv.slice(2));
  const startAt = atFlag ? parseRunAt(atFlag) : undefined;
  if (atFlag && startAt === undefined) {
    throw new Error(`--at anlaşılamadı: "${atFlag}" (ör. +30m, +2h, +1d, "2026-07-10 14:00")`);
  }

  const cfg = loadAppConfig(configPath);
  const resolvedConfigPath = path.resolve(configPath);
  const configRoot = path.dirname(resolvedConfigPath);
  // md dosya yolları config dosyasının bulunduğu dizine göre çözülür
  const agents = loadAgents(cfg.workflow, configRoot);

  // Hedef dizin önceliği: --cwd bayrağı > config'deki targetDir > bulunulan dizin.
  // "let": panelden değiştirilebilir (bkz. setTargetDir) — bir sonraki görev yeni
  // değeri kullanır, config.json'a da yazılır (sürekli dosyayı elle açmamak için).
  let cwd = path.resolve(cwdFlag ?? cfg.targetDir ?? process.cwd());
  const dirOk = (d: string) => fs.existsSync(d) && fs.statSync(d).isDirectory();
  if (!dirOk(cwd)) {
    // Tek görev modunda çalışacak yer yok — dur. Sunucu modunda ise servis açılsın:
    // panel uyarı gösterir, kullanıcı dizini üst çubuktan değiştirene kadar görev başlamaz
    if (task || noUi) throw new Error(`Hedef proje dizini bulunamadı: ${cwd}`);
    console.warn(
      `⚠ Hedef proje dizini bulunamadı: ${cwd}\n` +
        "  Panel yine de açılıyor — üst çubuktaki dizine tıklayıp geçerli bir dizin seç (o zamana kadar görev başlatılamaz).",
    );
  }

  if (modelMissing(cfg)) {
    // Dizin uyarısıyla aynı desen: tek görev modunda dur, sunucu modunda aç ve uyar
    const msg = 'provider "ollama" için model seçilmedi (örn. "qwen3-coder:30b")';
    if (task || noUi) throw new Error(`config: ${msg}`);
    console.warn(`⚠ ${msg}\n  Panel yine de açılıyor — üst çubuktaki model listesinden seç (o zamana kadar görev başlatılamaz).`);
  }

  if (!task && noUi) {
    console.error(
      'Kullanım: npm start -- "görev" [--config config.json] [--cwd dizin] [--port 4141] [--no-ui] [--at +30m]\n' +
        "Görev verilmezse sunucu modu açılır ve görev panelden beklenir (--no-ui ile birlikte kullanılamaz).",
    );
    process.exit(1);
  }

  const runsDir = path.join(configRoot, "runs");
  fs.mkdirSync(runsDir, { recursive: true });

  // Oturum kataloğu (runs/sessions.json) + oturum başına çalışma zamanları. Sunucu
  // modunda onaylar yalnızca panelden (exclusive): birden çok oturum aynı anda
  // soru sorabilir, terminal cevabının hangi oturuma gittiği belirsiz olurdu.
  const sessions = new SessionStore(runsDir);
  const runtimes = new RuntimeRegistry(runsDir, !task);
  const maxParallel = cfg.maxParallelRuns ?? 3;

  /** Panelin sol çubuğu için oturum listesi + canlı durumlar */
  const sessionList = () =>
    sessions.all().map((e) => {
      const rt = runtimes.peek(e.id);
      return {
        id: e.id,
        name: e.name,
        createdAt: e.createdAt,
        updatedAt: e.updatedAt,
        status: rt?.status ?? e.lastStatus ?? "idle",
        busy: rt?.busy ?? false,
        task: rt?.task ?? e.lastTask,
        cwd: rt?.cwd,
        runs: e.runLogs?.length ?? 0,
        model: e.model,
      };
    });

  /** Bir oturumda görev başlatır (oturum yoksa açar); arka planda koşar */
  const launch = (task: string, entry: SessionEntry | undefined, runAt?: number) => {
    // Yeni oturum o anki genel modelle açılır; sonra panelden yalnızca kendisi için değişebilir
    const e = entry ?? sessions.create(task, cfg.model);
    const runCfg = snapshotConfig(cfg);
    if (e.model) runCfg.model = e.model;
    const runtime = runtimes.get(e.id, e.runLogs);
    const run = executeRun({
      task,
      // Kopya: panelden model/düğüm değişirse çalışan koşunun kalan adımları etkilenmesin
      cfg: runCfg,
      agents,
      cwd,
      runtime,
      runsDir,
      sessions,
      entry: e,
      onDone: () => runtimes.notify(),
      startAt: runAt,
    });
    runtimes.notify();
    return { entry: e, run };
  };

  let server: UiServer | undefined;
  if (!noUi) {
    server = await startUiServer(portFlag ?? cfg.uiPort ?? 4141, {
      runtimes,
      getSessions: sessionList,
      openSession: (id) => {
        const e = sessions.get(id);
        return e ? runtimes.get(e.id, e.runLogs) : undefined;
      },
      // Çalışan oturum silinmez (koşusu yetim kalırdı)
      deleteSession: (id) => {
        if (runtimes.peek(id)?.busy) return false;
        runtimes.delete(id);
        const ok = sessions.remove(id);
        runtimes.notify();
        return ok;
      },
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
        const required = cfg.provider === "ollama"; // panel "model seçilmedi" uyarısı için
        if (!cfg.modelsUrl) {
          return { current, required, models: [], error: 'config\'te "modelsUrl" tanımlı değil' };
        }
        try {
          return { current, required, models: await fetchModels(cfg.modelsUrl, cfg.apiKey) };
        } catch (e) {
          return { current, required, models: [], error: e instanceof Error ? e.message : String(e) };
        }
      },
      setModel: (model, sessionId) => {
        // Oturuma özel: config.json'a dokunmaz, yalnızca o oturumun sıradaki görevi etkilenir
        if (sessionId) {
          if (!sessions.get(sessionId)) return { ok: false, error: "oturum bulunamadı" };
          if (!model && modelMissing(cfg)) {
            return { ok: false, error: "Genel varsayılan model de seçili değil — bir model seç" };
          }
          sessions.setModel(sessionId, model);
          runtimes.notify();
          return { ok: true, model };
        }
        const prev = fs.readFileSync(resolvedConfigPath, "utf8");
        try {
          const parsed = JSON.parse(prev) as Record<string, unknown>;
          parsed.model = model; // "" = sağlayıcı varsayılanı (loadAppConfig tanımsız sayar)
          fs.writeFileSync(resolvedConfigPath, JSON.stringify(parsed, null, 2));
          loadAppConfig(resolvedConfigPath); // yapı doğrulaması (boş model kabul — görev başlarken kontrol edilir)
          // Sıradaki görev bu modeli kullanır; çalışan koşu kendi kopyasıyla devam eder
          if (model) cfg.model = model;
          else delete cfg.model;
          return { ok: true, model };
        } catch (e) {
          fs.writeFileSync(resolvedConfigPath, prev); // geçersizse geri al
          return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
      },
      getWorkflow: () => ({
        entry: cfg.workflow.entry,
        nodes: mainPath(cfg.workflow).map((key) => {
          const n = cfg.workflow.agents[key];
          return {
            key,
            type: n.type ?? "agent",
            disabled: !!n.disabled,
            ...(isFanoutNode(n) ? { agent: n.agent } : {}),
          };
        }),
      }),
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
        : (t, sessionId, runAt) => {
            const existing = sessionId ? sessions.get(sessionId) : undefined;
            if (modelMissing({ ...cfg, model: existing?.model || cfg.model })) {
              return { ok: false, error: "Model seçilmedi — üst çubuktaki model listesinden bir model seç" };
            }
            if (!dirOk(cwd)) {
              return { ok: false, error: `Hedef dizin bulunamadı: ${cwd} — üst çubuktaki dizine tıklayıp geçerli bir dizin seç` };
            }
            const entry = sessionId ? sessions.get(sessionId) : undefined;
            if (sessionId && !entry) return { ok: false, error: "oturum bulunamadı" };
            if (entry && runtimes.get(entry.id, entry.runLogs).busy) {
              return { ok: false, error: "Bu oturumda zaten bir görev çalışıyor — bitmesini bekle ya da yeni oturum aç" };
            }
            const busy = runtimes.busy();
            if (busy.length >= maxParallel) {
              return {
                ok: false,
                error: `Aynı anda en fazla ${maxParallel} görev çalışabilir (config: maxParallelRuns) — biri bitince tekrar dene`,
              };
            }
            // Aynı dizine iki akış aynı anda yazarsa birbirini ezer — engellemiyoruz
            // (salt okunur bilgi soruları zararsız) ama açıkça uyarıyoruz
            const clash = busy.find((r) => r.cwd === cwd);
            const { entry: e, run } = launch(t, entry, runAt);
            run.catch((err) => console.error(`💥 [${e.name}] Koşu hatası:`, err instanceof Error ? err.message : err));
            return {
              ok: true,
              session: e.id,
              ...(clash
                ? { warning: `Aynı hedef dizinde (${cwd}) çalışan başka bir oturum var — dosyaları birbirini ezebilir` }
                : {}),
            };
          },
    });
    console.log(`🖥  İzleme paneli: ${server.url}`);
  }

  console.log(`🔌 Sağlayıcı: ${cfg.provider}${cfg.baseUrl ? ` (${cfg.baseUrl})` : ""}${cfg.model ? ` | model: ${cfg.model}` : ""}`);
  console.log(`📁 Hedef proje dizini: ${cwd}`);
  console.log(`🗺  Akış: ${[...agents.keys()].join(" → ")} (entry: ${cfg.workflow.entry})`);

  if (task) {
    // Tek görev modu: yeni oturumda çalıştır ve çık (terminal onayı da açık)
    try {
      if (startAt) console.log(`⏰ Görev ${fmtDate(startAt)} için zamanlandı`);
      await launch(task, undefined, startAt).run;
    } finally {
      server?.close();
    }
    return;
  }

  // Sunucu modu: görevler panelden gelir, her biri kendi oturumunda bağımsız koşar
  console.log(`⏳ Görev bekleniyor — panelden girebilirsin (aynı anda en fazla ${maxParallel}).`);
}

main().catch((err) => {
  console.error("\n💥 Hata:", err instanceof Error ? err.message : err);
  process.exit(1);
});
