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
| `config.json` | TEK config: sağlayıcı (anthropic/ollama), baseUrl/apiKey/model, targetDir, uiPort, mcpServers ve workflow grafı. Boş string ("") alanlar tanımsız sayılır |
| `.claude/agents/*.md` | Ajan personaları (system prompt) + frontmatter `output:` çıktı şeması. İçlerinde "X'i çağır" talimatı YOK — geçişler orkestratörün işi |
| `.claude/rules/*.md` | Her zaman geçerli kısıtlar; config'de `rules: [...]` ile ajana bağlanır, tam içerik system prompt'a gömülür (kısa tutulmalı) |
| `.claude/skills/<ad>/SKILL.md` | Beceriler (progressive disclosure): prompt'a sadece ad+açıklama+mutlak yol girer, ajan Read ile kendisi okur; `inline: true` frontmatter'ı tamamını gömer. Tembel beceri Read aracı gerektirir (yüklemede doğrulanır) |
| `src/orchestrator.ts` | Graf motoru: onay duraklaması, verdict dallanması, reject döngüsü (maxCycles korumalı) |
| `src/runAgent.ts` | Agent SDK `query()` sarmalayıcısı; md gövdesi `systemPrompt: {preset claude_code, append}` olarak gider; araçlar allowedTools ile kısıtlı. Ajanın `outputSchema`sı varsa SDK `outputFormat` (json_schema) ile çalışır, sonuç `structured` alanında döner |
| `src/verdict.ts` | YEDEK yol: reviewer'ın yapılandırılmış kararı gelmezse metinden çıkarır (normalde verdict doğrudan reviewer'ın structured_output'undan alınır) |
| `src/approval.ts` | Onay yarışı: terminal (e/h) ve web POST /approval aynı anda dinlenir, kazanan geçerli, kaybeden iptal (AbortController / cancel) |
| `src/events.ts` | EventBus: tüm adımlar tipli olay olarak yayınlanır; terminal/panel/JSONL hepsi dinleyici |
| `src/server.ts` | Node http (bağımlılıksız): GET / panel, GET /events SSE, POST /approval, POST /task (sadece sunucu modunda) |
| `ui/index.html` | Panel: ajan hattı, olay akışı, karar kartı, onay kartı, görev girişi, yapılandırılmış çıktı kartları. Onay ve çıktı kartlarında `renderDiff()` ile before/after kod-inceleme diff'i (kırmızı/yeşil). Kütüphanesiz, koyu mod destekli |
| `.claude/launch.json` | Preview aracı için `alpai-serve` (npm run serve, port 4141) — panel geliştirmede önizleme sunucusu |
| `runs/*.jsonl` | Koşu başına olay kaydı |

## Yapılandırılmış ajan iletişimi

