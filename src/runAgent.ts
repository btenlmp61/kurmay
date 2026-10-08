import path from "node:path";
import { query, type HookCallbackMatcher, type HookEvent, type McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { buildAgentEnv } from "./config.js";
import { buildHooks } from "./hooks.js";
import type { EventBus } from "./events.js";
import {
  RunCancelledError,
  type AgentDefinition,
  type AgentMetrics,
  type AgentRunResult,
  type ProviderConfig,
} from "./types.js";

/** Araç detayının log'a girmeden önce kesildiği sınır (kesilirse sonuna "…" gelir) */
const TOOL_DETAIL_MAX = 300;

/** Araç çağrısından insan-okur bir detay çıkarır (log için). Boş dönerse loglanmaz. */
function toolDetail(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const i = input as Record<string, unknown>;
  // Sıra bilgilendiricilikten geneli: Grep'te `pattern`, `path`'ten daha anlamlı
  // (yoksa desen yerine sadece aranan dizin loglanıyordu)
  for (const key of ["description", "file_path", "pattern", "path", "command", "url", "query"]) {
    const value = i[key];
    if (typeof value === "string" && value.trim()) {
      const detail = value.trim().replace(/\s+/g, " ");
      return detail.length > TOOL_DETAIL_MAX ? detail.slice(0, TOOL_DETAIL_MAX) + "…" : detail;
    }
  }
  return "";
}

/** Şema denemeleri tükendiğinde dönen işaret — akışı öldürmez, şemasız tekrara düşülür */
const SCHEMA_FAILED = Symbol("schema_failed");

/**
 * Denemeler arası taşınan oturum kimliği. SDK oturum kimliğini daha ilk
 * (system/init) mesajında verdiği için, bağlantı koşunun ortasında kopsa bile
 * elimizde kalır ve yeniden deneme resume ile yapılabilir.
 */
interface SessionHolder {
  id?: string;
}

/**
 * Onarım turu prompt'u. Claude Code (CLI 2.1.x), model StructuredOutput aracını
 * çağırmadan düz metinle bitirirse onu YALNIZCA BİR KEZ dürtüyor; model ikinci
 * kez de metin yazarsa tur `success` ile ama structured_output OLMADAN kapanıyor
 * (MAX_STRUCTURED_OUTPUT_RETRIES bu hali kapsamıyor — o, aracın geçersiz girdiyle
 * çağrılması içindir). Sahte API ile yeniden üretildi (2026-10-07). Yerel
 * modellerde, özellikle bağlantı kopup oturum resume edildikten sonra görülüyor.
 * Bağlam oturumda zaten var; modelden yalnızca sonucu şemayla vermesi istenir.
 */
const REPAIR_PROMPT =
  "Yapılandırılmış çıktın alınamadı (StructuredOutput aracı çağrılmadı). " +
  "İşi baştan yapma, yeni araç çağırma: şimdiye kadarki çalışmana dayanarak " +
  "sonucunu ŞİMDİ StructuredOutput aracıyla, şemaya uygun olarak ver.";

/** İki koşunun ölçümünü toplar — onarım turunun maliyeti de ajana yazılsın */
function mergeMetrics(a: AgentMetrics | undefined, b: AgentMetrics | undefined): AgentMetrics | undefined {
  if (!a || !b) return a ?? b;
  const perModel = new Map<string, { model: string; inputTokens: number; outputTokens: number }>();
  for (const p of [...a.perModel, ...b.perModel]) {
    const cur = perModel.get(p.model) ?? { model: p.model, inputTokens: 0, outputTokens: 0 };
    cur.inputTokens += p.inputTokens;
    cur.outputTokens += p.outputTokens;
    perModel.set(p.model, cur);
  }
  return {
    durationMs: a.durationMs + b.durationMs,
    apiDurationMs: a.apiDurationMs + b.apiDurationMs,
    turns: a.turns + b.turns,
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    costUsd: a.costUsd + b.costUsd,
    perModel: [...perModel.values()],
  };
}

/** runAgent'ın isteğe bağlı ayarları */
export interface RunAgentOptions {
  /** Verilirse Write/Edit/MultiEdit/NotebookEdit bu dizin DIŞINA engellenir
   *  (fanout kopyası kendi reposunda kalsın — kardeş kopyalar aynı anda çalışıyor) */
  writeScope?: string;
}

/**
 * Dosya yazan araçları bir dizinle sınırlayan PreToolUse hook'u. Yol cwd'ye göre
 * çözülür; kapsam dışıysa araç engellenir ve gerekçe modele döner.
 */
function writeScopeHook(scope: string, cwd: string): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  const root = path.resolve(scope);
  return {
    PreToolUse: [
      {
        matcher: "Write|Edit|MultiEdit|NotebookEdit",
        hooks: [
          async (input) => {
            const ti = ((input as { tool_input?: Record<string, unknown> }).tool_input ?? {});
            const target = ti.file_path ?? ti.notebook_path;
            if (typeof target !== "string") return { continue: true };
            const rel = path.relative(root, path.resolve(cwd, target));
            if (!rel.startsWith("..") && !path.isAbsolute(rel)) return { continue: true };
            return {
              decision: "block",
              reason:
                `Bu kopyanın yazma kapsamı yalnızca "${root}". "${target}" kapsam dışı — ` +
                `o repo başka bir geliştiriciye atandı, dokunma. Gerekiyorsa deviations'a yaz.`,
            };
          },
        ],
      },
    ],
  };
}

