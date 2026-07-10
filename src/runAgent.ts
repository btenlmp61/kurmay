import { query, type McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { buildAgentEnv } from "./config.js";
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
): Promise<AgentRunResult | typeof SCHEMA_FAILED> {
  const env = buildAgentEnv(cfg);
  const model = agent.config.model ?? cfg.model;
  const result: AgentRunResult = { text: "" };

  let iterator;
  try {
    iterator = query({
    prompt,
    options: {
      cwd,
      // Kullanıcı iptali: abort edilince SDK alttaki Claude Code sürecini öldürür
      abortController,
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
): Promise<AgentRunResult> {
  console.log(`\n━━━ ▶ ${agent.name} çalışıyor ━━━`);
  bus.emit({ type: "agent_started", agent: agent.key });

  let result = await executeQuery(agent, prompt, cwd, cfg, bus, true, abortController);

  if (result === SCHEMA_FAILED) {
    const note = `${agent.name}: şemaya uygun çıktı üretilemedi (error_max_structured_output_retries) — şemasız yeniden deneniyor`;
    console.warn(`\n⚠ ${note}`);
    bus.emit({ type: "agent_text", agent: agent.key, text: `⚠ ${note}` });
    result = await executeQuery(agent, prompt, cwd, cfg, bus, false, abortController);
    if (result === SCHEMA_FAILED) {
      throw new Error(`${agent.name} hata ile durdu: error_max_structured_output_retries (şemasız denemede de)`);
    }
  }

  if (agent.outputSchema && result.structured === undefined) {
    console.warn(`⚠ ${agent.name}: yapılandırılmış çıktı alınamadı, metin kullanılacak`);
  }

  bus.emit({ type: "agent_finished", agent: agent.key, output: result.text, structured: result.structured });
  return result;
}
