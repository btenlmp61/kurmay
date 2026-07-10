import { z } from "zod";

// Reviewer kararının şeması — iş akışı yönlendirmesi bu nesneye göre yapılır.
// Structured output sayesinde API bu şemaya uymayan çıktı üretemez.
export const ReviewVerdictSchema = z.object({
  approved: z.boolean(),
  issues: z.array(
    z.object({
      file: z.string(),
      description: z.string(),
      severity: z.enum(["low", "medium", "high"]),
    }),
  ),
  summary: z.string(),
});

export type ReviewVerdict = z.infer<typeof ReviewVerdictSchema>;

/**
 * Karar şemasının Agent SDK outputFormat için JSON Schema hali.
 * DİKKAT: z.toJSONSchema'nın eklediği "$schema" başlığı outputFormat'ı
 * SESSİZCE bozar (success döner ama structured_output boş kalır) — bu yüzden
 * burada çıkarılıyor. Doğrulandı: 2026-07-07 A/B testi.
 */
export function reviewVerdictJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(ReviewVerdictSchema) as Record<string, unknown>;
  delete schema.$schema;
  return schema;
}

/** Kullanıcı koşuyu iptal ettiğinde fırlatılır — akış temiz şekilde durdurulur */
export class RunCancelledError extends Error {
  constructor() {
    super("Koşu kullanıcı tarafından iptal edildi");
    this.name = "RunCancelledError";
  }
}

export interface AgentNodeConfig {
  /** Düğüm türü — ajan düğümü (varsayılan). Komut düğümleri "command" kullanır. */
  type?: "agent";
  /** Ajanın system prompt'unu içeren md dosyası (config dosyasının dizinine göre) */
  file: string;
  /** Bu ajanın kullanabileceği Claude Code araçları */
  tools: string[];
  /** .claude/rules/<ad>.md dosyaları — içerikleri system prompt'a HER ZAMAN eklenir */
  rules?: string[];
  /** .claude/skills/<ad>/SKILL.md becerileri — ad+açıklama listelenir, ajan ilgili
   *  görürse dosyayı Read ile kendisi okur (frontmatter'da inline: true ise tamamı gömülür) */
  skills?: string[];
  /** İsteğe bağlı model override'ı (config'deki genel "model" alanını ezer) */
  model?: string;
  /** true ise bu ajanın çıktısı sonrasında kullanıcı onayı beklenir */
  requiresUserApproval?: boolean;
  /** Koşulsuz geçiş: bir sonraki ajanın adı (null/tanımsız = akış biter) */
  next?: string | null;
  /** Tanımlıysa çıktıdan structured verdict çıkarılır ve karara göre dallanılır */
  verdict?: {
    onApprove: string | null;
    onReject: string;
  };
  /**
   * Structured çıktıdaki bir alanın değerine göre koşullu dallanma (next/verdict
   * yerine). Ajan rotayı structured output'ta ÖNERİR; geçişi orchestrator yapar.
   * Örn. architect'in "route" alanı: "developer" → developer, "done" → akış biter.
   * cases'te olmayan/eksik değer default'a düşer (default yoksa akış biter).
   */
  routes?: {
    field: string;
    cases: Record<string, string | null>;
    default?: string | null;
  };
}

/**
 * Komut düğümü — LLM değil, deterministik bir build adımı. Yıldız topoloji için:
 * developer'ın değiştirdiği dosyalardan hangi repoların dokunulduğu OTOMATİK
 * çıkarılır (dosyanın targetDir altındaki en üst klasörü = repo). "parent"
 * değiştiyse önce o build edilir, sonra değişen servisler ortak "command" ile.
 * Modül listesi tutulmaz. Exit code'a göre dallanır: hepsi başarılıysa onSuccess,
 * ilk hata onFailure'a (build log'u geri bildirim olur).
 */
export interface CommandNodeConfig {
  type: "command";
  /** Değişen servis repolarında çalıştırılacak varsayılan build komutu */
  command: string;
  /** Ortak parent (örn. common-events). Değişmişse diğerlerinden ÖNCE build edilir. */
  parent?: {
    /** targetDir'e göreli klasör adı (repo kökü) */
    path: string;
    /** Parent'a özel komut; verilmezse "command" kullanılır */
    command?: string;
  };
  /** parent değiştiğinde, kodu değişmese bile TÜM servis repolarını da build et */
  rebuildAllOnParentChange?: boolean;
  onSuccess: string | null;
  onFailure: string;
}

export type WorkflowNode = AgentNodeConfig | CommandNodeConfig;

export function isCommandNode(node: WorkflowNode): node is CommandNodeConfig {
  return (node as CommandNodeConfig).type === "command";
}

export interface WorkflowConfig {
  /** Akışın başlayacağı ajan adı */
  entry: string;
  /** Reject döngüsünün üst sınırı (sonsuz döngü koruması) */
  maxCycles: number;
  agents: Record<string, WorkflowNode>;
}

/** MCP sunucu tanımı — Claude Code'un .mcp.json formatıyla birebir aynı.
 *  stdio: { command, args?, env? }  |  uzak: { type: "http"|"sse", url, headers? } */
export type McpServerJson =
  | { type?: "stdio"; command: string; args?: string[]; env?: Record<string, string> }
  | { type: "http" | "sse"; url: string; headers?: Record<string, string> };

/** Sağlayıcı bağlantı bilgileri — hem Anthropic hem Ollama aynı alanları kullanır */
export interface ProviderConfig {
  /** "anthropic": Claude API / Claude Code oturumu. "ollama": yerel Ollama sunucusu */
  provider: "anthropic" | "ollama";
  /** API adresi. Anthropic'te boş bırakılır; Ollama için örn. http://localhost:11434 */
  baseUrl?: string;
  /** API token'ı. Anthropic'te boşsa Claude Code oturumu kullanılır; Ollama doğrulamaz */
  apiKey?: string;
  /** Ajanların varsayılan modeli. Anthropic'te boşsa Claude Code varsayılanı */
  model?: string;
  /** Karar çıkarma (verdict) adımında kullanılacak model; yoksa "model" kullanılır */
  verdictModel?: string;
  /** Geliştirmenin yapılacağı hedef proje dizini (CLI --cwd bayrağı bunu ezer) */
  targetDir?: string;
  /** MCP sunucuları. Bir ajanın bu sunucuların araçlarını kullanabilmesi için
   *  tools listesine "mcp__<sunucu>" (tümü) veya "mcp__<sunucu>__<araç>" eklenmeli */
  mcpServers?: Record<string, McpServerJson>;
}

/** Tek config dosyasının tamamı: bağlantı bilgileri + iş akışı grafı */
export interface AppConfig extends ProviderConfig {
  workflow: WorkflowConfig;
  /** İzleme paneli portu (varsayılan 4141; CLI --port bayrağı bunu ezer) */
  uiPort?: number;
}

export interface AgentDefinition {
  key: string;
  name: string;
  description: string;
  systemPrompt: string;
  /** Ajanın çıktı JSON şeması (md frontmatter "output" alanından; verdict
   *  düğümlerinde yerleşik karar şeması kullanılır). Tanımlıysa ajan Agent
   *  SDK'nin outputFormat'ıyla çalışır ve şemaya uyan JSON üretir. */
  outputSchema?: Record<string, unknown>;
  config: AgentNodeConfig;
}

/** Bir ajan koşusunun sonucu: serbest metin + varsa şemaya uyan JSON */
export interface AgentRunResult {
  text: string;
  structured?: unknown;
}