/** Beklerken iptal edilebilen uyku: süre dolarsa döner, Durdur'a basılırsa RunCancelledError atar */
function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new RunCancelledError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new RunCancelledError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function executeQuery(
  agent: AgentDefinition,
  prompt: string,
  cwd: string,
  cfg: ProviderConfig,
  bus: EventBus,
  useSchema: boolean,
  abortController: AbortController,
  session: SessionHolder,
  opts: RunAgentOptions,
): Promise<AgentRunResult | typeof SCHEMA_FAILED> {
  const resume = session.id;
  const env = buildAgentEnv(cfg);
  const model = agent.config.model ?? cfg.model;
  let hooks = buildHooks(agent.config.hooks, cwd);
  if (opts.writeScope) {
    // Config hook'larına ek olarak yazma kapsamı kapısı (ikisi de çalışır)
    const scope = writeScopeHook(opts.writeScope, cwd);
    hooks = { ...hooks, PreToolUse: [...(hooks?.PreToolUse ?? []), ...scope.PreToolUse!] };
  }
  const result: AgentRunResult = { text: "" };

  let iterator;
  try {
    iterator = query({
    prompt,
    options: {
      cwd,
      // Kullanıcı iptali: abort edilince SDK alttaki Claude Code sürecini öldürür
      abortController,
      // Verilirse önceki oturumu sürdürür (yeni session açmak yerine)
      ...(resume ? { resume } : {}),
      // Claude Code'un varsayılan system prompt'u korunur, md içeriği eklenir —
      // böylece araç kullanımı davranışı bozulmaz.
      systemPrompt: { type: "preset", preset: "claude_code", append: agent.systemPrompt },
      allowedTools: agent.config.tools,
      permissionMode: "acceptEdits",
      ...(useSchema && agent.outputSchema
        ? { outputFormat: { type: "json_schema" as const, schema: agent.outputSchema } }
        : {}),
      ...(cfg.mcpServers && Object.keys(cfg.mcpServers).length > 0
        ? { mcpServers: cfg.mcpServers as Record<string, McpServerConfig> }
        : {}),
      ...(hooks ? { hooks } : {}),
      ...(env ? { env } : {}),
      ...(model ? { model } : {}),
      // Akıl yürütme derinliği — dar/ucuz işler "low", yüksek bedelli
      // incelemeler "high"/"xhigh" ile koşsun diye ajan başına ayarlanır
      ...(agent.config.effort ? { effort: agent.config.effort } : {}),
    },
  });
  for await (const message of iterator) {
    // Oturum kimliği daha ilk mesajda gelir — bağlantı ortada kopsa bile
    // elimizde kalsın ki yeniden deneme baştan değil resume ile yapılabilsin
    if (message.type === "system" && message.subtype === "init") {
      session.id = message.session_id;
    } else if (message.type === "assistant") {
      for (const block of message.message.content) {
        if (block.type === "text" && block.text.trim()) {
          console.log(block.text);
          bus.emit({ type: "agent_text", agent: agent.key, text: block.text });
        } else if (block.type === "tool_use") {
          const detail = toolDetail(block.input);
          console.log(`  🔧 ${block.name}${detail ? `: ${detail}` : ""}`);
          // Detaysız araç çağrıları loglanmaz — panelde gürültü yaratıyordu
          if (detail) {
            bus.emit({ type: "tool_used", agent: agent.key, tool: block.name, detail });
          }
        }
      }
    } else if (message.type === "result") {
      if (message.subtype === "success") {
        result.text = message.result;
        result.sessionId = message.session_id;
        session.id = message.session_id;
        // SDK bu alanı her zaman gönderir; yine de eski sürümde patlamasın diye korumalı
        const modelUsage: Record<string, { inputTokens: number; outputTokens: number }> =
          message.modelUsage ?? {};
        result.metrics = {
          durationMs: message.duration_ms,
          apiDurationMs: message.duration_api_ms,
          turns: message.num_turns,
          inputTokens: message.usage.input_tokens,
          outputTokens: message.usage.output_tokens,
          cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
          costUsd: message.total_cost_usd,
          perModel: Object.entries(modelUsage).map(([model, u]) => ({
            model,
            inputTokens: u.inputTokens,
            outputTokens: u.outputTokens,
          })),
        };
        if (message.structured_output !== undefined) {
          result.structured = message.structured_output;
        }
      } else if (message.subtype === "error_max_structured_output_retries") {
        return SCHEMA_FAILED;
      } else {
        throw new Error(`${agent.name} hata ile durdu: ${message.subtype}`);
      }
    }
  }
  } catch (err) {
    // Kullanıcı iptali (abort) → koşuyu temiz durdur; diğer hatalar yükselir
    if (abortController.signal.aborted) throw new RunCancelledError();
    throw err;
  }

  // Döngü hatasız bitse bile abort edildiyse iptal say
  if (abortController.signal.aborted) throw new RunCancelledError();
  return result;
}

