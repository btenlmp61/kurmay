import { query } from "@anthropic-ai/claude-agent-sdk";
import { buildAgentEnv } from "./config.js";
import type { EventBus } from "./events.js";
import type { AgentDefinition, ProviderConfig } from "./types.js";

/**
 * Bir ajanı Claude Agent SDK ile çalıştırır. Ajan, md dosyasındaki personayı
 * system prompt eki olarak alır ve yalnızca workflow.json'da izin verilen
 * araçları kullanabilir. config.json'da baseUrl tanımlıysa (örn. Ollama)
 * istekler o adrese yönlendirilir. Dönen değer ajanın nihai metin çıktısıdır.
 */
export async function runAgent(
  agent: AgentDefinition,
  prompt: string,
  cwd: string,
  cfg: ProviderConfig,
  bus: EventBus,
): Promise<string> {
  console.log(`\n━━━ ▶ ${agent.name} çalışıyor ━━━`);
  bus.emit({ type: "agent_started", agent: agent.key });

  const env = buildAgentEnv(cfg);
  const model = agent.config.model ?? cfg.model;
  let result = "";

  for await (const message of query({
    prompt,
    options: {
      cwd,
      // Claude Code'un varsayılan system prompt'u korunur, md içeriği eklenir —
      // böylece araç kullanımı davranışı bozulmaz.
      systemPrompt: { type: "preset", preset: "claude_code", append: agent.systemPrompt },
      allowedTools: agent.config.tools,
      permissionMode: "acceptEdits",
      ...(env ? { env } : {}),
      ...(model ? { model } : {}),
    },
  })) {
    if (message.type === "assistant") {
      for (const block of message.message.content) {
        if (block.type === "text" && block.text.trim()) {
          console.log(block.text);
          bus.emit({ type: "agent_text", agent: agent.key, text: block.text });
        } else if (block.type === "tool_use") {
          console.log(`  🔧 ${block.name}`);
          bus.emit({ type: "tool_used", agent: agent.key, tool: block.name });
        }
      }
    } else if (message.type === "result") {
      if (message.subtype === "success") {
        result = message.result;
      } else {
        throw new Error(`${agent.name} hata ile durdu: ${message.subtype}`);
      }
    }
  }

  bus.emit({ type: "agent_finished", agent: agent.key, output: result });
  return result;
}
