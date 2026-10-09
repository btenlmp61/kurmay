import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { EventBus } from "./events.js";
import { RunCancelledError, type PrNodeConfig } from "./types.js";

/**
 * Çekme isteği (pull request) düğümü — LLM DEĞİL, deterministik adım: değişen her
 * git deposunda yeni dal açar, YALNIZCA ajanların değiştirdiği dosyaları commit'ler,
 * dalı gönderir ve Azure DevOps / TFS REST API'siyle çekme isteği açar.
 *
 * Neden ajan değil: işin her adımı mekanik (git + tek REST çağrısı) ve her seferinde
 * aynı sonucu vermeli; erişim anahtarı modelin bağlamına girmemeli; açıklama zaten
 * akışın yapılandırılmış çıktılarından (plan özeti, değişiklik listesi, teftiş özeti)
 * kurulabiliyor. Yerel modelde ajan araç çağrısı da en kırılgan nokta.
 *
 * Hiçbir hata akışı düşürmez (iptal hariç): sonuç her depo için olay olarak yayınlanır.
 * Erişim anahtarı yoksa ya da API hata verirse dal yine gönderilir ve tarayıcıda
 * çekme isteği oluşturma bağlantısı verilir.
 */

export interface PrRepoResult {
  /** Hedef dizine göre depo yolu ("." = hedef dizinin kendisi) */
  repo: string;
  /** created: istek açıldı · pushed: dal gönderildi, istek elle açılacak · skipped: değişiklik yok · failed: hata */
  status: "created" | "pushed" | "skipped" | "failed";
  branch?: string;
  target?: string;
  /** created → isteğin adresi; pushed → oluşturma sayfasının adresi */
  url?: string;
  message?: string;
}

/** Çekme isteği açıklamasına giren akış özeti (orchestrator doldurur) */
export interface PrSummary {
  task: string;
  /** Ajan adı → yapılandırılmış çıktı (summary, changes… alanları okunur) */
  outputs: Array<{ name: string; structured?: unknown; text: string }>;
}

const DISPLAY: Record<string, string> = { analist: "Analist", saha: "Saha Timi", teftis: "Teftiş" };

/** git komutu çalıştırır; çıkış kodu 0 değilse stderr'li hata fırlatır.
 *  raw: çıktıyı kırpma (status --porcelain satırı boşlukla başlayabilir: " M dosya") */
function git(cwd: string, args: string[], signal: AbortSignal, timeoutMs = 60_000, raw = false): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      // GIT_TERMINAL_PROMPT=0: kimlik sorulursa takılı kalmasın, hata versin
      { cwd, signal, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, windowsHide: true },
      (err, stdout, stderr) => {
        if (signal.aborted) return reject(new RunCancelledError());
        if (err) {
          const msg = (String(stderr || "").trim() || err.message).split("\n").slice(-3).join(" ").trim();
          return reject(new Error(`git ${args[0]}: ${msg}`));
        }
        resolve(raw ? String(stdout) : String(stdout).trim());
      },
    );
  });
}

/**
 * Uzak depo adresinden Azure DevOps / TFS koordinatları. Desteklenen biçimler:
 *   https://dev.azure.com/{org}/{proje}/_git/{depo}
 *   https://{org}.visualstudio.com/{proje}/_git/{depo}
 *   http(s)://{sunucu}[/tfs]/{koleksiyon}/{proje}/_git/{depo}
 *   http(s)://{sunucu}[/tfs]/{koleksiyon}/_git/{depo}        (proje adı = depo adı)
 *   git@ssh.dev.azure.com:v3/{org}/{proje}/{depo}
 *   ssh://{sunucu}:22[/tfs]/{koleksiyon}/{proje}/_git/{depo}  (web adresi https varsayılır)
 * collectionUrl verilirse koleksiyon adresi ondan alınır (SSH ya da farklı web adresi için).
 */