/**
 * executeQuery'yi sağlayıcı bağlantı kopmalarına karşı sarar. Kullanıcı iptali
 * DIŞINDAKİ her hatada artan gecikmeyle yeniden dener; oturum kimliği
 * yakalanmışsa aynı oturum resume ile sürdürülür, ajan baştan başlamaz.
 *
 * Varsayılan sınırsızdır: "bağlantı gelene kadar bekle, ben durdurana kadar
 * akış durmasın". Bunun bedeli, gerçek bir yapılandırma hatasının (yanlış model
 * adı, auth) da sonsuza kadar denenmesidir — bu yüzden her deneme hata mesajıyla
 * birlikte olay akışına yazılır, panelde görünür.
 */
async function executeWithRetry(
  agent: AgentDefinition,
  prompt: string,
  cwd: string,
  cfg: ProviderConfig,
  bus: EventBus,
  useSchema: boolean,
  abortController: AbortController,
  session: SessionHolder,
  opts: RunAgentOptions,
): Promise<AgentRunResult | typeof SCHEMA_FAILED> {
  const retry = cfg.retry ?? {};
  const enabled = retry.enabled !== false;
  const maxAttempts = retry.maxAttempts ?? 0; // 0 = sınırsız
  const maxDelay = retry.maxDelayMs ?? 60_000;
  let delay = retry.initialDelayMs ?? 5_000;
  let attempt = 0;

  while (true) {
    try {
      return await executeQuery(agent, prompt, cwd, cfg, bus, useSchema, abortController, session, opts);
    } catch (err) {
      // Kullanıcının Durdur'u tek çıkış kapısı — onu asla yutma
      if (err instanceof RunCancelledError) throw err;
      attempt++;
      if (!enabled || (maxAttempts > 0 && attempt >= maxAttempts)) throw err;

      const error = err instanceof Error ? err.message : String(err);
      const note =
        `${agent.name}: sağlayıcı bağlantısı koptu (${error}) — ` +
        `${Math.round(delay / 1000)}sn sonra ${attempt}. yeniden deneme` +
        (session.id ? " (oturum sürdürülecek)" : " (oturum baştan)");
      console.warn(`\n🔌 ${note}`);
      bus.emit({
        type: "agent_retrying",
        agent: agent.key,
        attempt,
        maxAttempts,
        error,
        delayMs: delay,
        resumed: !!session.id,
      });

      await abortableSleep(delay, abortController.signal);
      delay = Math.min(delay * 2, maxDelay);
    }
  }
}

/**
 * Bir ajanı Claude Agent SDK ile çalıştırır. Ajan, md dosyasındaki personayı
 * system prompt eki olarak alır ve yalnızca config'de izin verilen araçları
 * kullanabilir. outputSchema tanımlıysa SDK'nin yerleşik structured output'u
 * devreye girer; model şemaya uyan çıktıyı üretemezse (retry hakkı biterse)
 * akışı düşürmek yerine ajan bir kez ŞEMASIZ yeniden çalıştırılır — orkestratör
 * metin çıktıyla da ilerleyebilir (verdict için ayrıca metinden çıkarma yedeği var).
 */
