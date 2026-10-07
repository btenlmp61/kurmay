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

/**
 * Ajana bağlı komut-hook'u. SDK'nin hook mekanizmasına bağlanır: belirtilen
 * olayda (PreToolUse/PostToolUse vb.) komut çalıştırılır, hook girdisi stdin'e
 * JSON verilir; komut `exit 2` ile aracı ENGELLER (stderr = gerekçe), `exit 0`
 * ile izin verir (JSON stdout ileri kullanım için doğrudan aktarılır).
 */
export interface HookConfig {
  /** Hook olayı: "PreToolUse" | "PostToolUse" | "UserPromptSubmit" | "Stop" ... */
  event: string;
  /** Araç adı eşleştirici (regex) — PreToolUse/PostToolUse için (ör. "Bash", "Write|Edit") */
  matcher?: string;
  /** Çalıştırılacak kabuk komutu (hook girdisi stdin'e JSON gelir) */
  command: string;
  /** Saniye cinsinden zaman aşımı (varsayılan 60) */
  timeout?: number;
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
  /** Akıl yürütme derinliği (SDK'nin effort seçeneği). Ucuz/dar işler için "low",
   *  güvenlik gibi yüksek bedelli incelemeler için "high"/"xhigh". */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /** Bu ajana bağlı komut-hook'ları (araç kapıları, otomatik lint/format vb.) */
  hooks?: HookConfig[];
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

/**
 * Paralel inceleme düğümü — LLM değil, bir fan-out/fan-in kapısı. "branches"taki
 * ajanlar EŞ ZAMANLI koşar (her biri kendi query'si, kendi bağlamı, kendi modeli),
 * sonra kararları kodda deterministik olarak birleşir: hepsi onayladıysa onApprove,
 * aksi halde onReject (sorunlar dal adıyla etiketli geri bildirim olur).
 *
 * Neden ajanın Agent aracına (SDK subagent) bırakılmadı: orada kaç alt-ajanın ne
 * zaman koşacağına MODEL karar verir; burada graf kodda sabit ve config editöründe
 * görünür/düzenlenebilir kalır.
 *
 * Dallar salt-okunur olmalı — aynı dizinde eş zamanlı koştukları için yazma
 * araçları yükleme zamanında reddedilir (bkz. agents.ts).
 */
export interface ParallelNodeConfig {
  type: "parallel";
  /** Eş zamanlı koşacak ajan düğümlerinin adları (en az 1) */
  branches: string[];
  /** Tüm dallar onayladığında gidilecek düğüm (null = akış biter) */
  onApprove: string | null;
  /** Herhangi bir dal reddettiğinde/inceleyemediğinde gidilecek düğüm */
  onReject: string;
}

export type WorkflowNode = AgentNodeConfig | CommandNodeConfig | ParallelNodeConfig;

export function isCommandNode(node: WorkflowNode): node is CommandNodeConfig {
  return (node as CommandNodeConfig).type === "command";
}

export function isParallelNode(node: WorkflowNode): node is ParallelNodeConfig {
  return (node as ParallelNodeConfig).type === "parallel";
}

/** Paralel düğümde tek bir dalın sonucu — panel ve geri bildirim için. */
export interface BranchOutcome {
  branch: string;
  /** Dal hata verdiyse false; "inceleyemedi" onay SAYILMAZ */
  ok: boolean;
  approved: boolean;
  summary: string;
  issues: ReviewVerdict["issues"];
  /** Dalın tahmini maliyeti (USD) — toplanıp parallel_finished'te yayınlanır */
  costUsd?: number;
  /** ok=false ise hata mesajı */
  error?: string;
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

/**
 * Maliyet ve süre sınırları — hepsi opsiyonel, verilenler Claude Code alt
 * sürecine ortam değişkeni olarak geçer (buildAgentEnv). Özellikle yavaş yerel
 * modeller için: output token token üretildiğinden büyük çıktı doğrudan süreye
 * yazılır. Verilmeyen alan SDK varsayılanında kalır.
 */
export interface LimitsConfig {
  /** Şemaya uymayan çıktı için yeniden deneme sayısı (SDK varsayılanı 5).
   *  Her deneme TÜM structured output'un baştan üretilmesi demek — yavaş
   *  modellerde asıl gecikme sıçraması burada. Denemeler bitse de akış ölmez:
   *  runAgent ajanı bir kez şemasız yeniden çalıştırır. */
  structuredOutputRetries?: number;
  /** Tek API çağrısı zaman aşımı, ms (SDK varsayılanı 600000 = 10 dk).
   *  Yavaş yerel modelde büyük çıktı bunu AŞABİLİR — API error'ın sebebi
   *  buysa değeri düşürmek değil YÜKSELTMEK gerekir. */
  apiTimeoutMs?: number;
  /** Ajan çıktısının üst sınırı (token) */
  maxOutputTokens?: number;
  /** MCP araç sonuçlarının üst sınırı (token) — arama sonuçları context şişirir */
  maxMcpOutputTokens?: number;
  /** Düşünme (thinking) token bütçesi */
  maxThinkingTokens?: number;
}

/**
 * Sağlayıcı bağlantısı koptuğunda yeniden deneme davranışı. On-premise LLM
 * sunucularında bağlantı sık kopabildiği için varsayılan SINIRSIZ denemedir:
 * akış ölmez, bağlantı geri gelene kadar bekler. Tek çıkış kapısı kullanıcının
 * Durdur'u (iptal). Oturum kimliği yakalanmışsa deneme resume ile yapılır —
 * ajan baştan başlamaz, kaldığı yerden devam eder.
 */
export interface RetryConfig {
  /** false verilirse yeniden deneme kapanır ve hata akışı düşürür (varsayılan: açık) */
  enabled?: boolean;
  /** Deneme üst sınırı; 0 = sınırsız (varsayılan 0) */
  maxAttempts?: number;
  /** İlk bekleme süresi, ms (varsayılan 5000). Her denemede ikiye katlanır */
  initialDelayMs?: number;
  /** Bekleme süresinin tavanı, ms (varsayılan 60000) */
  maxDelayMs?: number;
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
  /** Panelde model seçimi için listenin çekileceği adres (GET). "apiKey" başlıkta
   *  gönderilir (Authorization: Bearer + x-api-key). Boşsa panelde seçici kapalı */
  modelsUrl?: string;
  /** Karar çıkarma (verdict) adımında kullanılacak model; yoksa "model" kullanılır */
  verdictModel?: string;
  /** Geliştirmenin yapılacağı hedef proje dizini (CLI --cwd bayrağı bunu ezer) */
  targetDir?: string;
  /** MCP sunucuları. Bir ajanın bu sunucuların araçlarını kullanabilmesi için
   *  tools listesine "mcp__<sunucu>" (tümü) veya "mcp__<sunucu>__<araç>" eklenmeli */
  mcpServers?: Record<string, McpServerJson>;
  /** Maliyet/süre sınırları (opsiyonel) — yavaş yerel modeller için */
  limits?: LimitsConfig;
  /** Bağlantı koptuğunda yeniden deneme (opsiyonel) — verilmezse sınırsız denenir */
  retry?: RetryConfig;
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

/**
 * Bir ajan koşusunun GERÇEK ölçümü (SDK'nin result mesajından; tahmin değil).
 * Yavaş yerel modelde neyin pahalı olduğu ancak buradan görülür.
 *
 * DİKKAT — iki alan yanıltıcı okunabilir:
 * - `turns`: şema retry'ını İZOLE ETMEZ. Araç çağıran normal bir ajan zaten çok
 *   turludur; retry'lar da bu sayıya karışır. Ham sinyal olarak kullan.
 * - `perModel[].inputTokens`: koşu boyunca TOPLAM (turların toplamı), anlık
 *   context doluluğu DEĞİL. contextWindow'a bölüp "%doluluk" çıkarma — çok
 *   turlu koşuda %100'ü rahatça aşar ve yanlış olur.
 */
export interface AgentMetrics {
  /** Toplam süre (ms) */
  durationMs: number;
  /** Yalnızca API'de geçen süre (ms); aradaki fark araç/yerel iş demektir */
  apiDurationMs: number;
  /** Model turu sayısı (yukarıdaki uyarıya bak) */
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  /** Yerel modelde 0 gelir — anlamlı olan Anthropic koşularında */
  costUsd: number;
  /** Model bazında kırılım. Birden fazla model görünüyorsa arka planda ikinci
   *  bir model (ör. ANTHROPIC_SMALL_FAST_MODEL) çalışıyor demektir. */
  perModel: Array<{ model: string; inputTokens: number; outputTokens: number }>;
}

/** Bir ajan koşusunun sonucu: serbest metin + varsa şemaya uyan JSON */
export interface AgentRunResult {
  text: string;
  structured?: unknown;
  /** SDK oturum kimliği — resume (oturumu sürdürme) için saklanır */
  sessionId?: string;
  /** Süre/tur/token ölçümü; SDK vermezse tanımsız kalır */
  metrics?: AgentMetrics;
}