export function parseAzureRemote(
  remoteUrl: string,
  collectionUrl?: string,
): { collection: string; project: string; repo: string } | null {
  const url = remoteUrl.trim().replace(/\/+$/, "").replace(/\.git$/, "");
  const sshCloud = /^(?:ssh:\/\/)?[^@]+@(?:vs-)?ssh\.(?:dev\.azure\.com|visualstudio\.com):(?:\d+\/)?v3\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(url);
  if (sshCloud) {
    const [, org, project, repo] = sshCloud;
    return { collection: collectionUrl?.replace(/\/+$/, "") ?? `https://dev.azure.com/${org}`, project, repo };
  }
  const m = /^(https?|ssh):\/\/(?:[^@/]+@)?([^/:]+)(:\d+)?((?:\/[^/]+)*?)\/_git\/([^/]+)$/.exec(url);
  if (!m) return null;
  const [, scheme, host, port = "", prefix, repo] = m;
  const segs = prefix.split("/").filter(Boolean);
  // Koleksiyon/organizasyon kısmı: "tfs" sanal dizini sayılmaz
  const meaningful = segs.filter((s, i) => !(i === 0 && s.toLowerCase() === "tfs"));
  const isCloudOrg = host === "dev.azure.com" || host.endsWith(".visualstudio.com");
  // Proje adı yazılmamışsa (…/{koleksiyon}/_git/{depo}) proje = depo adı
  const hasProject = isCloudOrg ? meaningful.length >= (host === "dev.azure.com" ? 2 : 1) : meaningful.length >= 2;
  const project = hasProject ? segs[segs.length - 1] : repo;
  const collSegs = hasProject ? segs.slice(0, -1) : segs;
  const web = scheme === "ssh" ? "https" : scheme;
  // SSH portu web adresine taşınmaz; http(s) portu (ör. TFS'in :8080'i) korunur
  const hostPort = scheme === "ssh" ? host : host + port;
  const collection = collectionUrl?.replace(/\/+$/, "") ?? `${web}://${hostPort}${collSegs.length ? "/" + collSegs.join("/") : ""}`;
  return { collection, project, repo };
}

/** Dal adı için görev metninden kısa, ASCII bir parça */
function slug(text: string): string {
  const tr: Record<string, string> = { ç: "c", ğ: "g", ı: "i", ö: "o", ş: "s", ü: "u", Ç: "c", Ğ: "g", İ: "i", Ö: "o", Ş: "s", Ü: "u" };
  return (
    text
      .replace(/[çğıöşüÇĞİÖŞÜ]/g, (c) => tr[c] ?? c)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)
      .replace(/-+$/, "") || "degisiklik"
  );
}

function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

/** Çekme isteğinin başlığı: görevin ilk satırı (en fazla 120 karakter) */
export function prTitle(task: string): string {
  const line = task.trim().split(/\r?\n/)[0].trim();
  return line.length > 120 ? line.slice(0, 117) + "…" : line || "Kurmay değişikliği";
}

/** Çekme isteğinin açıklaması (Markdown): görev, plan özeti, değişiklikler, teftiş */
export function prDescription(s: PrSummary, repo: string): string {
  const parts = [`## Görev\n${s.task.trim()}`];
  for (const o of s.outputs) {
    const st = (o.structured ?? {}) as Record<string, unknown>;
    const title = DISPLAY[o.name] ?? o.name;
    const lines: string[] = [];
    if (typeof st.summary === "string" && st.summary.trim()) lines.push(st.summary.trim());
    if (typeof st.approved === "boolean") lines.unshift(st.approved ? "✅ Onaylandı" : "❌ Reddedildi");
    const changes = Array.isArray(st.changes) ? (st.changes as Array<Record<string, unknown>>) : [];
    const own = changes.filter((c) => typeof c.file === "string" && (repo === "." || inRepo(String(c.file), repo)));
    if (own.length) {
      lines.push(own.map((c) => `- \`${c.file}\`${typeof c.summary === "string" && c.summary ? ` — ${c.summary}` : ""}`).join("\n"));
    }
    if (lines.length) parts.push(`## ${title}\n${lines.join("\n\n")}`);
  }
  parts.push("_Kurmay tarafından otomatik açıldı._");
  const text = parts.join("\n\n");
  return text.length > 3900 ? text.slice(0, 3890) + "\n…" : text; // Azure DevOps sınırı 4000
}

