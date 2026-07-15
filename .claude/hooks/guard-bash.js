// PreToolUse Bash hook'u: tehlikeli kabuk komutlarını engeller.
// Hook girdisi (tool_name, tool_input, ...) stdin'e JSON olarak gelir.
// Tehlikeli komutta `exit 2` → araç engellenir (stderr = modele giden gerekçe).
// Aksi halde `exit 0` → izin verilir.
let raw = "";
process.stdin.on("data", (d) => (raw += d));
process.stdin.on("end", () => {
  let cmd = "";
  try {
    cmd = ((JSON.parse(raw).tool_input || {}).command || "").toString();
  } catch {
    /* girdi okunamazsa engelleme */
  }
  const dangerous = /\brm\s+-rf\b|\bmkfs\b|\bshutdown\b|\breboot\b|\bdd\s+if=|>\s*\/dev\/sd|:\(\)\s*\{/i;
  if (dangerous.test(cmd)) {
    process.stderr.write(`Tehlikeli komut engellendi: ${cmd.slice(0, 200)}`);
    process.exit(2);
  }
  process.exit(0);
});
