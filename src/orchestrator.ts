import { askUserApproval, waitForScheduledTime, type WebApprovalChannel } from "./approval.js";
import type { EventBus } from "./events.js";
import { extractVerdict } from "./verdict.js";
import { runAgent } from "./runAgent.js";
import {
  ReviewVerdictSchema,
  type AgentDefinition,
  type AgentRunResult,
  type ProviderConfig,
  type ReviewVerdict,
  type WorkflowConfig,
} from "./types.js";

interface AgentOutput {
  name: string;
  result: AgentRunResult;
}

interface RunContext {
  task: string;
  /** Her ajanın en güncel çıktısı — sonraki ajanların prompt'una enjekte edilir */
  outputs: Map<string, AgentOutput>;
  /** Reject döngüsünden veya kullanıcı reddinden gelen düzeltme talebi */
  feedback?: string;
}

/** Onay/aktarım için görünüm: yapılandırılmış çıktı varsa okunur JSON, yoksa metin */
function outputView(result: AgentRunResult): string {
  return result.structured !== undefined
    ? JSON.stringify(result.structured, null, 2)
    : result.text;
}

function buildPrompt(agent: AgentDefinition, ctx: RunContext): string {
  const parts: string[] = [`# Görev\n${ctx.task}`];

  // Ajanlar birbirleriyle yapılandırılmış format üzerinden konuşur:
  // önceki ajanın çıktısı varsa şemalı JSON olarak enjekte edilir
  for (const [key, entry] of ctx.outputs) {
    if (key === agent.key) continue;
    if (entry.result.structured !== undefined) {
      parts.push(
        `# "${entry.name}" ajanının çıktısı (yapılandırılmış JSON)\n` +
          "```json\n" + JSON.stringify(entry.result.structured, null, 2) + "\n```",
      );
    } else {
      parts.push(`# "${entry.name}" ajanının çıktısı\n${entry.result.text}`);
    }
  }

  if (ctx.feedback) {
    parts.push(`# Düzeltilmesi gerekenler (öncelikli)\n${ctx.feedback}`);
  }

  parts.push("Rolünün gerektirdiği işi yap.");
  return parts.join("\n\n");
}

/**
 * Grafı yürüten motor. Kim kimi çağırır, onay nerede beklenir, döngü ne zaman
 * biter — hepsi config'den gelir ve kodda deterministik işler; hiçbir geçiş
 * modelin "hatırlamasına" bırakılmaz. Her adım EventBus'a yayınlanır.
 */
export async function runWorkflow(
  workflow: WorkflowConfig,
  agents: Map<string, AgentDefinition>,
  task: string,
  cwd: string,
  cfg: ProviderConfig,
  bus: EventBus,
  web?: WebApprovalChannel,
): Promise<void> {
  const ctx: RunContext = { task, outputs: new Map() };
  let current: string | null = workflow.entry;
  let rejectCycles = 0;

  while (current !== null) {
    const agent: AgentDefinition = agents.get(current)!;
    const result = await runAgent(agent, buildPrompt(agent, ctx), cwd, cfg, bus);
    ctx.outputs.set(agent.key, { name: agent.name, result });
    ctx.feedback = undefined;

    // 1) Kullanıcı onayı gereken düğüm: terminal veya web'den — hangisi önce cevap verirse.
    //    Reddedilirse yorumla birlikte aynı düğüm tekrarlanır.
    if (agent.config.requiresUserApproval) {
      const approval = await askUserApproval(agent.name, outputView(result), bus, web, result.structured);
      if (!approval.approved) {
        ctx.feedback = approval.comment || "Kullanıcı çıktıyı reddetti, gözden geçir.";
        console.log(`\n↩ ${agent.name} kullanıcı geri bildirimiyle yeniden çalıştırılıyor`);
        continue;
      }

      // Onaylandı ama ileri bir zaman verildiyse, o zamana kadar kodda gerçek
      // bir duraklama. Bekleme sırasında panelden/terminalden erken çalıştırma
      // ya da iptal edilebilir (üç kanal yarışır).
      if (approval.runAt && approval.runAt > Date.now()) {
        bus.emit({ type: "run_scheduled", agent: agent.key, runAt: approval.runAt });
        console.log(`\n⏰ ${agent.name} planı ${new Date(approval.runAt).toLocaleString()} için zamanlandı — bekleniyor…`);
        const { outcome, source } = await waitForScheduledTime(approval.runAt, web);
        if (outcome === "cancelled") {
          bus.emit({ type: "run_schedule_cancelled", agent: agent.key, source });
          console.log(`\n🛑 Zamanlama iptal edildi (${source}) — koşu sonlandırılıyor.`);
          bus.emit({ type: "workflow_finished" });
          return;
        }
        bus.emit({ type: "run_resumed", agent: agent.key, source });
        console.log(`\n▶ ${outcome === "run_now" ? "Erken çalıştırma" : "Zamanı geldi"} (${source}) — devam ediliyor.`);
      }
    }

    // 2) Verdict düğümü: karar doğrudan ajanın yapılandırılmış çıktısından alınır
    //    (outputFormat şemayı SDK'de zorlar); gelmediyse metinden çıkarma yedeği
    if (agent.config.verdict) {
      let verdict: ReviewVerdict;
      const parsed = ReviewVerdictSchema.safeParse(result.structured);
      if (parsed.success) {
        verdict = parsed.data;
      } else {
        console.log("⚠ Yapılandırılmış karar alınamadı, rapor metninden çıkarılıyor…");
        verdict = await extractVerdict(result.text, cfg);
      }

      bus.emit({
        type: "verdict",
        agent: agent.key,
        approved: verdict.approved,
        issues: verdict.issues,
        summary: verdict.summary,
      });
      console.log(`\n📋 ${agent.name} kararı: ${verdict.approved ? "ONAYLANDI ✅" : "REDDEDİLDİ ❌"} — ${verdict.summary}`);

      if (verdict.approved) {
        current = agent.config.verdict.onApprove;
      } else {
        rejectCycles++;
        if (rejectCycles >= workflow.maxCycles) {
          console.log(`\n⚠️ Maksimum döngü sayısına (${workflow.maxCycles}) ulaşıldı — insan müdahalesi gerekiyor.`);
          console.log("Son inceleme sorunları:");
          for (const issue of verdict.issues) {
            console.log(`  - [${issue.severity}] ${issue.file}: ${issue.description}`);
          }
          bus.emit({
            type: "workflow_failed",
            error: `Maksimum döngü sayısına (${workflow.maxCycles}) ulaşıldı; reviewer onayı alınamadı`,
          });
          return;
        }
        ctx.feedback = verdict.issues
          .map((i) => `- [${i.severity}] ${i.file}: ${i.description}`)
          .join("\n");
        console.log(`🔁 Tur ${rejectCycles}/${workflow.maxCycles}: sorunlar "${agent.config.verdict.onReject}" ajanına geri gönderiliyor`);
        bus.emit({ type: "cycle", n: rejectCycles, max: workflow.maxCycles, to: agent.config.verdict.onReject });
        current = agent.config.verdict.onReject;
      }
      continue;
    }

    // 3) Koşulsuz geçiş
    current = agent.config.next ?? null;
  }

  bus.emit({ type: "workflow_finished" });
  console.log("\n🎉 İş akışı tamamlandı.");
}