function inRepo(file: string, repo: string): boolean {
  const f = file.replace(/\\/g, "/").replace(/^\.\//, "");
  const r = repo.replace(/\\/g, "/").replace(/\/+$/, "");
  return f === r || f.startsWith(r + "/");
}

/** Dosyanın içinde bulunduğu git deposunun kökü (dosya silinmişse var olan en yakın üst klasörden) */
async function repoRootOf(file: string, signal: AbortSignal, cache: Map<string, string | null>): Promise<string | null> {
  let dir = path.dirname(file);
  while (!fs.existsSync(dir) && path.dirname(dir) !== dir) dir = path.dirname(dir);
  if (cache.has(dir)) return cache.get(dir)!;
  let root: string | null = null;
  try {
    root = path.resolve(await git(dir, ["rev-parse", "--show-toplevel"], signal));
  } catch (e) {
    if (e instanceof RunCancelledError) throw e;
  }
  cache.set(dir, root);
  return root;
}

/** Değişen dosyaları git depolarına göre gruplar (depo kökü → depo içi göreli yollar) */
export async function groupByRepo(
  changedFiles: string[],
  cwd: string,
  signal: AbortSignal,
): Promise<{ repos: Map<string, string[]>; outside: string[] }> {
  const repos = new Map<string, string[]>();
  const outside: string[] = [];
  const cache = new Map<string, string | null>();
  for (const f of [...new Set(changedFiles)]) {
    const abs = path.resolve(cwd, f);
    const root = await repoRootOf(abs, signal, cache);
    if (!root) {
      outside.push(f);
      continue;
    }
    const rel = path.relative(root, abs).split(path.sep).join("/");
    if (!repos.has(root)) repos.set(root, []);
    repos.get(root)!.push(rel);
  }
  return { repos, outside };
}

/** Hedef dal: config > uzak deponun varsayılan dalı (origin/HEAD) > mevcut dal */
async function resolveTarget(root: string, node: PrNodeConfig, remote: string, current: string, signal: AbortSignal): Promise<string> {
  if (node.targetBranch?.trim()) return node.targetBranch.trim();
  try {
    const head = await git(root, ["symbolic-ref", "--short", `refs/remotes/${remote}/HEAD`], signal);
    if (head.startsWith(remote + "/")) return head.slice(remote.length + 1);
  } catch (e) {
    if (e instanceof RunCancelledError) throw e;
  }
  if (current === "HEAD") throw new Error("hedef dal belirlenemedi (ayrık HEAD) — ayarlarda hedef dalı yaz");
  return current;
}

/** Tek bir depoda: dal → commit → gönder → çekme isteği */
async function openOne(
  root: string,
  files: string[],
  node: PrNodeConfig,
  summary: PrSummary,
  repoLabel: string,
  signal: AbortSignal,
): Promise<PrRepoResult> {
  const remote = node.remote?.trim() || "origin";
  // Yalnızca gerçekten değişmiş olanlar (silinenler dahil) — ajanın listelediği ama
  // dokunmadığı dosya git add'de "eşleşme yok" hatası verirdi
  const status = await git(root, ["status", "--porcelain", "-z", "--untracked-files=all", "--", ...files], signal, 60_000, true);
  const dirty = status
    .split("\0")
    .filter((l) => l.length > 3)
    .map((l) => l.slice(3));
  const paths = files.filter((f) => dirty.some((d) => d === f || d.startsWith(f.replace(/\/?$/, "/"))));
  if (!paths.length) return { repo: repoLabel, status: "skipped", message: "gönderilecek değişiklik yok" };

  const remoteUrl = await git(root, ["remote", "get-url", remote], signal).catch((e) => {
    if (e instanceof RunCancelledError) throw e;
    throw new Error(`"${remote}" adlı uzak depo tanımlı değil`);
  });
  const current = await git(root, ["rev-parse", "--abbrev-ref", "HEAD"], signal);
  const target = await resolveTarget(root, node, remote, current, signal);

  // Yeni dal (aynı ad varsa sonuna sayı); çalışma alanı olduğu gibi taşınır
  const prefix = node.branchPrefix?.trim() || "kurmay/";
  let branch = `${prefix}${stamp()}-${slug(prTitle(summary.task))}`;
  for (let i = 2; ; i++) {
    const exists = await git(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], signal).then(
      () => true,
      (e) => {
        if (e instanceof RunCancelledError) throw e;
        return false;
      },
    );
    if (!exists) break;
    branch = branch.replace(/-\d+$/, "") + `-${i}`;
  }
  await git(root, ["checkout", "-b", branch], signal);

  // Yalnızca ajanların dosyaları: önce sahneye al (yeni/silinen dahil), sonra
  // pathspec'li commit — kullanıcının önceden sahneye aldığı başka dosyalar girmez
  const title = prTitle(summary.task);
  const description = prDescription(summary, repoLabel);
  await git(root, ["add", "-A", "--", ...paths], signal);
  await git(root, ["commit", "-m", title, "-m", description, "--", ...paths], signal);
  await git(root, ["push", "-u", remote, branch], signal, 180_000);

  const az = parseAzureRemote(remoteUrl, node.collectionUrl);
  const enc = encodeURIComponent;
  const createUrl = az
    ? `${az.collection}/${enc(decodeURIComponent(az.project))}/_git/${enc(decodeURIComponent(az.repo))}/pullrequestcreate?sourceRef=${enc(branch)}&targetRef=${enc(target)}`
    : undefined;
  const pushed = (message: string): PrRepoResult => ({ repo: repoLabel, status: "pushed", branch, target, url: createUrl, message });

  if (node.returnToBase && current !== "HEAD") {
    await git(root, ["checkout", current], signal).catch((e) => {
      if (e instanceof RunCancelledError) throw e;
    });
  }

  if (!az) return pushed("uzak depo adresi tanınan biçimde değil (…/_git/…) — çekme isteğini elle aç");
  const tokenEnv = node.tokenEnv?.trim() || "AZURE_DEVOPS_PAT";
  const token = process.env[tokenEnv];
  if (!token) return pushed(`erişim anahtarı yok (${tokenEnv} ortam değişkeni) — isteği bağlantıdan aç`);

  const api = `${az.collection}/${enc(decodeURIComponent(az.project))}/_apis/git/repositories/${enc(decodeURIComponent(az.repo))}/pullrequests?api-version=${node.apiVersion?.trim() || "5.0"}`;
  let res: Response;
  try {
    res = await fetch(api, {
      method: "POST",
      signal,
      headers: {
        "content-type": "application/json",
        authorization: "Basic " + Buffer.from(":" + token).toString("base64"),
      },
      body: JSON.stringify({
        sourceRefName: `refs/heads/${branch}`,
        targetRefName: `refs/heads/${target}`,
        title,
        description,
        ...(node.draft ? { isDraft: true } : {}),
      }),
    });
  } catch (e) {
    if (signal.aborted) throw new RunCancelledError();
    const cause = (e as { cause?: { code?: string } }).cause?.code;
    return pushed(
      `sunucuya ulaşılamadı${cause ? ` (${cause})` : ""}` +
        (cause && /CERT|SELF_SIGNED|UNABLE_TO_VERIFY/.test(cause) ? " — kurum sertifikası için NODE_EXTRA_CA_CERTS ayarla" : ""),
    );
  }
  const body = (await res.json().catch(() => ({}))) as { pullRequestId?: number; message?: string };
  if (!res.ok || typeof body.pullRequestId !== "number") {
    const why =
      res.status === 401 || res.status === 403
        ? "erişim anahtarı reddedildi (yetki: Kod — okuma ve yazma)"
        : res.status === 409
          ? "bu dal için açık bir çekme isteği zaten var"
          : `sunucu ${res.status} döndü${body.message ? `: ${body.message}` : ""}`;
    return pushed(`çekme isteği açılamadı — ${why}`);
  }
  const url = `${az.collection}/${enc(decodeURIComponent(az.project))}/_git/${enc(decodeURIComponent(az.repo))}/pullrequest/${body.pullRequestId}`;
  return { repo: repoLabel, status: "created", branch, target, url, message: `#${body.pullRequestId}` };
}

