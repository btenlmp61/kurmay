import { askUserApproval, fmtDate, waitForScheduledTime, type WebApprovalChannel } from "./approval.js";
import { runBuild } from "./build.js";
import type { EventBus } from "./events.js";
import { extractVerdict } from "./verdict.js";
import { runAgent } from "./runAgent.js";
import {
  isCommandNode,
  isParallelNode,
  ReviewVerdictSchema,
  RunCancelledError,
  type AgentDefinition,
  type AgentNodeConfig,
  type AgentRunResult,
  type BranchOutcome,
  type ParallelNodeConfig,
  type ProviderConfig,
  type ReviewVerdict,
  type WorkflowConfig,
  type WorkflowNode,
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
  /** En son structured çıktıdaki değişen dosya yolları — build düğümü kullanır */
  changedFiles: string[];
}

/**
 * Rota çözümü (saf): structured çıktıdaki `field` değerine göre hedef düğümü
 * seçer. Değer string değilse veya cases'te yoksa default'a (o da yoksa akışın
 * sonuna) düşer. value = okunan rota değeri (belirsizse null).
 */
export function resolveRoute(
  routes: NonNullable<AgentNodeConfig["routes"]>,
  structured: unknown,
): { target: string | null; value: string | null } {
  const raw = (structured as Record<string, unknown> | undefined)?.[routes.field];
  const value = typeof raw === "string" ? raw : null;
  const target = value != null && value in routes.cases ? routes.cases[value] : routes.default ?? null;
  return { target, value };
}

