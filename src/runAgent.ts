import { query, type McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { buildAgentEnv } from "./config.js";
import { buildHooks } from "./hooks.js";
import type { EventBus } from "./events.js";
import { RunCancelledError, type AgentDefinition, type AgentRunResult, type ProviderConfig } from "./types.js";

/** Araç çağrısından insan-okur bir detay çıkarır (log için). Boş dönerse loglanmaz. */
function toolDetail(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const i = input as Record<string, unknown>;
  for (const key of ["description", "file_path", "path", "pattern", "command", "url", "query"]) {
    const value = i[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim().replace(/\s+/g, " ").slice(0, 120);
    }
  }
  return "";
}

/** Şema denemeleri tükendiğinde dönen işaret — akışı öldürmez, şemasız tekrara düşülür */
const SCHEMA_FAILED = Symbol("schema_failed");

async function executeQuery(
  agent: AgentDefinition,
  prompt: string,
  cwd: string,
  cfg: ProviderConfig,
  bus: EventBus,
  useSchema: boolean,
  abortController: AbortController,
  resume?: string,
): Promise<AgentRunResult | typeof SCHEMA_FAILED> {
  const env = buildAgentEnv(cfg);
  const model = agent.config.model ?? cfg.model;
  const hooks = buildHooks(agent.config.hooks, cwd);
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
    },
  });
  for await (const message of iterator) {
    if (message.type === "assistant") {
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
): Promise<AgentRunResult> {
  console.log(`\n━━━ ▶ ${agent.name} çalışıyor${resume ? " (oturum sürdürülüyor)" : ""} ━━━`);
  bus.emit({ type: "agent_started", agent: agent.key });

  let result = await executeQuery(agent, prompt, cwd, cfg, bus, true, abortController, resume);

  if (result === SCHEMA_FAILED) {
    const note = `${agent.name}: şemaya uygun çıktı üretilemedi (error_max_structured_output_retries) — şemasız yeniden deneniyor`;
    console.warn(`\n⚠ ${note}`);
    bus.emit({ type: "agent_text", agent: agent.key, text: `⚠ ${note}` });
    result = await executeQuery(agent, prompt, cwd, cfg, bus, false, abortController, resume);
    if (result === SCHEMA_FAILED) {
      throw new Error(`${agent.name} hata ile durdu: error_max_structured_output_retries (şemasız denemede de)`);
    }
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
