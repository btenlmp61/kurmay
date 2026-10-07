/** Panelde seçilebilecek tek bir model */
export interface ModelInfo {
  /** Config'e yazılacak ve SDK'ye geçecek kimlik */
  id: string;
  /** Görünen ad (API vermezse id) */
  name: string;
}

/**
 * Config'teki "modelsUrl" adresine GET atıp kullanılabilir modelleri döner.
 * API anahtarı başlıkta gider; hangi şemayı beklediğini bilmediğimiz için hem
 * `Authorization: Bearer` (OpenAI uyumlu / LiteLLM / vLLM) hem `x-api-key`
 * (Anthropic) gönderilir — sunucu tanımadığını yok sayar.
 *
 * Yanıt biçimi de sağlayıcıya göre değişir; şu üçü tanınır:
 *   { data: [{ id, display_name? | name? }] }   OpenAI / Anthropic
 *   { models: [{ name | model | id }] }          Ollama /api/tags
 *   [ "id", ... ] veya [{ id | name }, ...]      düz liste
 */
export async function fetchModels(url: string, apiKey?: string): Promise<ModelInfo[]> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (apiKey) {
    headers.authorization = `Bearer ${apiKey}`;
    headers["x-api-key"] = apiKey;
  }

  const res = await fetch(url, { method: "GET", headers, signal: AbortSignal.timeout(15000) });
  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 200);
    throw new Error(`model listesi alınamadı: HTTP ${res.status}${body ? ` — ${body}` : ""}`);
  }

  const json = (await res.json()) as unknown;
  const obj = json as { data?: unknown; models?: unknown };
  const list = Array.isArray(json)
    ? json
    : Array.isArray(obj?.data)
      ? obj.data
      : Array.isArray(obj?.models)
        ? obj.models
        : null;
  if (!list) throw new Error("model listesi tanınmayan biçimde (data[] / models[] / dizi bekleniyordu)");

  const models: ModelInfo[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    let id: string | undefined;
    let name: string | undefined;
    if (typeof item === "string") {
      id = item;
    } else if (item && typeof item === "object") {
      const o = item as Record<string, unknown>;
      const pick = (...keys: string[]) => keys.map((k) => o[k]).find((v) => typeof v === "string" && v) as string | undefined;
      id = pick("id", "model", "name");
      name = pick("display_name", "name");
    }
    if (!id || seen.has(id)) continue;
    seen.add(id);
    models.push({ id, name: name ?? id });
  }
  return models;
}
