import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import type { AgentDefinition, WorkflowConfig } from "./types.js";

/**
 * Config'deki iş akışı grafının referans verdiği md dosyalarını yükler ve
 * grafın tutarlılığını doğrular (kenarlar var olan ajanlara işaret ediyor mu vb.)
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

    // Kenar doğrulaması: geçişler var olan ajanlara gitmeli
    const targets = [config.next, config.verdict?.onApprove, config.verdict?.onReject];
    for (const target of targets) {
      if (target != null && !workflow.agents[target]) {
        throw new Error(`"${key}" ajanı var olmayan bir ajana işaret ediyor: "${target}"`);
      }
    }
    if (config.verdict && config.next != null) {
      throw new Error(`"${key}": verdict ve next aynı anda tanımlanamaz — dallanma verdict ile yapılır`);
    }

    agents.set(key, {
      key,
      name: (data.name as string) ?? key,
      description: (data.description as string) ?? "",
      systemPrompt: content.trim(),
      config,
    });
  }

  return agents;
}
