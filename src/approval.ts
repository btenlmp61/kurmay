import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import type { EventBus } from "./events.js";

export interface ApprovalResult {
  approved: boolean;
  /** Reddedildiyse kullanıcının düzeltme talebi */
  comment?: string;
}

/** Web panelinden onay bekleme kanalı (server.ts sağlar) */
export interface WebApprovalChannel {
  wait(): Promise<ApprovalResult>;
  cancel(): void;
}

async function askTerminal(agentName: string, signal: AbortSignal): Promise<ApprovalResult> {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    const answer = (
      await rl.question(`\n❓ ${agentName} çıktısını onaylıyor musun? (e/h): `, { signal })
    )
      .trim()
      .toLowerCase();

    if (answer === "e" || answer === "evet" || answer === "y" || answer === "yes") {
      return { approved: true };
    }

    const comment = await rl.question("Neyin değişmesini istiyorsun? ", { signal });
    return { approved: false, comment: comment.trim() || undefined };
  } finally {
    rl.close();
  }
}

/**
 * Kullanıcı onayı — kodda gerçek bir duraklama. Terminal (e/h) ve web paneli
 * aynı anda dinlenir; hangisi önce cevap verirse o geçerli olur, diğeri iptal
 * edilir. Reddedilirse alınan yorum aynı ajana geri bildirim olarak döner.
 */
export async function askUserApproval(
  agentName: string,
  output: string,
  bus: EventBus,
  web?: WebApprovalChannel,
): Promise<ApprovalResult> {
  bus.emit({ type: "approval_required", agent: agentName, output });

  // Kaybeden taraf sessizce beklemede kalsın diye hatalar asla-çözülmeyen
  // bir promise'e çevrilir (kapalı stdin, abort vb. yarışı düşürmesin)
  const never = new Promise<never>(() => {});
  const ac = new AbortController();

  const candidates: Promise<{ result: ApprovalResult; source: "terminal" | "web" }>[] = [
    askTerminal(agentName, ac.signal)
      .then((result) => ({ result, source: "terminal" as const }))
      .catch(() => never),
  ];
  if (web) {
    candidates.push(
      web
        .wait()
        .then((result) => ({ result, source: "web" as const }))
        .catch(() => never),
    );
  }

  const winner = await Promise.race(candidates);
  ac.abort();
  web?.cancel();

  if (winner.source === "web") {
    console.log(`\n🌐 Onay web panelinden geldi: ${winner.result.approved ? "onaylandı" : "reddedildi"}`);
  }

  bus.emit({
    type: "approval_resolved",
    agent: agentName,
    approved: winner.result.approved,
    comment: winner.result.comment,
    source: winner.source,
  });

  return winner.result;
}
