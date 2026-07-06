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

export interface AgentNodeConfig {
  /** Ajanın system prompt'unu içeren md dosyası (config dosyasının dizinine göre) */
  file: string;
  /** Bu ajanın kullanabileceği Claude Code araçları */
  tools: string[];
  /** .rules/<ad>.md dosyaları — içerikleri system prompt'a HER ZAMAN eklenir */
  rules?: string[];
  /** .skill/<ad>/SKILL.md becerileri — ad+açıklama listelenir, ajan ilgili görürse
   *  dosyayı Read ile kendisi okur (frontmatter'da inline: true ise tamamı gömülür) */
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
}

export interface WorkflowConfig {
  /** Akışın başlayacağı ajan adı */
  entry: string;
  /** Reject döngüsünün üst sınırı (sonsuz döngü koruması) */
  maxCycles: number;
  agents: Record<string, AgentNodeConfig>;
}

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
  config: AgentNodeConfig;
}
