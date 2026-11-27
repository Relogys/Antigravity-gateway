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
  { name: "GitHub personal/app token", regex: /\b(?:gh[pousr]_[0-9A-Za-z]{30,}|github_pat_[0-9A-Za-z_]{30,})\b/g },
  { name: "AWS Access Key ID", regex: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: "Slack token", regex: /\b(?:xox[baprs]-[0-9]{8,}-[0-9A-Za-z-]+|xapp-\d-[A-Z0-9]+-\d+-[A-Za-z0-9]+)\b/g },
  { name: "Telegram Bot API token", regex: /\b\d{8,12}:AA[0-9A-Za-z_-]{33}\b/g },
  { name: "OpenAI / Anthropic style secret key", regex: /\bsk-(?:proj-|ant-)?[0-9A-Za-z_-]{32,}\b/g },
  { name: "Real Spectrum secret assignment", regex: /SPECTRUM_PROJECT_SECRET=(?!your-spectrum-project-secret|<|\s*$)\S+/g },
  { name: "Real Spectrum UUID assignment", regex: /SPECTRUM_PROJECT_ID=[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi },
];

function stripSurroundingQuotes(raw) {
  if (
    (raw.startsWith('"') && raw.endsWith('"')) ||
    (raw.startsWith("'") && raw.endsWith("'"))
  ) {
    return raw.slice(1, -1).trim();
  }
  return raw;
}

function isExampleDomain(hostname) {
  const lower = hostname.trim().toLowerCase().replace(/\.+$/, "");
  return (
    lower === "example.com" ||
    lower.endsWith(".example.com") ||
    lower === "example.org" ||
    lower.endsWith(".example.org")
  );
}

/**
 * True only when `value` is a genuine RFC 2606 placeholder URL, email, or host
 * (never matches substrings like `https://example.com.attacker.net`).
 */
function isPlaceholderDomainValue(value) {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      return isExampleDomain(parsed.hostname);
    } catch {
      return false;
    }
  }
  const atIdx = trimmed.lastIndexOf("@");
  if (atIdx > 0 && atIdx < trimmed.length - 1) {
    return isExampleDomain(trimmed.slice(atIdx + 1));
  }
  return isExampleDomain(trimmed);
}

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
  // Any credential-like or identity-like key in the local .env is scanned for literal leaks.
  const sensitivePattern =
    /(TOKEN|SECRET|API_KEY|AES_KEY|PASSWORD|CLIENT_ID|APP_ID|PROJECT_ID|CORP_ID|USER_ID|SELF_ID|PHONE_NUMBER_ID|BOT_EMAIL|ACCOUNT|ALLOWED_USERS|ALLOWED_SENDERS|WS_URL|CALLBACK_URL|WEBHOOK_URL|HOMESERVER_URL|BASE_URL|SITE)$/;
  const listKeys = /(ALLOWED_USERS|ALLOWED_SENDERS)$/;
  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = stripSurroundingQuotes(trimmed.slice(eqIdx + 1).trim());
    if (!sensitivePattern.test(key) || !val) continue;
    if (listKeys.test(key)) {
      for (const item of val.split(",")) {
        const token = stripSurroundingQuotes(item.trim());
        if (token.length >= 6 && !isPlaceholderDomainValue(token) && token !== "+15550001111") {
          literals.push({ key, token });
        }
      }
    } else if (
      val.length >= 8 &&
      !/^your-/i.test(val) &&
      !isPlaceholderDomainValue(val)
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
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) continue;
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
