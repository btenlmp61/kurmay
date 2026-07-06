# alpai-orchestrator

Md dosyalarıyla tanımlı ajanları (architect → developer ⇄ reviewer) deterministik bir iş akışıyla koordine eden TypeScript orkestratörü. Temel ilke: **kontrol akışı kodda, personalar md'de, tüm ayarlar tek config.json'da.** Ajan geçişleri asla modelin talimat hatırlamasına bırakılmaz.

## Komutlar

```sh
npm start -- "görev"     # tek görev modu: çalıştırır ve çıkar
npm run serve            # sunucu modu: panel açılır, görevler panelden girilir, servis açık kalır
npm run typecheck        # tsc --noEmit
```

Bayraklar: `--config <dosya>`, `--cwd <hedef dizin>`, `--port <n>`, `--no-ui`.

## Mimari

| Dosya | Sorumluluk |
|---|---|
| `config.json` | TEK config: sağlayıcı (anthropic/ollama), baseUrl/apiKey/model, targetDir, uiPort ve workflow grafı. Boş string ("") alanlar tanımsız sayılır |
| `.claude/agents/*.md` | Ajan personaları (system prompt). İçlerinde "X'i çağır" talimatı YOK — geçişler orkestratörün işi |
| `.rules/*.md` | Her zaman geçerli kısıtlar; config'de `rules: [...]` ile ajana bağlanır, tam içerik system prompt'a gömülür (kısa tutulmalı) |
| `.skill/<ad>/SKILL.md` | Beceriler (progressive disclosure): prompt'a sadece ad+açıklama+mutlak yol girer, ajan Read ile kendisi okur; `inline: true` frontmatter'ı tamamını gömer. Tembel beceri Read aracı gerektirir (yüklemede doğrulanır) |
| `src/orchestrator.ts` | Graf motoru: onay duraklaması, verdict dallanması, reject döngüsü (maxCycles korumalı) |
| `src/runAgent.ts` | Agent SDK `query()` sarmalayıcısı; md gövdesi `systemPrompt: {preset claude_code, append}` olarak gider; araçlar allowedTools ile kısıtlı |
| `src/verdict.ts` | Reviewer raporundan `{approved, issues[]}` çıkarma. İki yol: ANTHROPIC_API_KEY varsa messages.parse + structured output (şema API'de garanti); yoksa Agent SDK + Zod + 1 retry |
| `src/approval.ts` | Onay yarışı: terminal (e/h) ve web POST /approval aynı anda dinlenir, kazanan geçerli, kaybeden iptal (AbortController / cancel) |
| `src/events.ts` | EventBus: tüm adımlar tipli olay olarak yayınlanır; terminal/panel/JSONL hepsi dinleyici |
| `src/server.ts` | Node http (bağımlılıksız): GET / panel, GET /events SSE, POST /approval, POST /task (sadece sunucu modunda) |
| `ui/index.html` | Panel: ajan hattı, olay akışı, karar kartı, onay kartı, görev girişi. Kütüphanesiz, koyu mod destekli |
| `runs/*.jsonl` | Koşu başına olay kaydı |

## Kritik bilinenler (tekrar keşfetme)

- **Node ≥ 20 şart** (şu an v24.18, 2026-07-06'da winget ile yükseltildi). Node 18'de Agent SDK `using` sözdizimi yüzünden "Object not disposable" hatası verir. Kullanıcının eski terminal oturumları hâlâ Node 18 görebilir.
- **zod ^4 olmalı** — claude-agent-sdk'nin peer bağımlılığı; zod 3 ile npm install ERESOLVE verir.
- **SSE ilk bayt**: /events bağlanınca hemen `: bagli\n\n` yazılmalı, yoksa boş geçmişte tarayıcı "bağlanıyor…"da takılır (yaşandı, düzeltildi). 25 sn'de bir heartbeat var.
- **EADDRINUSE :::4141** = zaten çalışan bir serve var; eskisini kapat veya --port değiştir.
- Kimlik: Claude Code oturumu yeterli (API key gerekmez). API key tanımlanırsa verdict adımı otomatik structured output'a geçer.
- Ollama: config'de provider "ollama" + model zorunlu; buildAgentEnv ANTHROPIC_BASE_URL/AUTH_TOKEN/MODEL enjekte eder. Anthropic API uyumlu güncel Ollama sürümü gerekir.

## Test durumu

- Uçtan uca doğrulanmış (gerçek koşularla): tek görev modu, sunucu modu (2 ardışık görev), web'den onay, verdict-onay yolu, hedef dizine yazım. Test hedefi: `D:\work\testapp` (basit todo uygulaması).
- **Henüz gerçek koşuda görülmemiş**: reviewer RED → developer düzeltme döngüsü (tüm koşular ilk turda onaylandı), kullanıcı reddi (h + yorum) yolu, Ollama sağlayıcısı (bu makinede Ollama kurulu değil).
