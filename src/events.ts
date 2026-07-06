import type { ReviewVerdict } from "./types.js";

export type OrchestratorEvent =
  | {
      type: "workflow_started";
      task: string;
      provider: string;
      targetDir: string;
      entry: string;
      maxCycles: number;
      agents: string[];
    }
  | { type: "agent_started"; agent: string }
  | { type: "agent_text"; agent: string; text: string }
  | { type: "tool_used"; agent: string; tool: string }
  | { type: "agent_finished"; agent: string; output: string }
  | { type: "approval_required"; agent: string; output: string }
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
  | { type: "workflow_finished" }
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
