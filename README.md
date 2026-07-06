# alpai-orchestrator

Md dosyalarıyla tanımlanan ajanları (architect → developer ⇄ reviewer) **deterministik** bir iş akışıyla koordine eden TypeScript orkestratörü.

Kontrol akışı kodda, personalar md dosyalarında, tüm ayarlar tek `config.json`'da yaşar:

- **Ajanlar** — `.claude/agents/*.md` dosyaları her ajanın system prompt'udur. İçlerinde "işin bitince X'i çağır" gibi talimat yoktur; geçişleri orkestratör yapar.
- **Config** — `config.json` her şeyi tanımlar: sağlayıcı (Anthropic/Ollama), adres, token, model, hedef proje dizini ve iş akışı grafı (kim kimi çağırır, onay nerede beklenir, reject döngüsü kaç tur sürer).
- **Yürütme** — Her ajan `@anthropic-ai/claude-agent-sdk` (`query()`) ile gerçek araçlarla (Read/Write/Edit/Bash) çalışır.
- **Karar** — Reviewer'ın raporu structured output ile `{ approved, issues[] }` nesnesine çevrilir; dallanma bu boolean'a göre yapılır.

## Kurulum

```sh
npm install
```

## Kullanım

İki mod var:

```sh
# 1) Tek görev modu: görevi CLI'dan ver, koşu bitince çıkar
npm start -- "Basit bir CLI todo uygulaması yaz (Node.js, dosyaya kaydetsin)"

# 2) Sunucu modu: görev argümanı verme — panel açılır, görevleri panelden girersin.
#    Her koşu bitince panel yeni görev girişine döner; servis çalışmaya devam eder.
npm run serve

# Hedef proje dizinini geçici olarak ezmek için
npm start -- "X özelliğini ekle" --cwd C:\work\baska-proje

# Farklı bir config dosyasıyla
npm start -- "görev" --config config.ollama.json
```

Akış:

1. **architect** planı üretir → **senin onayın** beklenir (h dersen yorumunla yeniden planlar)
2. **developer** planı koda döker
3. **reviewer** kodu inceler → `REDDEDİLDİ` ise sorun listesi developer'a geri gider (en fazla `maxCycles` tur), `ONAYLANDI` ise akış biter

## İzleme paneli

Akış başlarken `http://localhost:4141` adresinde bir izleme paneli açılır (`--port` ile değiştir, `--no-ui` ile kapat; config'de `uiPort` alanı da var). Panel SSE ile canlı beslenir:

- **Yeni görev kartı** — sunucu modunda görevleri buradan girersin; koşu sürerken gizlenir, bitince geri gelir (aynı anda tek koşu, meşgulken 409)
- **Ajan hattı** — hangi ajan bekliyor/çalışıyor/bitti/reddetti
- **Olay akışı** — ajan metinleri, araç kullanımları, kararlar (zaman damgalı)
- **Reviewer kararı** — onay/red + sorun listesi (önem dereceleriyle)
- **Onay kartı** — plan hazır olunca panelde belirir; **Onayla/Reddet** düğmeleri terminaldeki `e/h` sorusuyla yarışır, hangisi önce cevap verirse o geçerli olur. Red gerekçesi architect'e geri döner.

Her koşunun tüm olayları ayrı bir `runs/<tarih>.jsonl` dosyasına da yazılır — geçmiş koşuları incelemek için.

HTTP arayüzü: `GET /` panel, `GET /events` SSE, `POST /approval` onay, `POST /task` yeni görev (sadece sunucu modunda).

## config.json

```json
{
  "provider": "anthropic",
  "baseUrl": "",
  "apiKey": "",
  "model": "",
  "verdictModel": "",
  "targetDir": ".",
  "workflow": { "entry": "architect", "maxCycles": 5, "agents": { ... } }
}
```

Boş (`""`) bırakılan alan "tanımsız" sayılır ve sağlayıcının varsayılanı kullanılır.

| Alan | Anlamı |
|---|---|
| `provider` | `"anthropic"` veya `"ollama"` |
| `baseUrl` | API adresi. Anthropic'te boş bırak; Ollama'da boşsa `http://localhost:11434` |
| `apiKey` | Token. Anthropic'te boşsa Claude Code oturumu kullanılır; doluysa structured output şema garantisi devreye girer. Ollama doğrulamaz, boş bırakılabilir |
| `model` | Ajanların varsayılan modeli. Anthropic'te boşsa Claude Code varsayılanı; **Ollama'da zorunlu** (örn. `qwen3-coder:30b`) |
| `verdictModel` | Karar çıkarma adımının modeli (boşsa `model`) |
| `targetDir` | Geliştirmenin yapılacağı hedef proje dizini (`--cwd` bayrağı bunu ezer) |
| `workflow` | İş akışı grafı — aşağıda |

### Ollama'ya geçiş

Aynı dosyada sadece sağlayıcı alanlarını değiştir:

```json
{
  "provider": "ollama",
  "baseUrl": "http://localhost:11434",
  "apiKey": "",
  "model": "qwen3-coder:30b",
  "targetDir": "C:/work/gelistirilecek-proje",
  "workflow": { ... aynı kalır ... }
}
```

Gereksinimler: Anthropic API uyumluluğu olan güncel bir Ollama sürümü ve indirilen model (`ollama pull qwen3-coder:30b`). Tüm istekler (ajanlar + karar çıkarma) `baseUrl`'e yönlendirilir; Anthropic hesabı gerekmez. Not: Yerel modellerin araç kullanma becerisi bulut modellerinden zayıftır — agentic akış için güçlü bir coder modeli önerilir.

## İş akışını özelleştirme (`workflow`)

Yeni ajan eklemek = bir md dosyası + `workflow.agents`'a bir düğüm:

```json
"tester": {
  "file": ".claude/agents/tester.md",
  "tools": ["Read", "Bash"],
  "next": "reviewer"
}
```

Düğüm alanları:

| Alan | Anlamı |
|---|---|
| `file` | Ajanın md dosyası (frontmatter: `name`, `description`; gövde: system prompt) |
| `tools` | İzin verilen Claude Code araçları |
| `model` | İsteğe bağlı model override'ı (config'deki genel `model`i ezer) |
| `requiresUserApproval` | `true` ise çıktı sonrası terminalde onay beklenir |
| `next` | Koşulsuz geçiş (null/yok = akış biter) |
| `verdict` | `{ onApprove, onReject }` — çıktıdan structured karar çıkarılır ve dallanılır |

`verdict` ve `next` aynı düğümde birlikte kullanılamaz; kenarların var olan ajanlara işaret ettiği yüklemede doğrulanır.
