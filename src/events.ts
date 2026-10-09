import type { AgentMetrics, ReviewVerdict, StructuredMiss } from "./types.js";

export type OrchestratorEvent =
  | {
      type: "workflow_started";
      task: string;
      provider: string;
      /** Bu koşunun modeli (oturuma özel ya da genel varsayılan; boş = sağlayıcı varsayılanı) */
      model?: string;
      targetDir: string;
      entry: string;
      maxCycles: number;
      agents: string[];
      /** true ise entry ajan önceki oturumu sürdürüyor — panel akışı temizlenmez */
      resumed?: boolean;
      /** Devre dışı düğümler — panel hatta soluk/üstü çizili gösterir */
      disabled?: string[];
      /** Fanout düğümü → çoğalttığı ajan. Kopyalar fanout_started'da belli olur */
      fanouts?: Record<string, string>;
    }
  /** Devre dışı düğüm koşturulmadan geçildi; to = devam edilen düğüm (null = akış bitti) */
  | { type: "node_skipped"; node: string; to: string | null }
  | { type: "agent_started"; agent: string }
  | { type: "agent_text"; agent: string; text: string }
  | {
      /** Sağlayıcı bağlantısı koptu — beklenip yeniden denenecek */
      type: "agent_retrying";
      agent: string;
      attempt: number;
      /** 0 = sınırsız */
      maxAttempts: number;
      error: string;
      delayMs: number;
      /** true ise deneme resume ile yapılacak (ajan baştan başlamaz) */
      resumed: boolean;
    }
  | {
      type: "tool_used";
      agent: string;
      tool: string;
      detail: string;
      /** Dosya araçlarında yol, Bash'te komut — panel kod dostu gösterir (dosya çipi / mini terminal) */
      file?: string;
      command?: string;
      /** Düzenleme araçlarında yaklaşık satır sayısı (eski/yeni metinden) — panelde +N −M */
      added?: number;
      removed?: number;
    }
  | {
      type: "agent_finished";
      agent: string;
      output: string;
      structured?: unknown;
      /** Süre/tur/token ölçümü — panelde ajan satırının altında gösterilir */
      metrics?: AgentMetrics;
    }
  // endsFlow: rota akışı bitiriyor (ör. architect route=done) — onaylanırsa
  // sonraki adım yok, reddedilirse aynı ajan gerekçeyle yeniden koşar
  | {
      type: "approval_required";
      agent: string;
      output: string;
      structured?: unknown;
      endsFlow?: boolean;
      /** structured yoksa neden — kart bunu açıkça yazar */
      miss?: StructuredMiss;
    }
  | {
      type: "approval_resolved";
      agent: string;
      approved: boolean;
      comment?: string;
      source: "terminal" | "web";
    }
  | {
      type: "verdict";
      agent: string;
      approved: boolean;
      issues: ReviewVerdict["issues"];
      summary: string;
    }
  | { type: "cycle"; n: number; max: number; to: string }
  // Repo başına dağıtım: ajanın kopyaları (key = "<ajan>@<repo>") başlar; kopya
  // başına agent_started/agent_finished olayları bu anahtarlarla gelir
  | {
      type: "fanout_started";
      node: string;
      agent: string;
      workers: Array<{ key: string; repo: string }>;
      /** 0 = sınırsız */
      maxConcurrency: number;
      /** Red/build turunda yalnızca geri bildirimde adı geçen repolar yeniden koşar */
      partial: boolean;
    }
  | { type: "fanout_finished"; node: string; repos: string[]; failed: Array<{ repo: string; error: string }> }
  | { type: "build_started"; order: string[] }
  | { type: "build_module_started"; module: string; command: string }
  | { type: "build_output"; module: string; text: string }
  | { type: "build_module_finished"; module: string }
  | { type: "build_failed"; module: string; code: number }
  | { type: "build_finished"; order: string[] }
  | { type: "run_scheduled"; agent: string; runAt: number }
  | { type: "run_resumed"; agent: string; source: "timer" | "terminal" | "web" }
  | { type: "run_schedule_cancelled"; agent: string; source: "timer" | "terminal" | "web" }
  | { type: "workflow_finished" }
  | { type: "workflow_cancelled" }
  | { type: "workflow_failed"; error: string };

export type TimedEvent = OrchestratorEvent & { ts: string };

/**
 * Orkestratörün olay yayını. Terminal çıktısı, web paneli (SSE) ve JSONL koşu
 * kaydı hepsi bu yayının birer dinleyicisidir — iş akışı mantığı hiçbirini bilmez.
 * history, sonradan bağlanan panel istemcilerine geçmişi tekrar oynatmak içindir.
 */
export class EventBus {
  readonly history: TimedEvent[] = [];
  private listeners = new Set<(e: TimedEvent) => void>();

  emit(event: OrchestratorEvent): void {
    const timed: TimedEvent = { ...event, ts: new Date().toISOString() };
    this.history.push(timed);
    for (const listener of this.listeners) listener(timed);
  }

  subscribe(listener: (e: TimedEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Yeni bir koşuya başlarken geçmişi temizler (SSE'ye yeni bağlananlar
   *  yalnızca güncel koşuyu görsün) */
  reset(): void {
    this.history.length = 0;
  }
}
