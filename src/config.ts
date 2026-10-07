import fs from "node:fs";
import path from "node:path";
import { isCommandNode, isParallelNode, type AppConfig, type ProviderConfig } from "./types.js";

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
  for (const key of ["baseUrl", "apiKey", "model", "modelsUrl", "verdictModel", "targetDir"] as const) {
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

  // Sınırlar sayı olmalı — hatalı değer env'e "NaN" olarak sızmasın
  for (const [key, value] of Object.entries(cfg.limits ?? {})) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new Error(`config: "limits.${key}" negatif olmayan bir sayı olmalı (verilen: ${JSON.stringify(value)})`);
    }
  }

  // Yeniden deneme ayarları: "enabled" mantıksal, diğerleri negatif olmayan sayı
  for (const [key, value] of Object.entries(cfg.retry ?? {})) {
    if (key === "enabled") {
      if (typeof value !== "boolean") {
        throw new Error(`config: "retry.enabled" true/false olmalı (verilen: ${JSON.stringify(value)})`);
      }
      continue;
    }
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new Error(`config: "retry.${key}" negatif olmayan bir sayı olmalı (verilen: ${JSON.stringify(value)})`);
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
    if (node.disabled !== undefined && typeof node.disabled !== "boolean") {
      throw new Error(`config: "${key}.disabled" true/false olmalı (verilen: ${JSON.stringify(node.disabled)})`);
    }
    if (isCommandNode(node)) {
      if (typeof node.command !== "string" || !node.command.trim()) {
        throw new Error(`config: "${key}" komut düğümü için "command" (build komutu) zorunlu`);
      }
      continue; // komut düğümünün tools listesi yok
    }
    if (isParallelNode(node)) continue; // paralel düğüm de bir kapı, tools listesi yok
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
 * İki kaynak: baseUrl tanımlıysa sağlayıcı yönlendirmesi (örn. Ollama), ve
 * config'deki "limits" (maliyet/süre sınırları). Hiçbiri yoksa undefined döner
 * ve mevcut ortam aynen kullanılır (Anthropic varsayılanı).
 */
export function buildAgentEnv(cfg: ProviderConfig): Record<string, string> | undefined {
  const overrides: Record<string, string> = {};

  if (cfg.baseUrl) {
    overrides.ANTHROPIC_BASE_URL = cfg.baseUrl;
    overrides.ANTHROPIC_AUTH_TOKEN = cfg.apiKey ?? "ollama";
    if (cfg.model) {
      overrides.ANTHROPIC_MODEL = cfg.model;
      // Claude Code'un iç işleri için kullandığı küçük model de yerelden gelsin
      overrides.ANTHROPIC_SMALL_FAST_MODEL = cfg.model;
    }
  }

  // Sınırlar sağlayıcıdan bağımsız uygulanır — verilmeyen alan SDK varsayılanında kalır
  const limits = cfg.limits;
  if (limits) {
    const map: Array<[number | undefined, string]> = [
      [limits.structuredOutputRetries, "MAX_STRUCTURED_OUTPUT_RETRIES"],
      [limits.apiTimeoutMs, "API_TIMEOUT_MS"],
      [limits.maxOutputTokens, "CLAUDE_CODE_MAX_OUTPUT_TOKENS"],
      [limits.maxMcpOutputTokens, "MAX_MCP_OUTPUT_TOKENS"],
      [limits.maxThinkingTokens, "MAX_THINKING_TOKENS"],
    ];
    for (const [value, envName] of map) {
      if (value !== undefined) overrides[envName] = String(value);
    }
  }

  if (Object.keys(overrides).length === 0) return undefined;

  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  Object.assign(env, overrides);
  if (cfg.baseUrl) delete env.ANTHROPIC_API_KEY; // AUTH_TOKEN ile çakışmasın

  return env;
}