export async function runAgent(
  agent: AgentDefinition,
  prompt: string,
  cwd: string,
  cfg: ProviderConfig,
  bus: EventBus,
  abortController: AbortController,
  resume?: string,
  opts: RunAgentOptions = {},
): Promise<AgentRunResult> {
  console.log(`\n━━━ ▶ ${agent.name} çalışıyor${resume ? " (oturum sürdürülüyor)" : ""} ━━━`);
  bus.emit({ type: "agent_started", agent: agent.key });
  // Bağlantı kopmalarını say — çıktı gelmezse kart "kaç kez koptu" yazabilsin
  let retries = 0;
  const unsubscribe = bus.subscribe((e) => {
    if (e.type === "agent_retrying" && e.agent === agent.key) retries++;
  });
  try {
    return await runAgentInner(agent, prompt, cwd, cfg, bus, abortController, resume, opts, () => retries);
  } finally {
    unsubscribe();
  }
}

async function runAgentInner(
  agent: AgentDefinition,
  prompt: string,
  cwd: string,
  cfg: ProviderConfig,
  bus: EventBus,
  abortController: AbortController,
  resume: string | undefined,
  opts: RunAgentOptions,
  retries: () => number,
): Promise<AgentRunResult> {
  const session: SessionHolder = { id: resume };
  let result = await executeWithRetry(agent, prompt, cwd, cfg, bus, true, abortController, session, opts);
  // Şemasız yedeğe düşüldüyse structured zaten beklenmez — onarım turu denenmez
  let schemaless = false;
  // Onarım turunun sonucu (structured yine gelmezse kartta sebep olarak yazılır)
  let repairOutcome: "repair_text" | "repair_failed" | undefined;

  if (result === SCHEMA_FAILED) {
    schemaless = true;
    const note = `${agent.name}: şemaya uygun çıktı üretilemedi (error_max_structured_output_retries) — şemasız yeniden deneniyor`;
    console.warn(`\n⚠ ${note}`);
    bus.emit({ type: "agent_text", agent: agent.key, text: `⚠ ${note}` });
    // Şemasız deneme TAZE oturumla yapılır: şema turlarıyla dolmuş oturumu
    // sürdürmek yerine aynı prompt baştan koşar (mevcut davranış korunuyor)
    const fresh: SessionHolder = { id: resume };
    result = await executeWithRetry(agent, prompt, cwd, cfg, bus, false, abortController, fresh, opts);
    if (result === SCHEMA_FAILED) {
      throw new Error(`${agent.name} hata ile durdu: error_max_structured_output_retries (şemasız denemede de)`);
    }
  }

  // Sessiz bozulma: koşu başarılı ama structured yok (bkz. REPAIR_PROMPT). Aynı
  // oturum bir kez daha, şemayla ve kısa bir onarım prompt'uyla sürdürülür.
  if (agent.outputSchema && !schemaless && result.structured === undefined && result.sessionId) {
    const note = `${agent.name}: yapılandırılmış çıktı gelmedi — aynı oturumda şemayla onarım turu isteniyor`;
    console.warn(`\n⚠ ${note}`);
    bus.emit({ type: "agent_text", agent: agent.key, text: `⚠ ${note}` });
    const repairSession: SessionHolder = { id: result.sessionId };
    const repaired = await executeWithRetry(agent, REPAIR_PROMPT, cwd, cfg, bus, true, abortController, repairSession, opts);
    if (repaired !== SCHEMA_FAILED) {
      const metrics = mergeMetrics(result.metrics, repaired.metrics);
      if (repaired.structured !== undefined) {
        result = { ...repaired, metrics };
      } else {
        result = { ...result, metrics }; // onarım da metinle döndü — ilk metin daha bilgili
        repairOutcome = "repair_text";
      }
    } else {
      repairOutcome = "repair_failed";
    }
  }

  if (agent.outputSchema && result.structured === undefined) {
    result = {
      ...result,
      miss: {
        reason: schemaless ? "schemaless" : (repairOutcome ?? "no_session"),
        retries: retries(),
      },
    };
  }

  if (agent.outputSchema && result.structured === undefined) {
    console.warn(`⚠ ${agent.name}: yapılandırılmış çıktı alınamadı, metin kullanılacak`);
  }

  if (result.metrics) {
    const m = result.metrics;
    const sn = (ms: number) => (ms / 1000).toFixed(1);
    console.log(
      `  📊 ${sn(m.durationMs)}sn (API ${sn(m.apiDurationMs)}sn) · ${m.turns} tur · ` +
        `${m.inputTokens} girdi / ${m.outputTokens} çıktı token`,
    );
    // Birden fazla model = arka planda ikinci bir model çalışmış (ör. SMALL_FAST)
    if (m.perModel.length > 1) {
      console.log(`  📊 ${m.perModel.map((p) => `${p.model}: ${p.inputTokens}/${p.outputTokens}`).join(" · ")}`);
    }
  }

  bus.emit({
    type: "agent_finished",
    agent: agent.key,
    output: result.text,
    structured: result.structured,
    metrics: result.metrics,
  });
  return result;
}
