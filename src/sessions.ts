import fs from "node:fs";
import path from "node:path";

export interface SessionEntry {
  /** SDK oturum kimliği (resume için) */
  id: string;
  /** Oturumu açan ilk görevden türetilen isim */
  name: string;
  createdAt: string;
  updatedAt: string;
}

/** Görev metninden kısa bir oturum ismi türetir */
function nameFromTask(task: string): string {
  const t = task.trim().replace(/\s+/g, " ");
  return t.length > 60 ? t.slice(0, 60) + "…" : t || "(isimsiz)";
}

/**
 * İsimli architect oturumlarının kalıcı kataloğu (runs/sessions.json). Konuşmanın
 * kendisi SDK tarafında (~/.claude/projects/) durur; burada yalnızca id + isim
 * metaverisi tutulur, böylece panel geçmiş oturumları listeleyip sürdürebilir.
 */
export class SessionStore {
  private file: string;
  private list: SessionEntry[] = [];

  constructor(runsDir: string) {
    this.file = path.join(runsDir, "sessions.json");
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (Array.isArray(parsed)) this.list = parsed;
    } catch {
      this.list = []; // dosya yok/bozuk — boş katalogla başla
    }
  }

  /** En son güncellenen üstte olacak şekilde listeyi döndürür */
  all(): SessionEntry[] {
    return [...this.list].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /**
   * Bir koşu sonrası architect oturumunu kaydeder. id yeniyse ismiyle eklenir;
   * varsa (resume) yalnızca updatedAt tazelenir, ismi korunur.
   */
  record(id: string, task: string): void {
    const now = new Date().toISOString();
    const existing = this.list.find((s) => s.id === id);
    if (existing) {
      existing.updatedAt = now;
    } else {
      this.list.push({ id, name: nameFromTask(task), createdAt: now, updatedAt: now });
    }
    this.persist();
  }

  /** Katalogdan bir oturumu siler (SDK konuşması korunur); silindiyse true */
  remove(id: string): boolean {
    const i = this.list.findIndex((s) => s.id === id);
    if (i === -1) return false;
    this.list.splice(i, 1);
    this.persist();
    return true;
  }

  private persist(): void {
    fs.writeFileSync(this.file, JSON.stringify(this.list, null, 2));
  }
}
