import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const FORBIDDEN_PATTERNS = [
  { name: "Windows personal user path (backslash)", regex: /[A-Za-z]:\\Users\\(?!example|user|username|<)[A-Za-z0-9._-]+/gi },
  { name: "Windows personal user path (slash)", regex: /[A-Za-z]:\/Users\/(?!example|user|username|<)[A-Za-z0-9._-]+/gi },
  { name: "Hermes reference path", regex: /E:[\\/]Hermes/gi },
  { name: "Local Antigravity workspace path", regex: /E:[\\/]Antigravity/gi },
  { name: "Google AI API key", regex: /AIza[0-9A-Za-z_-]{30,}/g },
  { name: "Private key block", regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { name: "Real Spectrum secret assignment", regex: /SPECTRUM_PROJECT_SECRET=(?!your-spectrum-project-secret|<|\s*$)\S+/g },
  { name: "Real Spectrum UUID assignment", regex: /SPECTRUM_PROJECT_ID=[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi },
];

/**
 * If a local `.env` exists, collect its real secret/PII values in memory (never printed)
 * so we also catch accidental literal leaks anywhere in trackable files.
 */
function loadLocalEnvLiterals(repoRoot) {
  const envPath = path.join(repoRoot, ".env");
  if (!fs.existsSync(envPath)) {
    return [];
  }
  const literals = [];
  const sensitiveKeys = new Set([
    "SPECTRUM_PROJECT_ID",
    "SPECTRUM_PROJECT_SECRET",
    "GEMINI_API_KEY",
    "ALLOWED_SENDERS",
  ]);
  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    if (!sensitiveKeys.has(key) || !val) continue;
    if (key === "ALLOWED_SENDERS") {
      for (const item of val.split(",")) {
        const token = item.trim();
        if (token.length >= 6 && !token.includes("example.com") && token !== "+15550001111") {
          literals.push({ key, token });
        }
      }
    } else if (
      val.length >= 8 &&
      val !== "your-spectrum-project-id" &&
      val !== "your-spectrum-project-secret"
    ) {
      literals.push({ key, token: val });
    }
  }
  return literals;
}

const filesRaw = execSync("git ls-files --cached --others --exclude-standard", { encoding: "utf8" });
const files = filesRaw.split(/\r?\n/).filter(Boolean);
const localLiterals = loadLocalEnvLiterals(process.cwd());

let violations = 0;

for (const file of files) {
  if (file === "scripts/audit-secrets.mjs") continue;
  if (file === ".env" || (file.startsWith(".env.") && file !== ".env.example")) {
    console.error(`[FAIL] Secret env file is tracked in git: ${file}`);
    violations++;
    continue;
  }
  if (!fs.existsSync(file)) continue;
  const content = fs.readFileSync(file, "utf8");
  for (const { name, regex } of FORBIDDEN_PATTERNS) {
    regex.lastIndex = 0;
    const match = regex.exec(content);
    if (match) {
      console.error(`[FAIL] ${file}: matched ${name} (${match[0].slice(0, 24)}...)`);
      violations++;
    }
  }
  for (const { key, token } of localLiterals) {
    if (content.includes(token)) {
      console.error(`[FAIL] ${file}: leaked literal value from local .env (${key})`);
      violations++;
    }
  }
}

if (violations > 0) {
  console.error(`\nSecret audit failed with ${violations} violation(s).`);
  process.exit(1);
}

console.log(`Secret audit passed across ${files.length} tracked file(s).`);
