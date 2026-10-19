import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { SessionStatus } from "./runtime.js";
import type { EffortSetting } from "./types.js";

export interface SessionEntry {
  /** Oturum kimliği (bizim; SDK oturumundan bağımsız — ilk görevden önce de var olur) */
  id: string;
  /** Oturumu açan ilk görevden türetilen isim */
  name: string;
  createdAt: string;
  updatedAt: string;
  /** Entry ajanın (analist) SDK oturum kimliği — sonraki görev bunu resume eder */
  sdkSessionId?: string;
  /** Oturumun koşu kayıtları (runs/ altındaki .jsonl dosya adları, eskiden yeniye) —
   *  servis yeniden başlasa da geçmiş bunlardan yüklenir */
  runLogs?: string[];
  /** Son koşunun görevi ve bitiş durumu — runtime belleğe alınmadan da lobide görünsün */
  lastTask?: string;
  lastStatus?: SessionStatus;
  /** Oturumun modeli — oturum açılırken genel varsayılandan alınır, sonra panelden
   *  yalnızca bu oturum için değiştirilebilir. Yoksa (eski kayıt) genel model geçerli. */
  model?: string;
  /** Oturumun akıl yürütme derinliği — model gibi: açılırken genel varsayılandan alınır,
   *  sonra panelden yalnızca bu oturum için değişir. Yoksa genel ayar geçerli. */
  effort?: EffortSetting;
  /** Oturumun hedef dizini — model gibi: açılırken genel dizinden alınır, sonra panelden
   *  yalnızca bu oturum için değişir. Eski kayıtlarda yoksa ilk koşuda o anki genel dizine sabitlenir. */
  targetDir?: string;
  /** Entry ajanın (Analist) konuşmasının bilinen boyutu, token — panelde doluluk,
   *  eşiği geçmişse sıradaki görevden önce özetlenir */
  contextTokens?: number;
}

/** Görev metninden kısa bir oturum ismi türetir */
function nameFromTask(task: string): string {
  const t = task.trim().replace(/\s+/g, " ");
  return t.length > 60 ? t.slice(0, 60) + "…" : t || "(isimsiz)";
}

/**
 * İsimli oturumların kalıcı kataloğu (runs/sessions.json). Bir oturum, aynı
 * analist konuşmasını sürdüren görevler dizisidir; konuşmanın kendisi SDK
 * tarafında (~/.claude/projects/) durur, burada metaveri + koşu kayıtları tutulur.
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
    // Eski biçim: id doğrudan SDK oturum kimliğiydi — resume bozulmasın
    for (const s of this.list) {
      if (!("sdkSessionId" in s)) s.sdkSessionId = s.id;
      // Servis koşu ortasında kapanmış: çalışıyor görünmesin
      if (s.lastStatus === "running" || s.lastStatus === "approval" || s.lastStatus === "scheduled") {
        s.lastStatus = "cancelled";
      }
    }
  }

  /** En son güncellenen üstte olacak şekilde listeyi döndürür */
  all(): SessionEntry[] {
    return [...this.list].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  get(id: string): SessionEntry | undefined {
    return this.list.find((s) => s.id === id);
  }

  /** İlk görevle yeni bir oturum açar (henüz SDK oturumu yok) */
  create(task: string, model?: string, effort?: EffortSetting, targetDir?: string): SessionEntry {
    const now = new Date().toISOString();
    const entry: SessionEntry = { id: randomUUID(), name: nameFromTask(task), createdAt: now, updatedAt: now, runLogs: [] };
    if (model) entry.model = model;
    if (effort) entry.effort = effort;
    if (targetDir) entry.targetDir = targetDir;
    this.list.push(entry);
    this.persist();
    return entry;
  }

  /** Bir koşu başladığında: kaydı oturuma bağla, updatedAt tazele */
  addRunLog(id: string, logFile: string, task: string): void {
    const s = this.get(id);
    if (!s) return;
    (s.runLogs ??= []).push(logFile);
    s.lastTask = task;
    s.lastStatus = "running";
    s.updatedAt = new Date().toISOString();
    this.persist();
  }

  /** Bir koşu bittiğinde: analistin SDK oturumunu sakla (sonraki görev resume eder) */
  finishRun(id: string, sdkSessionId: string | undefined, status: SessionStatus, contextTokens?: number): void {
    const s = this.get(id);
    if (!s) return;
    if (sdkSessionId) s.sdkSessionId = sdkSessionId;
    if (contextTokens) s.contextTokens = contextTokens;
    s.lastStatus = status;
    s.updatedAt = new Date().toISOString();
    this.persist();
  }

  /** Oturumun modelini değiştirir ("" = genel varsayılana dön); sıradaki görevde geçerli */
  setModel(id: string, model: string): boolean {
    const s = this.get(id);
    if (!s) return false;
    if (model) s.model = model;
    else delete s.model;
    this.persist();
    return true;
  }

  /** Oturumun akıl yürütme derinliğini değiştirir ("" = genel ayara dön); sıradaki görevde geçerli */
  setEffort(id: string, effort: EffortSetting | ""): boolean {
    const s = this.get(id);
    if (!s) return false;
    if (effort) s.effort = effort;
    else delete s.effort;
    this.persist();
    return true;
  }

  /**
   * Oturumun hedef dizinini değiştirir; sıradaki görevde geçerli. Analist'in konuşması
   * Claude Code'da dizine bağlı saklanır — başka dizinde sürdürülemez ("No conversation
   * found", sahte API ile doğrulandı). Bu yüzden dizin gerçekten değişirse SDK oturumu
   * bırakılır, Analist bu oturumda yeni konuşmayla başlar. keepResume: eski kayda ilk
   * kez dizin yazılırken (zaten o dizinde koşmuştu) konuşma korunur.
   */
  setTargetDir(id: string, dir: string, keepResume = false): { ok: boolean; resetResume: boolean } {
    const s = this.get(id);
    if (!s) return { ok: false, resetResume: false };
    const changed = s.targetDir !== dir;
    const resetResume = changed && !keepResume && !!s.sdkSessionId;
    s.targetDir = dir;
    if (resetResume) {
      delete s.sdkSessionId;
      delete s.contextTokens;
    }
    this.persist();
    return { ok: true, resetResume };
  }

  /** Katalogdan bir oturumu siler (SDK konuşması ve koşu kayıtları korunur); silindiyse true */
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
