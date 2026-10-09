import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { SessionStatus } from "./runtime.js";

export interface SessionEntry {
  /** Oturum kimliği (bizim; SDK oturumundan bağımsız — ilk görevden önce de var olur) */
  id: string;
  /** Oturumu açan ilk görevden türetilen isim */
  name: string;
  createdAt: string;
  updatedAt: string;
  /** Entry ajanın (architect) SDK oturum kimliği — sonraki görev bunu resume eder */
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
}

/** Görev metninden kısa bir oturum ismi türetir */
function nameFromTask(task: string): string {
  const t = task.trim().replace(/\s+/g, " ");
  return t.length > 60 ? t.slice(0, 60) + "…" : t || "(isimsiz)";
}

/**
 * İsimli oturumların kalıcı kataloğu (runs/sessions.json). Bir oturum, aynı
 * architect konuşmasını sürdüren görevler dizisidir; konuşmanın kendisi SDK
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
  create(task: string, model?: string): SessionEntry {
    const now = new Date().toISOString();
    const entry: SessionEntry = { id: randomUUID(), name: nameFromTask(task), createdAt: now, updatedAt: now, runLogs: [] };
    if (model) entry.model = model;
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

  /** Bir koşu bittiğinde: architect'in SDK oturumunu sakla (sonraki görev resume eder) */
  finishRun(id: string, sdkSessionId: string | undefined, status: SessionStatus): void {
    const s = this.get(id);
    if (!s) return;
    if (sdkSessionId) s.sdkSessionId = sdkSessionId;
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
