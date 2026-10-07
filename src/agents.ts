import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import {
  isCommandNode,
  isFanoutNode,
  isGateNode,
  isParallelNode,
  reviewVerdictJsonSchema,
  type AgentDefinition,
  type AgentNodeConfig,
  type WorkflowConfig,
} from "./types.js";

interface LoadedRule {
  name: string;
  content: string;
}

interface LoadedSkill {
  name: string;
  description: string;
  inline: boolean;
  absPath: string;
  content: string;
}

function loadRule(name: string, projectRoot: string, agentKey: string): LoadedRule {
  const rulePath = path.resolve(projectRoot, ".claude", "rules", `${name}.md`);
  if (!fs.existsSync(rulePath)) {
    throw new Error(`"${agentKey}" ajanının kuralı bulunamadı: ${rulePath}`);
  }
  return { name, content: fs.readFileSync(rulePath, "utf8").trim() };
}

function loadSkill(name: string, projectRoot: string, agentKey: string): LoadedSkill {
  const skillPath = path.resolve(projectRoot, ".claude", "skills", name, "SKILL.md");
  if (!fs.existsSync(skillPath)) {
    throw new Error(`"${agentKey}" ajanının becerisi bulunamadı: ${skillPath}`);
  }
  const { data, content } = matter(fs.readFileSync(skillPath, "utf8"));
  return {
    name: (data.name as string) ?? name,
    description: (data.description as string) ?? "",
    inline: data.inline === true,
    absPath: skillPath,
    content: content.trim(),
  };
}

/**
 * System prompt üç katmandan derlenir:
 *   1. Persona (ajan md gövdesi)
 *   2. Kurallar — tam içerik, her zaman geçerli kısıtlar
 *   3. Beceriler — ad + açıklama + dosya yolu; ajan ilgili görürse Read ile okur
 *      (progressive disclosure). inline: true olan becerinin tamamı gömülür.
 */
function composeSystemPrompt(
  persona: string,
  rules: LoadedRule[],
  skills: LoadedSkill[],
  mcpTools: string[],
): string {
  const parts = [persona];

  if (mcpTools.length > 0) {
    parts.push(
      "## MCP araçların\n\n" +
        "Şu MCP araçlarına erişimin var: " + mcpTools.join(", ") + "\n" +
        "Bu araçlar oturum başında araç listende görünmeyebilir — görünmüyorsa " +
        "ToolSearch ile adını aratıp yükle, ilgili işler için Bash yerine bunları tercih et.",
    );
  }

  if (rules.length > 0) {
    parts.push(
      "## Kurallar (her zaman geçerli)\n\n" +
        rules.map((r) => `### ${r.name}\n${r.content}`).join("\n\n"),
    );
  }

  const inlineSkills = skills.filter((s) => s.inline);
  const lazySkills = skills.filter((s) => !s.inline);

  if (inlineSkills.length > 0) {
    parts.push(
      "## Beceriler\n\n" +
        inlineSkills.map((s) => `### ${s.name}\n${s.content}`).join("\n\n"),
    );
  }

  if (lazySkills.length > 0) {
    parts.push(
      "## Kullanımına açık beceriler\n\n" +
        "Aşağıdaki beceri dosyaları görevinle ilgiliyse, çalışmaya başlamadan ÖNCE " +
        "ilgili dosyayı Read aracıyla oku ve içindeki yöntemi uygula:\n\n" +
        lazySkills.map((s) => `- **${s.name}** — ${s.description}\n  Dosya: ${s.absPath}`).join("\n"),
    );
  }

  return parts.join("\n\n");
}

