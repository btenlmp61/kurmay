import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import type { AgentDefinition, AgentNodeConfig, WorkflowConfig } from "./types.js";

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
  const rulePath = path.resolve(projectRoot, ".rules", `${name}.md`);
  if (!fs.existsSync(rulePath)) {
    throw new Error(`"${agentKey}" ajanının kuralı bulunamadı: ${rulePath}`);
  }
  return { name, content: fs.readFileSync(rulePath, "utf8").trim() };
}

function loadSkill(name: string, projectRoot: string, agentKey: string): LoadedSkill {
  const skillPath = path.resolve(projectRoot, ".skill", name, "SKILL.md");
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
): string {
  const parts = [persona];

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

function validateEdges(key: string, config: AgentNodeConfig, workflow: WorkflowConfig): void {
  const targets = [config.next, config.verdict?.onApprove, config.verdict?.onReject];
  for (const target of targets) {
    if (target != null && !workflow.agents[target]) {
      throw new Error(`"${key}" ajanı var olmayan bir ajana işaret ediyor: "${target}"`);
    }
  }
  if (config.verdict && config.next != null) {
    throw new Error(`"${key}": verdict ve next aynı anda tanımlanamaz — dallanma verdict ile yapılır`);
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

  for (const [key, config] of Object.entries(workflow.agents)) {
    const mdPath = path.resolve(projectRoot, config.file);
    if (!fs.existsSync(mdPath)) {
      throw new Error(`"${key}" ajanının md dosyası bulunamadı: ${mdPath}`);
    }

    const { data, content } = matter(fs.readFileSync(mdPath, "utf8"));
    validateEdges(key, config, workflow);

    const rules = (config.rules ?? []).map((name) => loadRule(name, projectRoot, key));
    const skills = (config.skills ?? []).map((name) => loadSkill(name, projectRoot, key));

    // Tembel yüklenen beceri, ajanın dosyayı okuyabilmesini gerektirir
    if (skills.some((s) => !s.inline) && !config.tools.includes("Read")) {
      throw new Error(
        `"${key}" ajanının becerileri var ama Read aracı yok — beceri dosyasını okuyamaz. ` +
          `tools listesine "Read" ekle veya becerileri inline yap.`,
      );
    }

    agents.set(key, {
      key,
      name: (data.name as string) ?? key,
      description: (data.description as string) ?? "",
      systemPrompt: composeSystemPrompt(content.trim(), rules, skills),
      config,
    });
  }

  return agents;
}
