#!/usr/bin/env node
// Kurmay komutu (npm paketi):
//   kurmay init [klasör]   çalışma klasörünü hazırlar: config.json + .claude/ (personalar, kurallar, beceriler, hook'lar)
//   kurmay serve           paneli açar (sunucu modu) — "kurmay" tek başına da aynı
//   kurmay "görev"         tek görev modu
// Ayar, personalar ve koşu kayıtları (runs/) komutun çalıştırıldığı klasörde durur; paket klasörüne yazılmaz.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const paket = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);

if (args[0] === "init") {
  init(path.resolve(args[1] ?? "."));
} else if (args[0] === "--version" || args[0] === "-v") {
  console.log(JSON.parse(fs.readFileSync(path.join(paket, "package.json"), "utf8")).version);
} else {
  // "serve" yalnızca okunaklılık için — orkestratör görev verilmezse zaten sunucu modunda açılır
  if (args[0] === "serve") process.argv.splice(2, 1);
  if (!args.includes("--config") && !fs.existsSync("config.json")) {
    console.error("Bu klasörde config.json yok. Önce çalışma klasörünü hazırla:\n  kurmay init\n(ya da --config ile ayar dosyasının yolunu ver)");
    process.exit(1);
  }
  await import(pathToFileURL(path.join(paket, "dist", "index.js")).href);
}

/** Paketteki şablonu hedef klasöre kopyalar; var olan dosyaların üstüne yazmaz */
function init(hedef) {
  fs.mkdirSync(hedef, { recursive: true });
  const yazildi = [];
  const atlandi = [];
  for (const alt of ["agents", "rules", "skills", "hooks"]) {
    const kaynak = path.join(paket, ".claude", alt);
    if (!fs.existsSync(kaynak)) continue;
    for (const dosya of dosyalar(kaynak)) {
      const goreli = path.join(".claude", alt, path.relative(kaynak, dosya));
      const hedefDosya = path.join(hedef, goreli);
      if (fs.existsSync(hedefDosya)) {
        atlandi.push(goreli);
        continue;
      }
      fs.mkdirSync(path.dirname(hedefDosya), { recursive: true });
      fs.copyFileSync(dosya, hedefDosya);
      yazildi.push(goreli);
    }
  }
  const cfgHedef = path.join(hedef, "config.json");
  if (fs.existsSync(cfgHedef)) {
    atlandi.push("config.json");
  } else {
    // Paketteki ayar şablon olarak kullanılır; makineye özel hedef dizin boşaltılır
    const cfg = JSON.parse(fs.readFileSync(path.join(paket, "config.json"), "utf8"));
    cfg.targetDir = "";
    fs.writeFileSync(cfgHedef, JSON.stringify(cfg, null, 2) + "\n");
    yazildi.push("config.json");
  }
  console.log(`Çalışma klasörü: ${hedef}`);
  if (yazildi.length) console.log(`  oluşturuldu: ${yazildi.length} dosya (config.json, .claude/…)`);
  if (atlandi.length) console.log(`  zaten vardı, dokunulmadı: ${atlandi.join(", ")}`);
  console.log(
    "\nSıradaki adım: config.json'da sağlayıcıyı ayarla (sunucu adresi, model, model listesi adresi, hedef dizin)" +
      "\nya da paneli aç ve ⚙ Ayarlar sayfasından gir:\n  kurmay serve",
  );
}

function* dosyalar(klasor) {
  for (const girdi of fs.readdirSync(klasor, { withFileTypes: true })) {
    const tam = path.join(klasor, girdi.name);
    if (girdi.isDirectory()) yield* dosyalar(tam);
    else yield tam;
  }
}