/** Düğümün kendisi: değişen dosyaların depolarında sırayla çekme isteği açar */
export async function runPullRequests(
  node: PrNodeConfig,
  changedFiles: string[],
  summary: PrSummary,
  cwd: string,
  bus: EventBus,
  signal: AbortSignal,
): Promise<PrRepoResult[]> {
  const { repos, outside } = await groupByRepo(changedFiles, cwd, signal);
  const label = (root: string) => path.relative(cwd, root).split(path.sep).join("/") || ".";
  bus.emit({ type: "pr_started", repos: [...repos.keys()].map(label) });
  console.log(`\n🔀 Çekme isteği: ${repos.size} depo${outside.length ? ` (${outside.length} dosya bir depoda değil)` : ""}`);
  const results: PrRepoResult[] = [];
  if (!repos.size) {
    const r: PrRepoResult = {
      repo: ".",
      status: "skipped",
      message: changedFiles.length ? "değişen dosyalar bir git deposunda değil" : "değişen dosya yok",
    };
    bus.emit({ type: "pr_result", ...r });
    results.push(r);
  }
  for (const [root, files] of repos) {
    let r: PrRepoResult;
    try {
      r = await openOne(root, files, node, summary, label(root), signal);
    } catch (e) {
      if (e instanceof RunCancelledError) throw e;
      r = { repo: label(root), status: "failed", message: e instanceof Error ? e.message : String(e) };
    }
    console.log(`  ${{ created: "✅", pushed: "📤", skipped: "⏭", failed: "❌" }[r.status]} ${r.repo}: ${r.message ?? ""}${r.url ? ` ${r.url}` : ""}`);
    bus.emit({ type: "pr_result", ...r });
    results.push(r);
  }
  return results;
}
