import { query } from "@anthropic-ai/claude-agent-sdk";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { buildAgentEnv } from "./config.js";
import { ReviewVerdictSchema, type ProviderConfig, type ReviewVerdict } from "./types.js";

/**
 * Reviewer'ın serbest metin raporundan karar nesnesi çıkarır.
 *
 * - Anthropic + ANTHROPIC_API_KEY tanımlıysa: doğrudan API + structured output;
 *   şema API tarafında zorlanır, geçersiz JSON gelmesi imkânsızdır.
 * - Diğer durumlarda (Claude Code oturumu veya Ollama): Agent SDK ile JSON
 *   istenir, Zod ile doğrulanır; uymazsa hata mesajıyla bir kez yeniden denenir.
 */
export async function extractVerdict(
  reviewText: string,
  cfg: ProviderConfig,
): Promise<ReviewVerdict> {
  const key = cfg.provider === "anthropic" ? (cfg.apiKey ?? process.env.ANTHROPIC_API_KEY) : undefined;
  return key
    ? extractWithStructuredOutput(reviewText, cfg, key)
    : extractWithAgentSdk(reviewText, cfg);
}

function buildExtractionPrompt(reviewText: string): string {
  return [
    "Aşağıda bir kod inceleme raporu var. Rapordan karar nesnesini çıkar:",
    "- approved: rapor nihai kararda ONAYLANDI diyorsa true, REDDEDİLDİ diyorsa false.",
    "  Karar satırı yoksa: medium/high önem dereceli sorun varsa false, yoksa true.",
    "- issues: raporda listelenen her sorun (dosya, açıklama, önem derecesi).",
    "- summary: raporun 1-2 cümlelik özeti.",
    "",
    "--- RAPOR ---",
    reviewText,
  ].join("\n");
}

// ── Yol 1: Doğrudan API + structured output (Anthropic + API key) ──

async function extractWithStructuredOutput(
  reviewText: string,
  cfg: ProviderConfig,
  apiKey: string,
): Promise<ReviewVerdict> {
  const client = new Anthropic({ apiKey, ...(cfg.baseUrl ? { baseURL: cfg.baseUrl } : {}) });
  const response = await client.messages.parse({
    model: cfg.verdictModel ?? cfg.model ?? "claude-opus-4-8",
    max_tokens: 2048,
    thinking: { type: "adaptive" },
    messages: [{ role: "user", content: buildExtractionPrompt(reviewText) }],
    output_config: { format: zodOutputFormat(ReviewVerdictSchema) },
  });

  if (!response.parsed_output) {
    throw new Error("Reviewer kararı ayrıştırılamadı (parsed_output boş)");
  }
  return response.parsed_output;
}

// ── Yol 2: Agent SDK (Claude Code oturumu veya Ollama; JSON + Zod doğrulaması) ──

async function extractWithAgentSdk(
  reviewText: string,
  cfg: ProviderConfig,
): Promise<ReviewVerdict> {
  const jsonSchema = JSON.stringify(z.toJSONSchema(ReviewVerdictSchema), null, 2);
  const env = buildAgentEnv(cfg);
  const model = cfg.verdictModel ?? cfg.model;
  let retryNote = "";

  for (let attempt = 1; attempt <= 2; attempt++) {
    const prompt = [
      buildExtractionPrompt(reviewText),
      "",
      "Cevabını YALNIZCA şu JSON şemasına uyan tek bir JSON nesnesi olarak ver;",
      "başka hiçbir metin, açıklama veya kod bloğu işareti ekleme:",
      jsonSchema,
      retryNote,
    ].join("\n");

    let text = "";
    for await (const message of query({
      prompt,
      options: {
        allowedTools: [],
        permissionMode: "default",
        maxTurns: 1,
        ...(env ? { env } : {}),
        ...(model ? { model } : {}),
      },
    })) {
      if (message.type === "result" && message.subtype === "success") {
        text = message.result;
      }
    }

    // Model kod bloğuna sarmış veya önüne metin koymuş olabilir — JSON gövdesini ayıkla
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start !== -1 && end > start) {
      try {
        const parsed = ReviewVerdictSchema.safeParse(JSON.parse(text.slice(start, end + 1)));
        if (parsed.success) return parsed.data;
        retryNote = `\nÖnceki denemen şemaya uymadı: ${parsed.error.message}\nBu hataları düzelterek SADECE geçerli JSON döndür.`;
      } catch (err) {
        retryNote = `\nÖnceki denemen geçerli JSON değildi (${err instanceof Error ? err.message : err}). SADECE geçerli JSON döndür.`;
      }
    } else {
      retryNote = "\nÖnceki denemende JSON nesnesi bulunamadı. SADECE geçerli JSON döndür.";
    }
  }

  throw new Error("Reviewer kararı 2 denemede de şemaya uygun ayrıştırılamadı");
}