function validateEdges(
  key: string,
  config: AgentNodeConfig,
  workflow: WorkflowConfig,
  /** Bu ajanı yöneten kapı (paralel düğümün dalı ya da fanout'un işçisi) — kendi kenarı olamaz */
  owner: { key: string; kind: "paralel" | "fanout" } | null,
): void {
  const routeTargets = config.routes
    ? [...Object.values(config.routes.cases), config.routes.default]
    : [];
  const targets = [config.next, config.verdict?.onApprove, config.verdict?.onReject, ...routeTargets];
  for (const target of targets) {
    if (target != null && !workflow.agents[target]) {
      throw new Error(`"${key}" ajanı var olmayan bir ajana işaret ediyor: "${target}"`);
    }
  }
  // next / verdict / routes birbirini dışlar — dallanma tek bir mekanizmayla yapılır
  const branchCount = [config.next != null, !!config.verdict, !!config.routes].filter(Boolean).length;
  if (branchCount > 1) {
    throw new Error(`"${key}": next, verdict ve routes aynı anda tanımlanamaz — biri seçilmeli`);
  }
  // Paralel dalın kendi kenarı OLAMAZ: nereye gidileceğine paralel düğüm karar
  // verir (dallar birleşmeden kimse ilerleyemez). Sessizce yok saymak yerine
  // hata veriyoruz — config editöründe çizilmeyen bir kenar kafa karıştırır.
  if (owner && branchCount > 0) {
    throw new Error(
      owner.kind === "paralel"
        ? `"${key}" bir paralel dal — kendi next/verdict/routes kenarı olamaz; ` +
            `yönlendirmeyi bağlı olduğu paralel düğümün onApprove/onReject'i yapar`
        : `"${key}" "${owner.key}" fanout düğümünün işçisi — kendi next/verdict/routes kenarı olamaz; ` +
            `kopyalar bitince geçişi "${owner.key}.next" yapar`,
    );
  }
}

/** Paralel dalların aynı anda dosya yazmasını engelleyen yazma araçları */
const WRITE_TOOLS = ["Write", "Edit", "MultiEdit", "NotebookEdit"];

function validateParallelNode(
  key: string,
  config: { branches: string[]; onApprove: string | null; onReject: string },
  workflow: WorkflowConfig,
): void {
  if (!Array.isArray(config.branches) || config.branches.length === 0) {
    throw new Error(`"${key}" paralel düğümünün en az bir dalı olmalı`);
  }
  const seen = new Set<string>();
  for (const branch of config.branches) {
    if (seen.has(branch)) {
      throw new Error(`"${key}" paralel düğümünde "${branch}" dalı birden fazla kez geçiyor`);
    }
    seen.add(branch);
    if (branch === key) {
      throw new Error(`"${key}" paralel düğümü kendisini dal olarak alamaz`);
    }
    const node = workflow.agents[branch];
    if (!node) {
      throw new Error(`"${key}" paralel düğümü var olmayan bir dala işaret ediyor: "${branch}"`);
    }
    if (isGateNode(node)) {
      throw new Error(`"${key}" paralel düğümünün dalı ajan olmalı; "${branch}" bir ${node.type} düğümü`);
    }
    // Dallar eş zamanlı ve aynı dizinde koşuyor — yazma araçları yarış demek
    const writers = node.tools.filter((t) => WRITE_TOOLS.includes(t));
    if (writers.length > 0) {
      throw new Error(
        `"${branch}" paralel dalında yazma aracı var (${writers.join(", ")}) — ` +
          `dallar eş zamanlı koştuğu için salt-okunur olmalı. ` +
          `Bash da yazabilir: guard-readonly.js PreToolUse hook'unu kullan.`,
      );
    }
  }
  for (const target of [config.onApprove, config.onReject]) {
    if (target != null && !workflow.agents[target]) {
      throw new Error(`"${key}" paralel düğümü var olmayan bir düğüme işaret ediyor: "${target}"`);
    }
  }
}

/**
 * Config'deki iş akışı grafının referans verdiği md/kural/beceri dosyalarını
 * yükler ve tutarlılığı doğrular (kenarlar, dosya varlığı, araç gereksinimleri).
 */
