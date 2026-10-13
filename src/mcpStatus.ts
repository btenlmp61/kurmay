import { query, type McpServerConfig, type McpServerStatus } from "@anthropic-ai/claude-agent-sdk";
import { activeMcpServers, buildAgentEnv } from "./config.js";
import type { ProviderConfig } from "./types.js";

/** Bir eklentinin bilinen son durumu (paneldeki durum ışığı bunu gösterir) */
export interface McpLight {
  name: string;
  /** connected | failed | needs-auth | pending | disabled | unknown (henüz denenmedi) */
  status: string;
  error?: string;
  /** Bağlanınca sunucunun sunduğu araç sayısı */
  tools?: number;
  /** Son bilginin zamanı (ISO) */
  at?: string;
  /** Bilgi nereden geldi: servisin yoklaması mı, bir ajan koşusu mu */
  source?: "yoklama" | "ajan";
}

/** SDK durum listesini sade biçime çevirir */
export function toLights(list: McpServerStatus[]): Array<Omit<McpLight, "at" | "source">> {
  return list.map((s) => ({
    name: s.name,
    status: s.status,
    ...(s.error ? { error: s.error } : {}),
    ...(s.tools ? { tools: s.tools.length } : {}),
  }));
}

/**
 * Eklentilerin son bilinen durumu — tüm oturumlar için ortak, bellekte. Ajan
 * koşuları (runAgent) ve servis yoklaması (probeMcp) burayı günceller.
 */
class McpStatusStore {
  private last = new Map<string, McpLight>();
  probing: Promise<void> | null = null;
  probeError?: string;

  update(servers: Array<Omit<McpLight, "at" | "source">>, source: "yoklama" | "ajan"): void {
    const at = new Date().toISOString();
    for (const s of servers) this.last.set(s.name, { ...s, at, source });
  }

  /** Config'teki sunucular sırasıyla: kapalıysa "disabled", hiç denenmediyse "unknown" */
  snapshot(cfg: ProviderConfig): McpLight[] {
    return Object.entries(cfg.mcpServers ?? {}).map(([name, server]) => {
      if (server.disabled) return { name, status: "disabled" };
      return this.last.get(name) ?? { name, status: "unknown" };
    });
  }
}

export const mcpStatus = new McpStatusStore();

/**
 * Eklentileri model çağrısı yapmadan yoklar: Claude Code süreci boş bir girdiyle
 * açılır (prompt hiç gelmez → API'ye istek gitmez), sunucular bağlanınca durum
 * sorulur, süreç kapatılır. Sahte API ile doğrulandı: sıfır istek, ~1-2 sn.
 * Aynı anda tek yoklama koşar; ikinci çağrı ilkini bekler.
 */
export function probeMcp(cfg: ProviderConfig, cwd: string): Promise<void> {
  if (mcpStatus.probing) return mcpStatus.probing;
  const servers = activeMcpServers(cfg);
  if (!servers) return Promise.resolve();
  mcpStatus.probing = (async () => {
    const ac = new AbortController();
    async function* bosGirdi(): AsyncGenerator<never> {
      await new Promise((r) => ac.signal.addEventListener("abort", r, { once: true }));
    }
    const env = buildAgentEnv(cfg);
    const q = query({
      prompt: bosGirdi(),
      options: {
        cwd,
        abortController: ac,
        allowedTools: [],
        strictMcpConfig: true,
        mcpServers: servers as Record<string, McpServerConfig>,
        ...(env ? { env } : {}),
      },
    });
    // Mesajlar okunmazsa süreç tıkanabilir — arka planda boşalt
    void (async () => {
      try {
        for await (const _ of q) { /* yoklamada mesaj beklenmez */ }
      } catch { /* kapatınca "aborted" atar */ }
    })();
    try {
      let list: McpServerStatus[] = [];
      for (let i = 0; i < 60; i++) {
        list = await q.mcpServerStatus();
        if (!list.some((s) => s.status === "pending")) break;
        await new Promise((r) => setTimeout(r, 500));
      }
      mcpStatus.update(toLights(list), "yoklama");
      mcpStatus.probeError = undefined;
    } catch (e) {
      mcpStatus.probeError = e instanceof Error ? e.message : String(e);
    } finally {
      ac.abort();
      mcpStatus.probing = null;
    }
  })();
  return mcpStatus.probing;
}