- Her ajanın çıktı şeması kendi md dosyasının frontmatter'ında (`output:` — YAML JSON-schema). Verdict düğümü frontmatter'a bakmaz, yerleşik karar şemasını (`reviewVerdictJsonSchema()`) kullanır.
- Ajanlar birbirine serbest metin değil şemalı JSON aktarır (orchestrator buildPrompt, ```json bloğu olarak enjekte eder); panelde "yapılandırılmış çıktı" kartı olarak görünür.
- Reviewer kararı doğrudan `structured_output`'tan alınır; gelmezse verdict.ts metinden çıkarma yedeğine düşer.
- Şemalar: architect `{summary, technical_decisions[], assumptions[], file_plan[{path,action,summary,changes[{location,before,after,rationale}]}], steps[], risks[]}`; developer `{changes[{file,action,summary,hunks[{location,before,after}]}], deviations[], verification}`; reviewer `{approved, issues[{file,description,severity}], summary}`.

## Kod-inceleme tarzı onay (A yolu)

- architect ve developer çıktıları **diff biçiminde**: her dosya değişikliği `before`/`after` kod parçalarıyla (architect'te `file_plan[].changes[]`, developer'da `changes[].hunks[]`). Böylece kullanıcı planı gerçek bir kod incelemesi gibi görür.
- Onay duraklaması **architect'te** (kodlamadan ÖNCE önerilen diff'i onaylarsın); developer'ın *gerçek* diff'ini otomatik reviewer onaylar/reddeder. Kullanıcı istedi ama EKLENMEDİ: developer sonrası ikinci bir insan onay düğümü (isteğe bağlı, tek `requiresUserApproval` ile eklenir).
- Panel: `approval_required` olayı artık `structured`'ı da taşır; `renderDiff()` file_plan/changes'ı before(kırmızı)/after(yeşil) render eder, tanımadığı yapıda (reviewer kararı) metne düşer. `#approvalText > pre` ID özgüllüğü hunk arka planlarını eziyordu — daraltılarak düzeltildi.

## Kritik bilinenler (tekrar keşfetme)

- **JSON şemasına `$schema` başlığı KOYMA** — Agent SDK `outputFormat`'ı sessizce bozar: `success` döner ama `structured_output` boş kalır (2026-07-07 A/B testiyle doğrulandı). `z.toJSONSchema` bu başlığı ekler; `reviewVerdictJsonSchema()` bu yüzden siliyor.
- **`outputFormat` ile `maxTurns: 1` kullanma** — SDK şema düzeltme turlarına alan bulamayınca `structured_output` boş kalır.
- **Şema alan adları ve enum değerleri İngilizce/ASCII olmalı** — Türkçe enum değeri (model "değiştir" yazar, enum "degistir" ister) retry hakkını tüketip `error_max_structured_output_retries` üretir (kullanıcıda yaşandı). ASCII İngilizce enum'lar (create/modify/delete, low/medium/high) güvenlidir. İçerik metinleri Türkçe kalır.
- **Structured output'un İKİ bozulma şekli var, ikisi de yakalanıyor** (runAgent): (1) `error_max_structured_output_retries` → ajan bir kez şemasız yeniden çalıştırılır; (2) sessiz bozulma (`success` + boş `structured_output`) → uyarıyla metin kullanılır. Orkestratör metin çıktıyla da ilerler; verdict için metinden çıkarma yedeği (verdict.ts) devrededir.
- **PowerShell ile Türkçe içerikli dosyada metin değiştirme YAPMA** — PS 5.1 `Get-Content` UTF-8'i ANSI okur, dosya bozulur (yaşandı: README/CLAUDE.md mojibake oldu, git checkout ile kurtarıldı). Metin değişikliklerini Edit aracıyla yap.
- **MCP: araçlar ertelenmiş yüklenir** — init anında ajan araç listesinde görünmezler ve init'te sunucu durumu "pending" kalır; ajan ToolSearch ile bulup kullanır (canlı doğrulandı: ToolSearch → mcp__everything__echo). "pending" bağlantı hatası DEĞİLDİR. Ajan prompt'una MCP araç listesi + ToolSearch yönlendirmesi otomatik eklenir (agents.ts).
- **MCP Windows'ta**: npx tabanlı stdio sunucularını `{"command": "cmd", "args": ["/c", "npx", ...]}` olarak tanımla.
- **allowedTools sert bir sandbox değildir** — listede olmayan Bash bile izin sisteminden geçip çalışabildi (probe'da gözlendi). Güvenlik sınırı olarak görme; ajan davranışını asıl yönlendiren persona + izin listesi birlikte.
- **Node ≥ 20 şart** (şu an v24.18, 2026-07-06'da winget ile yükseltildi). Node 18'de Agent SDK `using` sözdizimi yüzünden "Object not disposable" hatası verir. Kullanıcının eski terminal oturumları hâlâ Node 18 görebilir.
- **zod ^4 olmalı** — claude-agent-sdk'nin peer bağımlılığı; zod 3 ile npm install ERESOLVE verir.
- **SSE ilk bayt**: /events bağlanınca hemen `: bagli\n\n` yazılmalı, yoksa boş geçmişte tarayıcı "bağlanıyor…"da takılır (yaşandı, düzeltildi). 25 sn'de bir heartbeat var.
- **EADDRINUSE :::4141** = zaten çalışan bir serve var; eskisini kapat veya --port değiştir.
- Kimlik: Claude Code oturumu yeterli (API key gerekmez). API key tanımlanırsa verdict yedeği messages.parse + API structured output kullanır.
- Ollama: config'de provider "ollama" + model zorunlu; buildAgentEnv ANTHROPIC_BASE_URL/AUTH_TOKEN/MODEL enjekte eder. Anthropic API uyumlu güncel Ollama sürümü gerekir.

## Test durumu

- Uçtan uca doğrulanmış (gerçek koşularla): tek görev modu, sunucu modu (2 ardışık görev), web'den onay, yapılandırılmış verdict yolu, ajanlar arası JSON aktarımı, hedef dizine yazım. Test hedefi: `D:\work\testapp` (basit todo uygulaması).
- Diff/kod-inceleme onayı: panel `renderDiff` before/after render'ı preview aracıyla doğrulandı (CSS özgüllük hatası bulunup düzeltildi); gerçek koşuda architect diff-şekilli plan üretti ve kullanıcı çalıştığını doğruladı.
- **Henüz gerçek koşuda görülmemiş**: reviewer RED → developer düzeltme döngüsü (tüm koşular ilk turda onaylandı), kullanıcı reddi (h + yorum) yolu, Ollama sağlayıcısı (bu makinede Ollama kurulu değil), şemasız-yeniden-deneme yolu (error_max_structured_output_retries yakalanınca).

## Açık işler (kaldığımız yer — 2026-07-08)

- **Commit edilmedi**: diff/kod-inceleme onayı değişiklikleri (architect.md, developer.md, events.ts, approval.ts, orchestrator.ts, ui/index.html) + yeni `.claude/launch.json`. Kullanıcı "çalışıyor" dedi; sıradaki adım büyük ihtimalle `git add -A && commit && push`.
- İstenmiş ama yapılmamış: developer sonrası isteğe bağlı ikinci insan-onay düğümü (yukarıda "A yolu" notu).
- `runs/` ve `node_modules/` .gitignore'da; `.claude/launch.json` commit'lenmeli mi kullanıcıya sorulabilir (preview'e özgü, zararsız).