/** Bir ajanın structured çıktısından değişen dosya yollarını çıkarır (varsa) */
function changedFilesOf(result: AgentRunResult): string[] | null {
  const s = result.structured as { changes?: unknown } | undefined;
  if (!s || !Array.isArray(s.changes)) return null;
  const files = s.changes
    .map((c) => (c && typeof c === "object" ? (c as { file?: unknown }).file : undefined))
    .filter((f): f is string => typeof f === "string" && f.length > 0);
  return files;
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
 * Paralel inceleme düğümünü koşar: dallar EŞ ZAMANLI çalışır, kararları burada
 * deterministik olarak birleşir.
 *
 * allSettled (all değil) bilinçli: `all` ilk hatada döner ama diğer dallar arkada
 * koşmaya devam ederdi. İptal edilen bir dal akışı komple durdurur; diğer hatalar
 * o dalın "inceleyemedi" sonucu olur ve ASLA onay sayılmaz — sessizce geçilmesi
 * en tehlikeli davranış olurdu.
 */
async function runParallel(
  nodeKey: string,
  node: ParallelNodeConfig,
  agents: Map<string, AgentDefinition>,
  ctx: RunContext,
  cwd: string,
  cfg: ProviderConfig,
  bus: EventBus,
  abortController: AbortController,
): Promise<{ approved: boolean; branches: BranchOutcome[]; costUsd: number }> {
  bus.emit({ type: "parallel_started", node: nodeKey, branches: node.branches });
  console.log(`\n⚡ Paralel inceleme: ${node.branches.join(", ")}`);

  const settled = await Promise.allSettled(
    node.branches.map(async (key): Promise<BranchOutcome> => {
      const agent = agents.get(key)!;
      // Dallar oturum sürdürmez (entry değiller) ve birbirlerini görmezler —
      // buildPrompt her birine developer çıktısını verir, doğrusu da bu
      const result = await runAgent(agent, buildPrompt(agent, ctx), cwd, cfg, bus, abortController);
      const parsed = ReviewVerdictSchema.safeParse(result.structured);
      const verdict: ReviewVerdict = parsed.success
        ? parsed.data
        : await (async () => {
            console.log(`⚠ "${agent.name}" kararı yapılandırılmamış, rapor metninden çıkarılıyor…`);
            return extractVerdict(result.text, cfg, abortController);
          })();

      bus.emit({
        type: "verdict",
        agent: agent.key,
        approved: verdict.approved,
        issues: verdict.issues,
        summary: verdict.summary,
      });
      return {
        branch: agent.key,
        ok: true,
        approved: verdict.approved,
        summary: verdict.summary,
        issues: verdict.issues,
        costUsd: result.metrics?.costUsd,
      };
    }),
  );

  const branches: BranchOutcome[] = settled.map((s, i) => {
    if (s.status === "fulfilled") return s.value;
    // İptali yut ma: akışın tamamı durmalı
    if (s.reason instanceof RunCancelledError) throw s.reason;
    const key = node.branches[i];
    const error = s.reason instanceof Error ? s.reason.message : String(s.reason);
    console.log(`❌ "${key}" dalı inceleyemedi: ${error}`);
    return {
      branch: key,
      ok: false,
      approved: false,
      summary: `İnceleme yapılamadı: ${error}`,
      issues: [],
      error,
    };
  });

  const approved = branches.every((b) => b.ok && b.approved);
  const costUsd = branches.reduce((sum, b) => sum + (b.costUsd ?? 0), 0);
  bus.emit({ type: "parallel_finished", node: nodeKey, approved, branches, costUsd });
  return { approved, branches, costUsd };
}

/** Dalların sorunlarını developer'a gidecek tek bir geri bildirime çevirir. */
function mergeBranchFeedback(branches: BranchOutcome[]): string {
  const lines: string[] = [];
  for (const b of branches) {
    if (!b.ok) {
      lines.push(`- [${b.branch}] İNCELENEMEDİ: ${b.error}`);
      continue;
    }
    if (b.approved) continue;
    if (b.issues.length === 0) {
      lines.push(`- [${b.branch}] ${b.summary}`);
      continue;
    }
    // Dal adı etikette: developer hangi uzmanlığın itiraz ettiğini bilsin
    for (const i of b.issues) lines.push(`- [${b.branch}][${i.severity}] ${i.file}: ${i.description}`);
  }
  return lines.join("\n");
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
  abortController: AbortController,
  web?: WebApprovalChannel,
  // Entry ajanın SDK oturum kimliği burada tutulur: gelen değer varsa o oturum
  // sürdürülür (resume), koşu boyunca en güncel kimlikle güncellenir (bellekte)
  sessionStore: { entrySessionId?: string } = {},
): Promise<void> {
  const ctx: RunContext = { task, outputs: new Map(), changedFiles: [] };
  let current: string | null = workflow.entry;
  let rejectCycles = 0;

  try {
  while (current !== null) {
    // Kullanıcı adımlar arasında iptal ettiyse burada temiz dur
    if (abortController.signal.aborted) throw new RunCancelledError();
    const node: WorkflowNode = workflow.agents[current];

    // Komut düğümü (LLM değil): değişen modülleri deterministik sırada build eder.
    // Başarılıysa onSuccess'e, ilk hata onFailure'a (build log'u geri bildirim olur).
    if (isCommandNode(node)) {
      const result = await runBuild(node, ctx.changedFiles, cwd, bus);
      if (result.ok) {
        ctx.feedback = undefined;
        current = node.onSuccess;
        continue;
      }
      rejectCycles++;
      if (rejectCycles >= workflow.maxCycles) {
        const error = `Build ${workflow.maxCycles} turda düzeltilemedi (son hata: ${result.failedModule})`;
        console.log(`\n⚠️ ${error}`);
        bus.emit({ type: "workflow_failed", error });
        return;
      }
      ctx.feedback =
        `Build başarısız — "${result.failedModule}" modülü derlenmedi. ` +
        `Aşağıdaki build çıktısındaki hataları düzelt:\n\n${result.log ?? ""}`;
      console.log(`\n🔁 Tur ${rejectCycles}/${workflow.maxCycles}: build hatası "${node.onFailure}" ajanına gönderiliyor`);
      bus.emit({ type: "cycle", n: rejectCycles, max: workflow.maxCycles, to: node.onFailure });
      current = node.onFailure;
      continue;
    }

    // Paralel inceleme düğümü (LLM değil, bir kapı): dallar eş zamanlı koşar,
    // kararları birleşir. Reject bütçesi verdict/build ile ORTAK — üç red kaynağı
    // da aynı maxCycles'ı harcar, yoksa döngü koruması delinirdi.
    if (isParallelNode(node)) {
      const { approved, branches, costUsd } = await runParallel(
        current, node, agents, ctx, cwd, cfg, bus, abortController,
      );
      console.log(
        `\n📋 Paralel inceleme: ${approved ? "ONAYLANDI ✅" : "REDDEDİLDİ ❌"}` +
          (costUsd > 0 ? ` — toplam $${costUsd.toFixed(4)}` : ""),
      );
      for (const b of branches) {
        const mark = !b.ok ? "⚠" : b.approved ? "✅" : "❌";
        console.log(`  ${mark} ${b.branch}: ${b.summary}`);
      }
      if (approved) {
        ctx.feedback = undefined;
        current = node.onApprove;
        continue;
      }
      rejectCycles++;
      if (rejectCycles >= workflow.maxCycles) {
        const error = `Maksimum döngü sayısına (${workflow.maxCycles}) ulaşıldı; paralel inceleme onayı alınamadı`;
        console.log(`\n⚠️ ${error}`);
        bus.emit({ type: "workflow_failed", error });
        return;
      }
      ctx.feedback = mergeBranchFeedback(branches);
      console.log(`🔁 Tur ${rejectCycles}/${workflow.maxCycles}: sorunlar "${node.onReject}" ajanına gönderiliyor`);
      bus.emit({ type: "cycle", n: rejectCycles, max: workflow.maxCycles, to: node.onReject });
      current = node.onReject;
      continue;
    }

    const agent: AgentDefinition = agents.get(current)!;
    // Yalnızca entry ajan (architect) oturum sürdürür; diğerleri her koşuda taze
    const isEntry = agent.key === workflow.entry;
    const result = await runAgent(
      agent, buildPrompt(agent, ctx), cwd, cfg, bus, abortController,
      isEntry ? sessionStore.entrySessionId : undefined,
    );
    if (isEntry && result.sessionId) sessionStore.entrySessionId = result.sessionId;
    ctx.outputs.set(agent.key, { name: agent.name, result });
    ctx.feedback = undefined;
    // Structured çıktı değişen dosyalar taşıyorsa build düğümü için sakla
    const changed = changedFilesOf(result);
    if (changed) ctx.changedFiles = changed;

    // Rota (varsa) onaydan ÖNCE çözülür: akışı bitirecekse (hedef null) onay
    // sormanın anlamı yok — onaylanacak/uygulanacak bir sonraki adım yok.
    // routeTarget: undefined = düğümde routes yok; string = sonraki düğüm; null = akış biter
    let routeTarget: string | null | undefined;
    if (agent.config.routes) {
      const { target, value } = resolveRoute(agent.config.routes, result.structured);
      routeTarget = target;
      const note = `${agent.name} rotası: ${value ?? "(belirsiz)"} → ${target ?? "akış biter (developer çağrılmaz)"}`;
      console.log(`\n🧭 ${note}`);
      bus.emit({ type: "agent_text", agent: agent.key, text: `🧭 ${note}` });
    }

    // 1) Kullanıcı onayı gereken düğüm: terminal veya web'den — hangisi önce cevap verirse.
    //    Reddedilirse yorumla birlikte aynı düğüm tekrarlanır.
    //    Rota akışı bitirecekse (routeTarget === null) onay ATLANMAZ: aksi halde
    //    ajan "gerek yok" deyip akışı sessizce bitirir, kullanıcıya söz düşmezdi.
    //    Onay = bitir; red = gerekçeyle aynı ajanı yeniden koştur (ör. "bu bir
    //    değişiklik talebi, planla") — böylece developer'a boş planla gidilmez.
    const endsFlow = routeTarget === null;
    if (agent.config.requiresUserApproval) {
      const approval = await askUserApproval(agent.name, outputView(result), bus, web, result.structured, abortController.signal, endsFlow);
      if (!approval.approved) {
        ctx.feedback = approval.comment || "Kullanıcı çıktıyı reddetti, gözden geçir.";
        console.log(`\n↩ ${agent.name} kullanıcı geri bildirimiyle yeniden çalıştırılıyor`);
        continue;
      }

      // Onaylandı ama ileri bir zaman verildiyse, o zamana kadar kodda gerçek
      // bir duraklama. Bekleme sırasında panelden/terminalden erken çalıştırma
      // ya da iptal edilebilir (üç kanal yarışır). Akış zaten bitiyorsa
      // (endsFlow) bekleyecek bir sonraki adım yok — zamanlama yok sayılır.
      if (!endsFlow && approval.runAt && approval.runAt > Date.now()) {
        bus.emit({ type: "run_scheduled", agent: agent.key, runAt: approval.runAt });
        console.log(`\n⏰ ${agent.name} planı ${fmtDate(approval.runAt)} için zamanlandı — bekleniyor…`);
        const { outcome, source } = await waitForScheduledTime(approval.runAt, web, abortController.signal);
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
        verdict = await extractVerdict(result.text, cfg, abortController);
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

    // 3) Koşullu rota: hedef ajan çalıştıktan hemen sonra çözüldü (yukarıda),
    //    onay ondan sonra yapıldı. Burada sadece o hedefe geçilir.
    if (agent.config.routes) {
      current = routeTarget ?? null;
      continue;
    }

    // 4) Koşulsuz geçiş
    current = agent.config.next ?? null;
  }
  } catch (err) {
    // Kullanıcı iptali: akışı temiz durdur, panel başlangıç durumuna döner
    if (err instanceof RunCancelledError) {
      console.log("\n🛑 Koşu kullanıcı tarafından iptal edildi.");
      bus.emit({ type: "workflow_cancelled" });
      return;
    }
    throw err;
  }

  bus.emit({ type: "workflow_finished" });
  console.log("\n🎉 İş akışı tamamlandı.");
}