export function loadAgents(
  workflow: WorkflowConfig,
  projectRoot: string,
): Map<string, AgentDefinition> {
  const agents = new Map<string, AgentDefinition>();

  // Hangi ajanlar bir paralel düğümün dalı? Dallar kendi kenarlarını taşımaz ve
  // her zaman yerleşik karar şemasını alır — bu yüzden döngüden ÖNCE toplanıyor.
  const branchKeys = new Set<string>();
  for (const config of Object.values(workflow.agents)) {
    if (isParallelNode(config)) for (const b of config.branches) branchKeys.add(b);
  }
  // Fanout işçileri: kenarsızdır ama (dallardan farklı olarak) yazabilir ve kendi
  // md şemasını kullanır — her repo kopyası developer gibi çalışır
  const workerOf = new Map<string, string>();
  for (const [key, config] of Object.entries(workflow.agents)) {
    if (!isFanoutNode(config)) continue;
    const worker = workflow.agents[config.agent];
    if (!config.agent || !worker) {
      throw new Error(`"${key}" fanout düğümü var olmayan bir ajana işaret ediyor: "${config.agent}"`);
    }
    if (isGateNode(worker)) {
      throw new Error(`"${key}" fanout düğümünün işçisi ajan olmalı; "${config.agent}" bir ${worker.type} düğümü`);
    }
    if (branchKeys.has(config.agent)) {
      throw new Error(`"${config.agent}" hem paralel dal hem "${key}" fanout işçisi olamaz`);
    }
    if (workerOf.has(config.agent)) {
      throw new Error(`"${config.agent}" iki fanout düğümünün ("${workerOf.get(config.agent)}", "${key}") işçisi olamaz`);
    }
    workerOf.set(config.agent, key);
    if (config.next != null && !workflow.agents[config.next]) {
      throw new Error(`"${key}" fanout düğümü var olmayan bir düğüme işaret ediyor: "${config.next}"`);
    }
  }

  for (const [key, config] of Object.entries(workflow.agents)) {
    // Komut düğümü ajan değildir — persona/araç yüklenmez, yalnızca kenarları doğrulanır
    if (isCommandNode(config)) {
      for (const target of [config.onSuccess, config.onFailure]) {
        if (target != null && !workflow.agents[target]) {
          throw new Error(`"${key}" komut düğümü var olmayan bir düğüme işaret ediyor: "${target}"`);
        }
      }
      continue;
    }

    // Paralel düğüm de ajan değildir — dalları ve hedefleri doğrulanır
    if (isParallelNode(config)) {
      validateParallelNode(key, config, workflow);
      continue;
    }

    // Fanout da ajan değildir — yukarıda doğrulandı
    if (isFanoutNode(config)) continue;

    const mdPath = path.resolve(projectRoot, config.file);
    if (!fs.existsSync(mdPath)) {
      throw new Error(`"${key}" ajanının md dosyası bulunamadı: ${mdPath}`);
    }

    const isBranch = branchKeys.has(key);
    const { data, content } = matter(fs.readFileSync(mdPath, "utf8"));
    const owner = isBranch
      ? { key: [...Object.entries(workflow.agents)].find(([, n]) => isParallelNode(n) && n.branches.includes(key))![0], kind: "paralel" as const }
      : workerOf.has(key) ? { key: workerOf.get(key)!, kind: "fanout" as const } : null;
    validateEdges(key, config, workflow, owner);

    const rules = (config.rules ?? []).map((name) => loadRule(name, projectRoot, key));
    const skills = (config.skills ?? []).map((name) => loadSkill(name, projectRoot, key));

    // Tembel yüklenen beceri, ajanın dosyayı okuyabilmesini gerektirir
    if (skills.some((s) => !s.inline) && !config.tools.includes("Read")) {
      throw new Error(
        `"${key}" ajanının becerileri var ama Read aracı yok — beceri dosyasını okuyamaz. ` +
          `tools listesine "Read" ekle veya becerileri inline yap.`,
      );
    }

    // Çıktı şeması: verdict düğümü ve paralel dallar HER ZAMAN yerleşik karar
    // şemasını kullanır (dallanma/birleştirme buna güvenir); diğer düğümler md
    // frontmatter'daki "output"u alır
    let outputSchema: Record<string, unknown> | undefined;
    if (config.verdict || isBranch) {
      if (data.output) {
        const kind = isBranch ? "paralel dal" : "verdict düğümü";
        console.warn(
          `⚠ "${key}" ${kind} — md'deki "output" şeması yok sayılıyor, yerleşik karar şeması kullanılacak`,
        );
      }
      outputSchema = reviewVerdictJsonSchema();
    } else if (data.output && typeof data.output === "object") {
      outputSchema = data.output as Record<string, unknown>;
    }

    agents.set(key, {
      key,
      name: (data.name as string) ?? key,
      description: (data.description as string) ?? "",
      systemPrompt: composeSystemPrompt(
        content.trim(),
        rules,
        skills,
        config.tools.filter((t) => t.startsWith("mcp__")),
      ),
      outputSchema,
      config,
    });
  }

  return agents;
}
