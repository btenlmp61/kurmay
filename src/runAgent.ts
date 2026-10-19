import path from "node:path";
import { getSessionMessages, query, type HookCallbackMatcher, type HookEvent, type McpServerConfig, type McpServerStatus } from "@anthropic-ai/claude-agent-sdk";
import { activeMcpServers, buildAgentEnv, disabledMcpServers, isOffMcpTool } from "./config.js";
import { mcpStatus, toLights } from "./mcpStatus.js";
import { refreshModelContext } from "./models.js";
import { compactPercent, contextInfo, FORCE_NEW_PERCENT, tokensOfUsage, type ContextInfo } from "./context.js";
import { buildHooks } from "./hooks.js";
import {
  apiErrorReason,
  backoffDelay,
  classifyError,
  CONTINUE_PROMPT,
  CONTINUE_PROMPT_SHORT,
  retrySettings,
  StallError,
  CLI_STALL_MIN_MS,
  withLiveResilience,
} from "./resilience.js";
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

const lineCount = (v: unknown): number => (typeof v === "string" && v ? v.split("\n").length : 0);

/**
 * Panel için araç çağrısının kod dostu alanları: dosya yolu, Bash komutu ve
 * düzenlemelerde yaklaşık +/− satır (değiştirilen bloğun eski/yeni satır sayısı —
 * gerçek diff değil, ama "ne kadar dokundu" hissi için yeterli).
 */
function toolFacts(tool: string, input: unknown): { file?: string; command?: string; added?: number; removed?: number } {
  if (!input || typeof input !== "object") return {};
  const i = input as Record<string, unknown>;
  const facts: { file?: string; command?: string; added?: number; removed?: number } = {};
  const file = i.file_path ?? i.notebook_path;
  if (typeof file === "string" && file) facts.file = file;
  if (tool === "Bash" && typeof i.command === "string") facts.command = i.command.slice(0, TOOL_DETAIL_MAX);
  if (tool === "Edit") {
    facts.added = lineCount(i.new_string);
    facts.removed = lineCount(i.old_string);
  } else if (tool === "MultiEdit" && Array.isArray(i.edits)) {
    facts.added = 0;
    facts.removed = 0;
    for (const e of i.edits as Array<Record<string, unknown>>) {
      facts.added += lineCount(e?.new_string);
      facts.removed += lineCount(e?.old_string);
    }
  } else if (tool === "Write") {
    facts.added = lineCount(i.content);
  }
  return facts;
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
  /** Eklenti (MCP) durumu bu ajan koşusunda bir kez bildirilir — yeniden denemelerde tekrarlanmaz */
  mcpReported?: boolean;
  /** Son denemede modelden hatasız en az bir mesaj geldi mi (ilerleme → bekleme sıfırlanır) */
  progressed?: boolean;
  /** Son denemede Claude Code'un bildirdiği hata kodu (assistant.error) — sınıflandırma için */
  apiError?: string;
  /** Konuşmanın bilinen son boyutu (token) — bağlam göstergesi ve özetleme kararı */
  contextTokens?: number;
  /** Bu ajan koşusunda bilinen bağlam penceresi — sonraki denemede liste alınamasa da kalsın */
  ctxInfo?: ContextInfo;
}

/** Eklenti bağlantı durumlarının ekrandaki adı */
const MCP_STATUS_NAMES: Record<string, string> = {
  connected: "bağlandı",
  failed: "bağlanamadı",
  "needs-auth": "kimlik doğrulama istiyor",
  pending: "bağlanıyor (yanıt yok)",
  disabled: "kapalı",
};

/**
 * Eklentilerin bağlantı durumunu bildirir. İlk mesajda (init) sunucular çoğunlukla
 * "pending" gelir — araçlar ertelenmiş yüklenir — bu yüzden durum, sonuç netleşene
 * kadar (en fazla ~30 sn) SDK'ye sorulur. Ajanın akışını bekletmez.
 */
