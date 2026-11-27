import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isPidAlive, readPidFile } from "../src/cli.js";
import { RotatingFileLogger, redactSecrets, tailLogFile } from "../src/logger.js";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "agw-daemon-"));
  tempDirs.push(dir);
  return dir;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

describe("redactSecrets", () => {
  it("redacts bearer tokens", () => {
    const out = redactSecrets(
      "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc-def_123",
    );
    expect(out).toBe("Authorization: Bearer ***");
    expect(out).not.toContain("eyJhbGciOiJIUzI1NiJ9");
  });

  it("redacts Slack and Discord app tokens", () => {
    const fakeSlackBot = ["xoxb", "1234567890", "ABCDEFGHIJKL"].join("-");
    const fakeSlackApp = ["xapp", "1", "A0123", "456789", "abcdefabcdef"].join("-");
    expect(redactSecrets(`slack ${fakeSlackBot}`)).toBe("slack xoxb-***");
    expect(redactSecrets(`app ${fakeSlackApp}`)).toBe("app xapp-***");
  });

  it("redacts Telegram bot tokens", () => {
    const fakeTg = ["123456789", "AAH-abcdefghijklmnopqrstuvwxyz_12345"].join(":");
    const out = redactSecrets(`telegram bot ${fakeTg} ready`);
    expect(out).toBe("telegram bot *** ready");
    expect(out).not.toContain("AAH-abcdefghijklmnopqrstuvwxyz_12345");
  });

  it("redacts provider API keys", () => {
    const fakeSk = ["sk", "ABCdef0123456789xyz"].join("-");
    const fakeGoogle = ["AIza", "SyD-1234567890abcdefghijklmnop"].join("");
    const fakeArk = ["ark", "1234abcd", "efgh"].join("-");
    expect(redactSecrets(`key ${fakeSk}`)).toBe("key sk-***");
    expect(redactSecrets(`key ${fakeGoogle}`)).toBe("key AIza***");
    expect(redactSecrets(`key ${fakeArk}`)).toBe("key ark-***");
  });

  it("redacts Spectrum project secrets and token query params", () => {
    const spectrumKey = ["SPECTRUM", "PROJECT", "SECRET"].join("_");
    expect(redactSecrets(`${spectrumKey}=deadbeefcafe`)).toBe(
      `${spectrumKey}=***`,
    );
    expect(redactSecrets("GET /hook?token=supersecret&page=2")).toBe(
      "GET /hook?token=***&page=2",
    );
    expect(redactSecrets("password=hunter2 secret=s3cr3t")).toBe(
      "password=*** secret=***",
    );
  });

  it("preserves ordinary log text", () => {
    const normal =
      '[gateway] channel "telegram" connected in 12:30:45 (channels=telegram, allowlist=2) used 1500 tokens in 2.5s';
    expect(redactSecrets(normal)).toBe(normal);
  });

  it("does not over-redact identifiers that merely contain 'token'", () => {
    expect(redactSecrets("max_tokens=4096")).toBe("max_tokens=4096");
  });
});

describe("RotatingFileLogger", () => {
  it("creates parent directories and writes timestamped, redacted lines", async () => {
    const dir = await createTempDir();
    const logFile = path.join(dir, "nested", "logs", "gateway.log");
    const logger = new RotatingFileLogger({ logFile, maxBytes: 1024 * 1024 });

    logger.write("info", "hello gateway");
    logger.write("error", "Authorization: Bearer secret-token-abcdef123456");

    const content = fs.readFileSync(logFile, "utf8");
    expect(content).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \[INFO\] hello gateway$/m,
    );
    expect(content).toContain("[ERROR] Authorization: Bearer ***");
    expect(content).not.toContain("secret-token-abcdef123456");
  });

  it("rotates when maxBytes is exceeded and keeps at most maxFiles backups", async () => {
    const dir = await createTempDir();
    const logFile = path.join(dir, "logs", "gateway.log");
    const logger = new RotatingFileLogger({
      logFile,
      maxBytes: 200,
      maxFiles: 2,
    });

    for (let i = 0; i < 50; i += 1) {
      logger.write("info", `line ${String(i).padStart(3, "0")} payload-data-payload-data`);
    }

    expect(fs.existsSync(logFile)).toBe(true);
    expect(fs.existsSync(`${logFile}.1`)).toBe(true);
    expect(fs.existsSync(`${logFile}.2`)).toBe(true);
    expect(fs.existsSync(`${logFile}.3`)).toBe(false);

    const current = fs.readFileSync(logFile, "utf8");
    expect(current).toContain("line 049");
    expect(Buffer.byteLength(current, "utf8")).toBeLessThanOrEqual(200);
    for (const backup of [`${logFile}.1`, `${logFile}.2`]) {
      const size = Buffer.byteLength(fs.readFileSync(backup, "utf8"), "utf8");
      expect(size).toBeLessThanOrEqual(200);
    }
  });
});

describe("tailLogFile", () => {
  it("returns the last N lines without a trailing blank line", async () => {
    const dir = await createTempDir();
    const file = path.join(dir, "tail.log");
    fs.writeFileSync(file, "a\nb\nc\nd\ne\n");

    expect(tailLogFile(file, 2)).toBe("d\ne");
    expect(tailLogFile(file, 10)).toBe("a\nb\nc\nd\ne");
    expect(tailLogFile(file)).toBe("a\nb\nc\nd\ne");
  });

  it("normalizes CRLF line endings", async () => {
    const dir = await createTempDir();
    const file = path.join(dir, "crlf.log");
    fs.writeFileSync(file, "x\r\ny\r\nz\r\n");
    expect(tailLogFile(file, 2)).toBe("y\nz");
  });

  it("handles missing and empty files without throwing", async () => {
    const dir = await createTempDir();
    expect(tailLogFile(path.join(dir, "missing.log"), 5)).toBe("");

    const empty = path.join(dir, "empty.log");
    fs.writeFileSync(empty, "");
    expect(tailLogFile(empty, 5)).toBe("");
  });
});

describe("readPidFile / isPidAlive", () => {
  it("returns null for missing, malformed, and non-positive pid files", async () => {
    const dir = await createTempDir();
    const pidFile = path.join(dir, "gateway.pid");

    expect(readPidFile(pidFile)).toBeNull();

    for (const raw of ["not-a-pid", "12abc", "", "-5", "0"]) {
      fs.writeFileSync(pidFile, raw);
      expect(readPidFile(pidFile)).toBeNull();
    }
  });

  it("reads a valid pid and tolerates surrounding whitespace", async () => {
    const dir = await createTempDir();
    const pidFile = path.join(dir, "gateway.pid");
    fs.writeFileSync(pidFile, ` ${process.pid}\n`);
    expect(readPidFile(pidFile)).toBe(process.pid);
  });

  it("reports the current process as alive and rejects invalid pids", () => {
    expect(isPidAlive(process.pid)).toBe(true);
    expect(isPidAlive(0)).toBe(false);
    expect(isPidAlive(-1)).toBe(false);
    expect(isPidAlive(Number.NaN)).toBe(false);
    expect(isPidAlive(1.5)).toBe(false);
  });

  it("reports an exited child process as dead", async () => {
    const child = spawn(process.execPath, ["-e", "process.exit(0)"], {
      stdio: "ignore",
    });
    const childPid = child.pid;
    expect(typeof childPid).toBe("number");
    await once(child, "close");
    await delay(150);
    expect(isPidAlive(childPid!)).toBe(false);
  });
});