import fs from "node:fs";
import path from "node:path";
import { isCommandNode, type AppConfig, type ProviderConfig } from "./types.js";

/**
 * Tek config dosyasını yükler ve doğrular: sağlayıcı bilgileri (adres, token,
 * model), hedef dizin ve iş akışı grafı hepsi aynı dosyadadır.
 */
export function loadAppConfig(configPath: string): AppConfig {
  const resolved = path.resolve(configPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Config dosyası bulunamadı: ${resolved}`);
  }

  const cfg = JSON.parse(fs.readFileSync(resolved, "utf8")) as AppConfig;

  // Boş bırakılan ("") alanlar tanımsız sayılır — config şablonunda alanların
  // görünür kalması için boş string'e izin veriyoruz
  for (const key of ["baseUrl", "apiKey", "model", "verdictModel", "targetDir"] as const) {
    if (cfg[key] === "") delete cfg[key];
  }

  if (cfg.provider !== "anthropic" && cfg.provider !== "ollama") {
    throw new Error('config: "provider" alanı "anthropic" veya "ollama" olmalı');
  }

  if (cfg.provider === "ollama") {
    if (!cfg.baseUrl) cfg.baseUrl = "http://localhost:11434";
    if (!cfg.apiKey) cfg.apiKey = "ollama"; // Ollama değeri umursamaz ama boş bırakılamaz
    if (!cfg.model) {
      throw new Error('config: provider "ollama" için "model" zorunlu (örn. "qwen3-coder:30b")');
    }
  }

  if (!cfg.workflow?.entry || !cfg.workflow.agents) {
    throw new Error('config: "workflow" bölümü eksik ("entry" ve "agents" alanları zorunlu)');
  }
  if (!cfg.workflow.agents[cfg.workflow.entry]) {
    throw new Error(`config: workflow.entry "${cfg.workflow.entry}" agents içinde tanımlı değil`);
  }
  if (!cfg.workflow.maxCycles) cfg.workflow.maxCycles = 5;

  // Ajanların tools listesindeki mcp__ araçları tanımlı bir sunucuya işaret etmeli
  for (const [key, node] of Object.entries(cfg.workflow.agents)) {
    if (isCommandNode(node)) {
      if (typeof node.command !== "string" || !node.command.trim()) {
        throw new Error(`config: "${key}" komut düğümü için "command" (build komutu) zorunlu`);
      }
      continue; // komut düğümünün tools listesi yok
    }
    for (const tool of node.tools) {
      if (tool.startsWith("mcp__")) {
        const serverName = tool.slice(5).split("__")[0];
        if (!cfg.mcpServers?.[serverName]) {
          throw new Error(
            `config: "${key}" ajanı "${tool}" aracını istiyor ama "${serverName}" mcpServers içinde tanımlı değil`,
          );
        }
      }
    }
  }

  return cfg;
}

/**
 * Agent SDK'nin başlattığı Claude Code sürecine geçirilecek ortam değişkenleri.
 * baseUrl tanımlıysa tüm istekler o adrese (örn. Ollama) yönlendirilir.
 */
export function buildAgentEnv(cfg: ProviderConfig): Record<string, string> | undefined {
  if (!cfg.baseUrl) return undefined; // Anthropic varsayılanı: mevcut ortam aynen kullanılır

  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }

  env.ANTHROPIC_BASE_URL = cfg.baseUrl;
  env.ANTHROPIC_AUTH_TOKEN = cfg.apiKey ?? "ollama";
  delete env.ANTHROPIC_API_KEY; // AUTH_TOKEN ile çakışmasın

  if (cfg.model) {
    env.ANTHROPIC_MODEL = cfg.model;
    // Claude Code'un iç işleri için kullandığı küçük model de yerelden gelsin
    env.ANTHROPIC_SMALL_FAST_MODEL = cfg.model;
  }

  return env;
}