async function reportMcpStatus(
  iterator: { mcpServerStatus(): Promise<McpServerStatus[]> },
  agentKey: string,
  bus: EventBus,
  isDone: () => boolean,
): Promise<void> {
  let list: McpServerStatus[] = [];
  for (let i = 0; i < 30 && !isDone(); i++) {
    try {
      list = await iterator.mcpServerStatus();
    } catch {
      return; // sorgu kapandı (ajan bitti/iptal) — bildirecek bir şey yok
    }
    if (!list.some((s) => s.status === "pending")) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (list.length === 0) return;
  const servers = toLights(list);
  mcpStatus.update(servers, "ajan"); // paneldeki durum ışığı
  const sorunlu = servers.some((s) => s.status !== "connected");
  console.log(`  ${sorunlu ? "⚠" : "🔌"} eklentiler — ` + servers.map((s) =>
    `${s.name}: ${MCP_STATUS_NAMES[s.status] ?? s.status}` +
    `${s.tools !== undefined ? ` (${s.tools} araç)` : ""}${s.error ? ` (${s.error})` : ""}`).join(" · "));
  // Araç listesi olaya konmaz (her ajan koşusunda kayda yazılırdı) — panel /mcp-status'tan alır
  bus.emit({ type: "mcp_status", agent: agentKey, servers: servers.map(({ toolList: _, version: __, ...s }) => s) });
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
  /** Sürdürülen konuşmanın (resume) bilinen boyutu, token — eşiği geçmişse ajan
   *  çalışmadan önce konuşma özetlenir */
  contextTokens?: number;
}

/** Ajanın ortam değişkenleri: canlı ayarlar + modelin gerçek bağlam penceresi */
function agentEnv(cfg: ProviderConfig, info: ContextInfo | undefined): Record<string, string> | undefined {
  const live = withLiveResilience(cfg);
  return buildAgentEnv(info ? { ...live, limits: { ...live.limits, contextTokens: info.window } } : live);
}

/**
 * Konuşmayı özetler: aynı oturuma Claude Code'un /compact komutu gönderilir —
 * model tek istekte konuşmanın özetini yazar, oturum özet + son kısımla sürer.
 * Sahte API ile doğrulandı (50.002 → 675 token; sonraki görev aynı oturumdan,
 * kısalmış konuşmayla devam etti). Tek mesajlık konuşmada Claude Code "Not enough
 * messages to compact" deyip bir şey yapmaz.
 */
async function compactSession(
  agent: AgentDefinition,
  sessionId: string,
  cwd: string,
  cfg: ProviderConfig,
  bus: EventBus,
  abortController: AbortController,
  reason: "esik" | "dolu",
  tokens: number | undefined,
): Promise<{ ok: boolean; pre?: number; post?: number; error?: string }> {
  const model = agent.config.model ?? cfg.model;
  const info = contextInfo(model, withLiveResilience(cfg));
  console.log(`  📦 ${agent.name}: konuşma özetleniyor (${reason === "esik" ? "eşik aşıldı" : "bağlam doldu"})…`);
  bus.emit({ type: "context_compacting", agent: agent.key, tokens: tokens ?? 0, limit: info?.limit, reason });
  const env = agentEnv(cfg, info);
  const ac = new AbortController();
  const relay = () => ac.abort();
  abortController.signal.addEventListener("abort", relay, { once: true });
  let pre: number | undefined;
  let post: number | undefined;
  let error: string | undefined;
  let text = "";
  try {
    const q = query({
      prompt: "/compact",
      options: {
        cwd,
        resume: sessionId,
        abortController: ac,
        systemPrompt: { type: "preset", preset: "claude_code", append: agent.systemPrompt },
        allowedTools: [],
        permissionMode: "acceptEdits",
        strictMcpConfig: true,
        ...(env ? { env } : {}),
        ...(model ? { model } : {}),
      },
    });
    for await (const m of q) {
      if (m.type === "system" && m.subtype === "compact_boundary") {
        pre = m.compact_metadata.pre_tokens;
        post = m.compact_metadata.post_tokens;
      } else if (m.type === "result") {
        if (m.subtype !== "success") error = "errors" in m && m.errors?.length ? m.errors.join("; ") : m.subtype;
        else if (m.is_error) error = m.result;
        else text = m.result;
      }
    }
  } catch (e) {
    if (abortController.signal.aborted) throw new RunCancelledError();
    error = e instanceof Error ? e.message : String(e);
  } finally {
    abortController.signal.removeEventListener("abort", relay);
  }
  if (abortController.signal.aborted) throw new RunCancelledError();
  if (!error && pre === undefined) {
    error = /Not enough messages/i.test(text) ? "özetlenecek yeterli mesaj yok" : "özetleme yapılmadı";
  }
  const ok = !error;
  console.log(ok
    ? `  📦 ${agent.name}: konuşma özetlendi (${pre ?? "?"} → ${post ?? "?"} token)`
    : `  ⚠ ${agent.name}: konuşma özetlenemedi (${error})`);
  return { ok, pre, post, error };
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
  const model = agent.config.model ?? cfg.model;
  // Modelin bağlam penceresi (model listesinden ya da Ayarlar'dan) — göstergeye ve Claude Code'a.
  // Yeniden denemede liste o an alınamamışsa önceki denemede bilinen değer kullanılır
  const ctxInfo = contextInfo(model, withLiveResilience(cfg)) ?? session.ctxInfo;
  if (ctxInfo) session.ctxInfo = ctxInfo;
  else void refreshModelContext(cfg.modelsUrl, cfg.apiKey, model); // bilinmiyor: sıradaki deneme için tazele
  // Zaman aşımı / iç deneme sayısı Ayarlar'dan canlı değişebilir — her denemede güncel değer
  const env = agentEnv(cfg, ctxInfo);
  const effort = agent.config.effort ?? cfg.effort;
  let hooks = buildHooks(agent.config.hooks, cwd);
  if (opts.writeScope) {
    // Config hook'larına ek olarak yazma kapsamı kapısı (ikisi de çalışır)
    const scope = writeScopeHook(opts.writeScope, cwd);
    hooks = { ...hooks, PreToolUse: [...(hooks?.PreToolUse ?? []), ...scope.PreToolUse!] };
  }
  const result: AgentRunResult = { text: "" };
  // Aç/Kapat sayfasında kapatılan MCP sunucuları başlatılmaz, araçları da listeden çıkar
  const mcpServers = activeMcpServers(cfg);
  const offMcp = disabledMcpServers(cfg);

  // Eklenti durumu arka planda sorulurken sorgu biterse sormayı bıraksın
  let queryDone = false;

  // Bu denemeye özel durdurucu: kullanıcının Durdur'u buna aktarılır, akış takılma
  // bekçisi de yalnızca bunu keser (koşunun kendi durdurucusu sağlam kalır —
  // takılma iptal sayılmasın, yeniden denensin)
  const attemptAc = new AbortController();
  const relayAbort = () => attemptAc.abort();
  if (abortController.signal.aborted) attemptAc.abort();
  else abortController.signal.addEventListener("abort", relayAbort, { once: true });

  // Akış takılma bekçisi: yalnızca model yanıtı akarken (message_start → message_stop
  // arası) kurulur. İlk baytı bekleme (sunucu kuyruğu) ve araç çalışması kapsam
  // dışı — onları Claude Code'un kendi istek zaman aşımı (apiTimeoutMs) sınırlar.
  // 5 dk ve üstü Claude Code'un kendi bekçisine bırakılır (bkz. CLI_STALL_MIN_MS) —
  // o süreci kapatmadan yanıtı akışsız tamamlıyor, bizimki ancak daha kısa süre için.
  const ownStall = (ms: number) => ms > 0 && ms < CLI_STALL_MIN_MS;
  const watch = ownStall(retrySettings(cfg.retry).stallTimeoutMs);
  let streaming = false;
  let lastActivity = Date.now();
  let stalledMs = 0;
  const watchdog = watch
    ? setInterval(() => {
        const limit = retrySettings(cfg.retry).stallTimeoutMs; // canlı ayar
        if (!streaming || !ownStall(limit) || stalledMs) return;
        if (Date.now() - lastActivity >= limit) {
          stalledMs = limit;
          attemptAc.abort();
        }
      }, 1000)
    : undefined;
  watchdog?.unref?.();

  let iterator;
  try {
    iterator = query({
    prompt,
    options: {
      cwd,
      // Kullanıcı iptali (ve takılma bekçisi): abort edilince SDK alttaki Claude Code sürecini öldürür
      abortController: attemptAc,
      // Yanıt parça parça gelsin — takılma bekçisi akışın sürdüğünü buradan anlar
      ...(watch ? { includePartialMessages: true } : {}),
      // Verilirse önceki oturumu sürdürür (yeni session açmak yerine)
      ...(resume ? { resume } : {}),
      // Claude Code'un varsayılan system prompt'u korunur, md içeriği eklenir —
      // böylece araç kullanımı davranışı bozulmaz.
      systemPrompt: { type: "preset", preset: "claude_code", append: agent.systemPrompt },
      allowedTools: agent.config.tools.filter((t) => !isOffMcpTool(t, offMcp)),
      permissionMode: "acceptEdits",
      ...(useSchema && agent.outputSchema
        ? { outputFormat: { type: "json_schema" as const, schema: agent.outputSchema } }
        : {}),
      ...(mcpServers ? { mcpServers: mcpServers as Record<string, McpServerConfig> } : {}),
      // Yalnızca config'teki eklentiler: makinedeki kullanıcı ayarı (~/.claude.json),
      // hedef projenin .mcp.json'u ve eklenti paketleri yok sayılır. Bu olmadan ajan
      // onlara da bağlanıyordu (sahte eklentilerle doğrulandı) — Aç/Kapat'ta kapatılan
      // bir eklenti de aynı adla başka yerde tanımlıysa yine açılırdı.
      strictMcpConfig: true,
      ...(hooks ? { hooks } : {}),
      ...(env ? { env } : {}),
      ...(model ? { model } : {}),
      // Akıl yürütme derinliği — ajan düğümündeki ayar oturum/genel ayarı ezer.
      // "off": düşünme kapalı (istekte thinking alanı hiç gitmez)
      ...(effort === "off"
        ? { thinking: { type: "disabled" as const } }
        : effort ? { effort } : {}),
    },
  });
  for await (const message of iterator) {
    lastActivity = Date.now();
    if (message.type === "stream_event") {
      const t = (message.event as { type?: string }).type;
      if (t === "message_start") streaming = true;
      else if (t === "message_stop") streaming = false;
      continue;
    }
    if (message.type === "system" && message.subtype === "status") {
      streaming = false; // yeni istek başlıyor — ilk bayt beklemesi bekçinin dışında
    } else if (message.type === "system" && message.subtype === "api_retry") {
      // Claude Code isteği kendi içinde yeniden deniyor (503, zaman aşımı, kopma…)
      streaming = false;
      const reason = apiErrorReason(message.error_status, message.error);
      console.warn(`  ⏳ ${agent.name}: ${reason} — model sunucusu yeniden deneniyor (${message.attempt}/${message.max_retries})`);
      bus.emit({
        type: "api_retry",
        agent: agent.key,
        attempt: message.attempt,
        maxRetries: message.max_retries,
        delayMs: Math.round(message.retry_delay_ms),
        reason,
      });
    } else if (message.type === "system" && message.subtype === "init") {
      // Oturum kimliği daha ilk mesajda gelir — bağlantı ortada kopsa bile
      // elimizde kalsın ki yeniden deneme baştan değil resume ile yapılabilsin
      session.id = message.session_id;
      if (mcpServers && !session.mcpReported) {
        session.mcpReported = true;
        void reportMcpStatus(iterator, agent.key, bus, () => queryDone);
      }
    } else if (message.type === "assistant") {
      // Claude Code'un ürettiği hata mesajı ("API Error: 503 …") ajanın sözü değil —
      // sohbete yazılmaz, hata kodu sınıflandırma için saklanır
      if (message.error) {
        session.apiError = message.error;
        continue;
      }
      session.progressed = true;
      // Konuşmanın boyutu: bu yanıtın girdi+çıktısı (alt ajan mesajları ana konuşmaya girmez)
      const tokens = message.parent_tool_use_id ? undefined : tokensOfUsage(message.message.usage);
      if (tokens && tokens !== session.contextTokens) {
        session.contextTokens = tokens;
        bus.emit({ type: "context_usage", agent: agent.key, tokens, window: ctxInfo?.window, limit: ctxInfo?.limit });
      }
      for (const block of message.message.content) {
        if (block.type === "text" && block.text.trim()) {
          console.log(block.text);
          bus.emit({ type: "agent_text", agent: agent.key, text: block.text });
        } else if (block.type === "tool_use") {
          const detail = toolDetail(block.input);
          console.log(`  🔧 ${block.name}${detail ? `: ${detail}` : ""}`);
          // Detaysız araç çağrıları loglanmaz — panelde gürültü yaratıyordu
          if (detail) {
            bus.emit({ type: "tool_used", agent: agent.key, tool: block.name, detail, ...toolFacts(block.name, block.input) });
          }
        }
      }
    } else if (message.type === "result") {
      if (message.subtype === "success") {
        // Hata sonucu (CLI denemeleri tükendi): metin "API Error: …" — çıktı sayılmaz
        if (message.is_error) throw new Error(message.result || "model sunucusu hata döndürdü");
        result.text = message.result;
        result.sessionId = message.session_id;
        result.contextTokens = session.contextTokens;
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
        const detail = "errors" in message && message.errors?.length ? `: ${message.errors.join("; ")}` : "";
        throw new Error(`${agent.name} hata ile durdu: ${message.subtype}${detail}`);
      }
    }
  }
  } catch (err) {
    // Kullanıcı iptali (abort) → koşuyu temiz durdur; takılma → yeniden denensin
    if (abortController.signal.aborted) throw new RunCancelledError();
    if (stalledMs) throw new StallError(stalledMs);
    throw err;
  } finally {
    queryDone = true;
    if (watchdog) clearInterval(watchdog);
    abortController.signal.removeEventListener("abort", relayAbort);
  }

  // Döngü hatasız bitse bile abort edildiyse iptal say
  if (abortController.signal.aborted) throw new RunCancelledError();
  if (stalledMs) throw new StallError(stalledMs);
  return result;
}

/** Konuşma kaydında bu metnin kullanıcı mesajı olarak kaç kez geçtiği; okunamazsa undefined */
async function countPrompt(sessionId: string, cwd: string, prompt: string): Promise<number | undefined> {
  try {
    let msgs = await getSessionMessages(sessionId, { dir: cwd });
    // Dizin eşleşmezse (yol yazımı farkı) tüm projelerde ara — oturum kimliği tekil
    if (msgs.length === 0) msgs = await getSessionMessages(sessionId);
    if (msgs.length === 0) return 0;
    const want = prompt.trim();
    let n = 0;
    for (const m of msgs) {
      if (m.type !== "user") continue;
      const content = (m.message as { content?: unknown } | undefined)?.content;
      if (typeof content === "string") {
        if (content.trim() === want) n++;
      } else if (Array.isArray(content)) {
        if (content.some((b) => b?.type === "text" && typeof b.text === "string" && b.text.trim() === want)) n++;
      }
    }
    return n;
  } catch {
    return undefined;
  }
}

/** Konuşma kaydı var mı (en az bir mesaj); okunamazsa undefined */
async function sessionExists(sessionId: string, cwd: string): Promise<boolean | undefined> {
  try {
    if ((await getSessionMessages(sessionId, { dir: cwd, limit: 1 })).length > 0) return true;
    return (await getSessionMessages(sessionId, { limit: 1 })).length > 0;
  } catch {
    return undefined;
  }
}

/**
 * executeQuery'yi model sunucusu hatalarına karşı sarar (bkz. src/resilience.ts).
 * Kullanıcı iptali DIŞINDAKİ her hatada artan (rastgele dağıtılmış) beklemeyle
 * yeniden dener; oturum kimliği yakalanmışsa aynı oturum resume ile sürdürülür,
 * ajan baştan başlamaz. Görev konuşma kaydına zaten yazıldıysa (istek gitmeden
 * önce yazılıyor) görev TEKRAR gönderilmez, kısa bir devam mesajı gider.
 *
 * Varsayılan sınırsızdır: "bağlantı gelene kadar bekle, ben durdurana kadar
 * akış durmasın". Kalıcı görünen hatalar (yetki, model yok, istek reddedildi)
 * üst üste sınırlıdır — yanlış model adı sonsuza kadar denenmesin. Her deneme
 * Türkçe sebebiyle olay akışına yazılır, panelde görünür. Ayarlar canlıdır:
 * bekleme sırasında Ayarlar'dan değişen değer bir sonraki denemede geçerli.
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
  // Sürdürülen önceki konuşma (yoksa ajan yeni konuşmayla başlar)
  const base = session.id;
  // Görev bu denemelerden önce konuşmada kaç kez geçiyordu — sonradan artmışsa
  // görev kayda yazılmış demektir. İlk denemeden ÖNCE okunmalı; yalnızca önceki
  // konuşma sürdürülürken gerekir, yeni konuşmada 0'dır.
  const before = base ? await countPrompt(base, cwd, prompt) : 0;
  let attempt = 0; // toplam başarısız deneme
  let permanentRun = 0; // üst üste kalıcı hata
  let step = 0; // bekleme basamağı (ilerleme olunca sıfırlanır)
  let contextFull = 0; // üst üste "bağlam doldu"
  let attemptPrompt = prompt;

  while (true) {
    session.progressed = false;
    session.apiError = undefined;
    try {
      return await executeQuery(agent, attemptPrompt, cwd, cfg, bus, useSchema, abortController, session, opts);
    } catch (err) {
      // Kullanıcının Durdur'u tek çıkış kapısı — onu asla yutma
      if (err instanceof RunCancelledError) throw err;
      const s = retrySettings(cfg.retry); // canlı ayar
      const info = classifyError(err, session.apiError);
      attempt++;
      if (session.progressed) {
        // Ajan bu denemede ilerledi: kesinti yeni — beklemeyi baştan başlat
        step = 0;
        permanentRun = 0;
        contextFull = 0;
      }
      permanentRun = info.kind === "permanent" ? permanentRun + 1 : 0;
      const error = err instanceof Error ? err.message : String(err);
      if (!s.enabled || (s.maxAttempts > 0 && attempt >= s.maxAttempts)) throw err;
      if (info.kind === "permanent" && s.permanentMaxAttempts > 0 && permanentRun >= s.permanentMaxAttempts) {
        throw new Error(`${error} — ${info.reason}: üst üste ${permanentRun} denemede düzelmedi, ayarları kontrol et`);
      }

      // Sıradaki denemenin oturumu ve mesajı
      let note = "";
      let decided = false;
      if (info.kind === "lost_session") {
        // Sürdürülecek konuşma yok: kendi açtığımız konuşma kayda hiç geçmediyse
        // önceki konuşmaya, o da yoksa yeni konuşmaya dön — görev baştan gider
        session.id = session.id !== base ? base : undefined;
        attemptPrompt = prompt;
        note = session.id ? "önceki konuşmadan sürdürülecek" : "yeni konuşmayla başlanacak";
        decided = true;
      } else if (info.kind === "context_full") {
        // Bağlam doldu: aynı konuşmayı tekrar göndermek hep aynı hatayı verir.
        // Önce özetle (kaldığı yerden devam), olmazsa ya da özetten sonra yine
        // dolarsa yeni konuşma. Yeni konuşma da sığmıyorsa yapacak bir şey yok.
        contextFull++;
        // Özet ve yeni konuşma denendi, model arada hiç ilerleyemedi → görev sığmıyor
        if (!session.id || contextFull >= 3) {
          throw new Error(`${error} — ${info.reason}: görev yeni bir konuşmaya da sığmadı (modelin bağlam penceresi küçük)`);
        }
        let compacted = false;
        if (contextFull === 1) {
          const r = await compactSession(agent, session.id, cwd, cfg, bus, abortController, "dolu", session.contextTokens);
          compacted = r.ok;
          if (r.ok) session.contextTokens = r.post;
          bus.emit({
            type: "context_compacted", agent: agent.key, ok: r.ok, pre: r.pre, post: r.post, error: r.error,
            ...(r.ok ? {} : { fallback: "yeni" as const }),
          });
        }
        if (!compacted) {
          session.id = undefined;
          session.contextTokens = undefined;
          attemptPrompt = prompt;
          note = "bağlam doldu — yeni konuşmayla başlanacak";
          decided = true;
        }
      }
      if (!decided && session.id) {
        const now = await countPrompt(session.id, cwd, prompt);
        if (now === undefined || before === undefined) {
          attemptPrompt = prompt; // kayıt okunamadı — eski davranış: görevle sürdür
        } else if (now > before) {
          // Görev kayıtta — tekrar gönderme. Uzun açıklama bir kez yeter: önceki deneme
          // de devam mesajıydı ve model arada hiç yanıt veremediyse kısa olanı gider
          const sent = attemptPrompt === CONTINUE_PROMPT || attemptPrompt === CONTINUE_PROMPT_SHORT;
          attemptPrompt = sent && !session.progressed ? CONTINUE_PROMPT_SHORT : CONTINUE_PROMPT;
        } else if (session.id !== base && (await sessionExists(session.id, cwd)) === false) {
          session.id = base; // yeni konuşma kayda geçmemiş — baştan
          attemptPrompt = prompt;
        } else {
          attemptPrompt = prompt;
        }
      }

      const delay = backoffDelay(step, s);
      step++;
      const continued = attemptPrompt === CONTINUE_PROMPT || attemptPrompt === CONTINUE_PROMPT_SHORT;
      const nasil = note || (!session.id ? "oturum baştan" : continued ? "kaldığı yerden devam" : "oturum sürdürülecek");
      const sn = delay < 10_000 ? (delay / 1000).toFixed(1) : String(Math.round(delay / 1000));
      console.warn(
        `\n🔌 ${agent.name}: ${info.reason} — ${sn}sn sonra ${attempt}. yeniden deneme (${nasil}) [${error.slice(0, 200)}]`,
      );
      bus.emit({
        type: "agent_retrying",
        agent: agent.key,
        attempt,
        maxAttempts: s.maxAttempts,
        error,
        reason: info.reason,
        kind: info.kind,
        delayMs: delay,
        resumed: !!session.id,
        continued,
      });

      await abortableSleep(delay, abortController.signal);
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
    // Bağlam penceresi model listesinden — yalnızca henüz bilinmiyorsa çekilir, bir kez yeter
    await refreshModelContext(cfg.modelsUrl, cfg.apiKey, agent.config.model ?? cfg.model);
    if (resume && opts.contextTokens) {
      ({ resume, opts } = await compactIfNeeded(agent, cwd, cfg, bus, abortController, resume, opts));
    }
    return await runAgentInner(agent, prompt, cwd, cfg, bus, abortController, resume, opts, () => retries);
  } finally {
    unsubscribe();
  }
}

/**
 * Sürdürülecek konuşma eşiği geçmişse (Ayarlar: otomatik özetleme eşiği) ajan
 * çalışmadan ÖNCE özetlenir — duvara çarpıp hata almadan. Özetlenemezse ve
 * konuşma neredeyse doluysa (FORCE_NEW_PERCENT) yeni konuşmayla başlanır.
 */
async function compactIfNeeded(
  agent: AgentDefinition,
  cwd: string,
  cfg: ProviderConfig,
  bus: EventBus,
  abortController: AbortController,
  resume: string,
  opts: RunAgentOptions,
): Promise<{ resume: string | undefined; opts: RunAgentOptions }> {
  const live = withLiveResilience(cfg);
  const info = contextInfo(agent.config.model ?? cfg.model, live);
  const tokens = opts.contextTokens!;
  // Panel, sürdürülen konuşmanın doluluğunu ajan daha yanıt vermeden görsün
  bus.emit({ type: "context_usage", agent: agent.key, tokens, window: info?.window, limit: info?.limit });
  const esik = compactPercent(live);
  if (!info || esik <= 0) return { resume, opts };
  const pct = (tokens / info.limit) * 100;
  if (pct < esik) return { resume, opts };

  const r = await compactSession(agent, resume, cwd, cfg, bus, abortController, "esik", tokens);
  if (r.ok) {
    bus.emit({ type: "context_compacted", agent: agent.key, ok: true, pre: r.pre, post: r.post });
    if (r.post) bus.emit({ type: "context_usage", agent: agent.key, tokens: r.post, window: info.window, limit: info.limit });
    return { resume, opts: { ...opts, contextTokens: r.post } };
  }
  const yeni = pct >= FORCE_NEW_PERCENT;
  bus.emit({ type: "context_compacted", agent: agent.key, ok: false, error: r.error, fallback: yeni ? "yeni" : "devam" });
  return yeni ? { resume: undefined, opts: { ...opts, contextTokens: undefined } } : { resume, opts };
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
  const session: SessionHolder = { id: resume, contextTokens: opts.contextTokens };
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
