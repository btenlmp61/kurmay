# alpai-orchestrator

Md dosyalarıyla tanımlı ajanları (architect → developer ⇄ reviewer) deterministik bir iş akışıyla koordine eden TypeScript orkestratörü. Temel ilke: **kontrol akışı kodda, personalar md'de, tüm ayarlar tek config.json'da.** Ajan geçişleri asla modelin talimat hatırlamasına bırakılmaz. Graf artık düz bir hattan fazlası: **koşullu dallanma (routes/verdict), LLM olmayan komut/build düğümleri, zamanlanmış onay, iptal, oturum sürdürme (resume) ve görsel config editörü** var.

## Komutlar

```sh
npm start -- "görev"     # tek görev modu: çalıştırır ve çıkar
npm run serve            # sunucu modu: panel açılır, görevler panelden girilir, servis açık kalır
npm run typecheck        # tsc --noEmit
```

Bayraklar: `--config <dosya>`, `--cwd <hedef dizin>`, `--port <n>`, `--no-ui`. Örnek configler: `config.microservices.example.json` (build düğümlü, çok-repo), `config.hooks.example.json` (hook'lu).

## Mimari

| Dosya | Sorumluluk |
|---|---|
| `config.json` | TEK config: sağlayıcı, targetDir, uiPort, mcpServers, **limits** (maliyet/süre sınırları → env) ve workflow grafı (agent + command düğümleri, per-agent hooks). Boş string ("") tanımsız sayılır |
| `.claude/agents/*.md` | Ajan personaları (system prompt) + frontmatter `output:` şeması. İçlerinde "X'i çağır" YOK — geçişler orkestratörün işi |
| `.claude/rules/*.md` | Her zaman geçerli kısıtlar; config'de `rules: [...]` ile bağlanır, tam içerik system prompt'a gömülür |
| `.claude/skills/<ad>/SKILL.md` | Beceriler (progressive disclosure): prompt'a ad+açıklama+yol girer, ajan Read ile okur; `inline:true` tamamını gömer |
| `.claude/hooks/*.js` | Komut-hook script'leri (ör. `guard-bash.js`: tehlikeli Bash'i engeller). config'te `hooks: [{event, matcher, command}]` ile ajana bağlanır |
| `src/orchestrator.ts` | Graf motoru: onay duraklaması, **routes** dallanması, **verdict** dallanması, reject döngüsü (maxCycles), **command düğümü** (build), **zamanlama**, **iptal**, **resume** (entry ajan) |
| `src/runAgent.ts` | Agent SDK `query()` sarmalayıcısı: systemPrompt preset+append, allowedTools, outputFormat; ayrıca **abortController** (iptal), **resume** (session_id yakalar + resume seçeneği), **hooks**, **ölçüm** (result mesajından süre/tur/token → `AgentMetrics`) |
| `src/build.ts` | Command düğümü mantığı: değişen dosyalardan repoları otomatik bulur, parent (varsa) önce, `mvn spotless...` değil `command` çalıştırır; exit-code kapısı, ilk hata → onFailure |
| `src/hooks.ts` | Config'teki komut-hook'ları SDK `hooks` yapısına derler (`buildHooks`); `commandHook` komutu spawn edip çıkışı yorumlar |
| `src/sessions.ts` | İsimli architect oturum kataloğu (`runs/sessions.json`): `{id,name,createdAt,updatedAt}`; resume için UUID tutar (konuşma SDK'de) |
| `src/approval.ts` | Onay yarışı (terminal/web); ayrıca **zamanlama** (`runAt`, waitForScheduledTime) ve **iptal sinyali** (RunCancelledError) |
| `src/verdict.ts` | YEDEK: reviewer kararı structured gelmezse metinden çıkarır |
| `src/events.ts` | EventBus: tüm adımlar tipli olay; terminal/panel/JSONL dinler. Yeni olaylar: build_*, run_scheduled/resumed, workflow_cancelled, workflow_started.resumed |
| `src/server.ts` | Node http (bağımlılıksız). Uçlar: GET `/`,`/events`(SSE),`/config`,`/config-data`,`/sessions`; POST `/task`,`/approval`,`/schedule`,`/cancel`,`/session-delete`,`/agent-md`,`/config` |
| `ui/index.html` | İzleme paneli: sol **oturum sidebar'ı** (isimli, seç→resume, × sil; **varsayılan kapalı**), ajan hattı, olay akışı, onay+diff kartı (**before/after yan yana**, değişen kelimeler `markChanged` ile vurgulu), **zamanlama kartı+geri sayım**, **build kartı**, **Durdur**, ⚙ Config bağlantısı. Kütüphanesiz, koyu-mod |
| `ui/config.html` | **Config editörü** (`/config`): SVG iş-akışı grafı + düğüm özellik/kenar düzenleme + düğüm ekle/sil + doğrulamalı kaydetme |
| `src/config.ts` / `src/agents.ts` | Config yükleme+doğrulama; graf düğümlerini/kuralları/becerileri yükler, kenarları doğrular |
| `.claude/launch.json` | Preview: `alpai-serve` (port 4141) |
| `runs/*.jsonl`, `runs/sessions.json` | Koşu olay kaydı + oturum kataloğu (ikisi de .gitignore'da) |

## İş akışı grafı: düğümler ve geçişler

- **Ajan düğümü** (varsayılan): `file`(persona md), `tools`, `rules`, `skills`, `model`, `requiresUserApproval`, `hooks`. Geçiş için **tam olarak biri**: `next` (koşulsuz) VEYA `verdict` (reviewer kararı → onApprove/onReject) VEYA `routes` (structured çıktı alanına göre dallan). (agents.ts bunu doğrular.)
- **routes**: `{field, cases:{deger→hedef}, default}`. architect'in `route` alanı: `developer` → developer, `done` → null (akış biter). **route akışı bitirecekse onay da atlanır** (boş planı onaylatmaz).
- **Command düğümü** (`type:"command"`): LLM değil, deterministik build adımı. `{command, parent?:{path,command?}, onSuccess, onFailure}`. build.ts: developer'ın `changes[].file`'lerinden değişen repoları çıkarır (dosyanın targetDir altındaki en üst klasörü = repo), `parent` değişmişse önce onu build eder, sonra değişen servisleri; exit code'a göre onSuccess/onFailure (hata → developer'a log geri bildirimiyle döner). Modül listesi TUTULMAZ (otomatik).
- **entry**: başlangıç düğümü. Değiştirmek o adımdan başlatır (ör. planlamayı atlamak için `entry:"developer"`); DİKKAT: architect'e bağlı onay, route ve **resume/oturum da entry'ye bağlıdır** — entry=developer yaparsan resume architect'in değil developer'ın oturumunu sürdürür.

## Yapılandırılmış ajan iletişimi

- Çıktı şeması ajanın md frontmatter'ında (`output:`). Verdict düğümü yerleşik `reviewVerdictJsonSchema()` kullanır.
- Ajanlar birbirine şemalı JSON aktarır (buildPrompt ```json bloğu); panelde diff kartı olarak görünür.
- Şemalar: architect `{summary, assumptions[], file_plan[{path,action,summary,changes[{location,before,after,rationale}]}], route}` (**`technical_decisions`/`steps`/`risks` KALDIRILDI** — panelde hiç gösterilmiyordu, sadece katlı "Ham JSON"da duruyordu; `before` artık tam blok değil 2-3 satırlık çapa. `assumptions` KALDI: architect'in "soru sorma, varsayımı belirt" kuralının tek çıkış kapısı, atılırsa sessizce tahmin eder); developer `{changes[{file,action,summary}], deviations[], verification}` (**kod çıktıya tekrar yazılmaz** — token/decode maliyeti; reviewer diski okur, `changes` sadece "hangi dosyaya bak" işaretçisi); reviewer `{approved, issues[], summary}`.

## Zamanlama, iptal, resume, oturumlar

- **Zamanlama**: architect onaylanırken ileri tarih/saat verilebilir (panelde datetime-local picker + preset + geri sayım; terminalde `+30m`/`2026-07-10 14:00`). Orchestrator o zamana kadar bekler; bekleme sırasında panelden "şimdi çalıştır" / "iptal" edilebilir. Bellekte, serve moduna özgü.
- **İptal**: panelde **Durdur** → koşuya özel AbortController → SDK alttaki Claude Code sürecini öldürür → `RunCancelledError` → `workflow_cancelled` → panel başlangıç durumuna döner. Onay ve zamanlama beklemesinde de çalışır (POST /cancel).
- **Resume**: **entry ajan (architect)** oturumu sürdürülür. runAgent success sonucundan `session_id` yakalar; POST /task `resumeSessionId` ile o oturum `query({options:{resume}})` ile sürdürülür. Konuşma SDK'de (`~/.claude/projects/`); biz UUID'yi `runs/sessions.json`'da (SessionStore) tutarız. **resume'da session_id sabit kalır (forkSession yok) → katalog çoğalmaz.** Tek görev modu hep taze.
- **Oturum listesi**: panel sol sidebar — isimli oturumlar (ilk görevden türetilir), tıkla→sonraki görev o oturumu sürdürür, **×** ile katalogdan sil (POST /session-delete; konuşma diskte kalır).
- **Resume panel sürekliliği**: resume'lu koşuda panel olay akışı TEMİZLENMEZ (`workflow_started.resumed`; index.ts `bus.reset()` atlanır) — araya "aynı oturumda yeni görev" ayracı eklenir. (Hafıza zaten korunuyordu; bu, panelin göstermesini sağlar.)

## Config editörü (`/config`)

- `ui/config.html`: SVG iş-akışı grafı (düğüm+tipli kenar: gri=next, mavi=route, yeşil=onay/başarılı, kırmızı=red/hata; paralel kenarlar birleştirilir, geri-döngü alttan kavisle). Düğüme tıkla → sağda özellik paneli (her alanın açıklamasıyla).
- **Düzenleme**: tools/rules/skills chip, requiresUserApproval, model, command düğümünde parent, geçişler dropdown'la, targetDir metin, entry dropdown; **düğüm ekle** (command / mevcut-md ajan / yeni persona — POST /agent-md şablon .md oluşturur) / **sil** (entry silinemez, dangling kenarlar temizlenir).
- **Kaydet** → POST /config → `loadAppConfig`+`loadAgents` ile doğrular; geçersizse eski içeriği geri yükler (**config bozulamaz**). Değişiklik serve **restart** ister (config açılışta okunur).
- Sınırlar: topoloji dropdown'la (sürükle-bağla yok); persona .md içeriği salt-okunur; hook'lar editörde henüz görünmüyor.

## Hook'lar

- Ajana config'ten **komut-hook**: `"hooks":[{event, matcher?, command, timeout?}]`. src/hooks.ts bunları SDK `hooks`'a derler; runAgent query options'a bağlar (ajanın cwd'sinde çalışır).
- **Sözleşme** (Claude Code semantiği): hook girdisi (tool_name, tool_input, session_id...) stdin'e JSON gelir. `exit 2` = aracı ENGELLE (stderr = modele giden gerekçe); `exit 0` = izin (stdout geçerli JSON ise doğrudan hook çıktısı olarak aktarılır — additionalContext/permissionDecision vb.); diğer çıkış = engellemeyen uyarı.
- Olaylar: PreToolUse, PostToolUse, UserPromptSubmit, Stop, SubagentStop, PreCompact... (**PreToolUse Bash engelleme** ve **Stop tetikleme** canlı doğrulandı.)
- `.claude/hooks/guard-bash.js`: PreToolUse Bash guard (rm -rf/mkfs/shutdown... engeller). `config.hooks.example.json` örnek.
- **Java format = C yolu (hook DEĞİL)**: `spotless-maven-plugin` pom'da (`googleJavaFormat` + `<style>AOSP</style>`, `apply` goal'ü `process-sources` fazına bağlı). `build` düğümü `mvn` çalıştırınca format ekstra çağrı olmadan otomatik olur. `testapp/backend/pom.xml`'e eklenip AOSP 4-boşluğun diske yansıdığı doğrulandı. (B yolu — Stop hook record+apply — denendi; C daha temiz olduğu için tercih edildi, java-format hook'ları kaldırıldı.)

## Kritik bilinenler (tekrar keşfetme)

- **Yerel model (Qwen) = decode maliyeti**: input paralel işlenir, output token-token üretilir → şemayı büyütmek doğrudan wall-clock'a yazılır. Kodu structured output'a TEKRAR yazdırma; `targetDir` (`D:\work\testapp`) **git deposu DEĞİL** → "diff'i git'ten alırız" yolu kapalı. Panelde `renderDiff` hunks boşsa dosya listesine düşer (bilinçli).
- **Ölçüm var artık — ama iki alanı YANLIŞ OKUMA**: `agent_finished.metrics` (SDK result mesajından; terminalde ve panelde ajan satırının altında). (1) **`turns` şema retry'ını izole ETMEZ** — araç çağıran ajan zaten çok turludur, retry'lar da aynı sayıya karışır; "7 tur = 7 retry" DEĞİL. (2) **`perModel[].inputTokens` koşu boyunca TOPLAMDIR**, anlık context değil — `contextWindow`'a bölüp "%doluluk" çıkarma, çok turlu koşuda %100'ü aşar. `perModel`'de birden fazla model görünürse arka planda ikinci model (SMALL_FAST) çalışıyor demektir — ilk turdaki o soru ancak böyle cevaplanır.
- **SDK env sınırları** (kurulu pakette `grep`'le doğrulandı, tahmin değil): `MAX_STRUCTURED_OUTPUT_RETRIES` **varsayılan 5** — her deneme TÜM structured output'un baştan üretilmesi, yavaş modeldeki "bazen çok geç" sıçraması bu; `API_TIMEOUT_MS` **varsayılan 600000 (10 dk)** — yani timeout VAR (bizim kodda yok, SDK'de var); yavaş modelde büyük çıktı bunu aşabilir → API error'ın sebebi buysa değer YÜKSELTİLİR. Ayrıca `CLAUDE_CODE_MAX_OUTPUT_TOKENS`, `MAX_MCP_OUTPUT_TOKENS`, `MAX_THINKING_TOKENS`, `CLAUDE_CODE_MAX_CONTEXT_TOKENS`. Hepsi config'te `limits` altından geçer (`buildAgentEnv`).
- **`DISABLE_NON_ESSENTIAL_MODEL_CALLS` diye bir env YOK** — SDK'de sıfır sonuç. Benzeyen `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` model çağrısı değil **telemetri** kapatır. Arka plan model çağrılarını kısan bir bayrak bulunamadı.
- **JSON şemasına `$schema` başlığı KOYMA** — Agent SDK `outputFormat`'ı sessizce bozar (`success` ama boş `structured_output`). `z.toJSONSchema` ekliyor; `reviewVerdictJsonSchema()` siliyor.
- **`outputFormat` ile `maxTurns:1` kullanma** — şema düzeltme turuna alan kalmaz.
- **Şema alan adları/enum değerleri İngilizce/ASCII** — Türkçe enum retry tüketip `error_max_structured_output_retries` üretir. create/modify/delete, developer/done güvenli. İçerik Türkçe kalır.
- **Structured output'un İKİ bozulma şekli yakalanıyor** (runAgent): retry-bitti → şemasız bir kez yeniden; sessiz bozulma → metinle ilerle. verdict.ts metinden çıkarma yedeği devrede.
- **PowerShell ile Türkçe içerikli dosyada metin değiştirme YAPMA** — PS 5.1 Get-Content UTF-8'i ANSI okur, mojibake olur. **Edit/Write** aracını kullan.
- **Resume entry ajanını takip eder** (`workflow.entry`). entry=developer yaparsan planlama+onay+route atlanır VE resume/oturum developer'a bağlanır (architect değil).
- **Hook script'inde `process.exit()` stdout/stderr'i budayabilir** → doğal çıkış (return) tercih et. Windows'ta hook file_path SDK'den `C:\...` gelir; testte unix-stil `/c/...` node'da çözülmez → `cygpath -m`.
- **google-java-format JDK 11'de "illegal reflective access" uyarısı verir** — zararsız (exit 0). spotless-maven-plugin 2.43.0 + gjf 1.22.0 JDK 11'de çalışıyor.
- **MCP: araçlar ertelenmiş yüklenir** — init'te "pending" görünür (hata değil). Ajan ToolSearch ile bulur; prompt'a MCP listesi+yönlendirme otomatik eklenir (agents.ts). Windows'ta stdio sunucusu: `{"command":"cmd","args":["/c","npx",...]}`.
- **allowedTools sert sandbox değildir** — listede olmayan Bash bile çalışabildi. Asıl sınır: persona + izin listesi + hook'lar (PreToolUse guard).
- **Node ≥ 20 şart** (v24.18). **zod ^4** (peer). **SSE**: /events'te hemen `: bagli\n\n`; 25 sn heartbeat. **EADDRINUSE :::4141** = zaten çalışan serve var.
- **Kimlik**: Claude Code oturumu yeterli (API key gerekmez). **Ollama**: provider "ollama" + model zorunlu (buildAgentEnv env enjekte eder).
- **Bu ortamda preview screenshot takılıyor** → panel doğrulamasını DOM/JS (read_page/javascript) ile yap.

## Test durumu

- **Canlı doğrulanmış**: tek görev + serve modu; web'den onay; verdict yolu; ajanlar arası JSON; **routes** (route=done → developer atlandı, akış bitti); **zamanlama** (backend+panel); **iptal** (architect çalışırken kesildi, idle'a döndü); **resume** (anahtar kelime taşındı, katalog çoğalmadı); **oturum listesi+sil**; **config editörü** (graf render, özellik/kenar düzenleme, düğüm ekle/sil+yeni persona, geçersiz kaydı reddedip geri alma); **hook** (PreToolUse Bash engelleme + Stop tetikleme); **java format C** (mvn spotless AOSP 4-boşluk diske yansıdı).
- **build düğümü**: sentetik (`exit 0/1`, sahte repolar) ile doğrulandı — sıra, exit-code kapısı, hata→durma. **Gerçek mvn ile uçtan uca DEĞİL** (testapp maven ama aktif akışta build düğümü yok).
- **Henüz gerçek koşuda görülmemiş**: reviewer RED → developer düzeltme döngüsü, kullanıcı reddi (h+yorum) yolu, Ollama, şemasız-yeniden-deneme, build düğümünün gerçek Java projesinde uçtan uca çalışması.

## Açık işler (kaldığımız yer — 2026-07-16)

- **Working tree KİRLİ — maliyet/panel oturumu commit edilmedi**: şema küçültme (developer `hunks` kaldırıldı, architect `technical_decisions`/`steps`/`risks` kaldırıldı, `before` → çapa), `limits` (config→env), **ölçüm** (`AgentMetrics`), panel (geniş yerleşim, oturum sidebar'ı varsayılan kapalı, before/after yan yana + `markChanged` kelime vurgusu). Son commit hâlâ `fb0bbdf md updated.`
- **HANGİ CONFIG?** Repodaki üç config'in de `provider=anthropic`, `baseUrl=""` — hiçbiri yerele yönlenmiyor. Kullanıcı Qwen ile çalıştığını söylüyor → ya `--config` ile repo dışı bir dosya, ya ortamdan `ANTHROPIC_BASE_URL`. **`limits` `config.json`'a yazıldı; gerçekte kullanılan config o değilse ayar ulaşmıyor.** Doğrulanmadı.
- **Bu oturumun kazançları ÖLÇÜLMEDİ** — şema küçültme ve `limits` tahminle yapıldı; `structuredOutputRetries:2` ve `apiTimeoutMs:30dk` makul başlangıç, kanıt değil. Artık ölçüm var: ilk gerçek koşuda bak.
- **Aktif `config.json`**: architect(routes) → developer → reviewer; `jetbrains-index-mcp-server` (mcpServers) + `arama` kuralı (semantik arama tercihi, Grep/Glob fallback); **build düğümü YOK**.
- **Örnekler**: `config.microservices.example.json` (build düğümlü çok-repo; parent=common-events), `config.hooks.example.json` (guard-bash PreToolUse hook'u).
- **Ayrı repo**: `testapp/backend/pom.xml`'e spotless (AOSP, process-sources) eklendi — java format C demosu (alpai reposu dışı).
- **Olası sıradaki adımlar**: (1) build düğümünü gerçek bir Java projesinde uçtan uca test (RED döngüsü + resume ile birlikte); (2) config editörüne hook düzenleme ekle; (3) reviewer RED→developer döngüsü / kullanıcı reddi / Ollama yollarını gerçek koşuda gör; (4) resume: bellekten dosyaya kalıcı katalog zaten var, "developer text çıktı verirse build boş kalır" gibi kenar durumlar için güvenlik ağı.
