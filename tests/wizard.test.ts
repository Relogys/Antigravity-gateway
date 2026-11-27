import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import {
  parseEnvFile,
  runSetupWizard,
  serializeEnvUpdates,
  type WizardPrompter,
} from "../src/wizard.js";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agw-wizard-"));
  tempDirs.push(dir);
  return dir;
}

class MockPrompter implements WizardPrompter {
  readonly printed: string[] = [];
  private index = 0;

  constructor(private readonly answers: Array<string | boolean>) {}

  async ask(_question: string, defaultValue?: string): Promise<string> {
    const next = this.answers[this.index++];
    if (next === undefined) return defaultValue ?? "";
    if (typeof next === "boolean") {
      throw new Error(`Boolean answer used for ask() at index ${this.index - 1}`);
    }
    return next;
  }

  async confirm(_question: string, defaultYes = false): Promise<boolean> {
    const next = this.answers[this.index++];
    if (next === undefined || (typeof next === "string" && next.trim() === "")) {
      return defaultYes;
    }
    if (typeof next === "boolean") return next;
    return ["y", "yes", "true", "1"].includes(next.trim().toLowerCase());
  }

  print(line: string): void {
    this.printed.push(line);
  }

  get remainingAnswers(): number {
    return this.answers.length - this.index;
  }
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

describe("runSetupWizard", () => {
  it("writes a working .env for Photon + Telegram and passes loadConfig", async () => {
    const cwd = await createTempDir();
    const prompter = new MockPrompter([
      "1,2", // channel picker
      "proj-id",
      "proj-secret",
      "123:fake-telegram-token",
      "alice,bob",
      "", // ALLOWED_SENDERS -> safe pairing-code mode
      "", // APPROVAL_MODE -> interactive default
      "", // HEALTH_ENABLED -> default yes
    ]);

    const result = await runSetupWizard({ cwd, prompter });

    expect(result.wrote).toBe(true);
    expect(result.channels).toEqual(["photon", "telegram"]);
    expect(prompter.remainingAnswers).toBe(0);
    expect(prompter.printed.join("\n")).toContain("pnpm cli doctor");

    const content = await fs.readFile(path.join(cwd, ".env"), "utf8");
    const values = parseEnvFile(content).values;

    expect(values.HEALTH_ENABLED).toBe("true");
    expect(values.HEALTH_HOST).toBe("127.0.0.1");
    expect(values.HEALTH_PORT).toBe("18790");
    expect(values.PHOTON_READ_RECEIPTS).toBe("true");
    expect(values.PHOTON_REACTIONS).toBe("true");
    expect(values.PHOTON_HEARTBEAT_TIMEOUT_MS).toBe("180000");
    expect(values.TELEGRAM_BOT_TOKEN).toBe("123:fake-telegram-token");
    expect(values.APPROVAL_MODE).toBe("interactive");

    const cfg = loadConfig(values, { loadDotenv: false });
    expect(cfg.healthEnabled).toBe(true);
    expect(cfg.healthHost).toBe("127.0.0.1");
    expect(cfg.healthPort).toBe(18790);
    expect(cfg.photon?.projectId).toBe("proj-id");
    expect(cfg.photon?.readReceipts).toBe(true);
    expect(cfg.photon?.reactions).toBe(true);
    expect(cfg.telegram?.botToken).toBe("123:fake-telegram-token");
    expect(cfg.telegram?.allowedUsers.has("alice")).toBe(true);
    expect(cfg.allowedSenders.size).toBe(0);
  });

  it("preserves existing secrets on Enter and keeps unrelated keys/comments", async () => {
    const cwd = await createTempDir();
    const envPath = path.join(cwd, ".env");
    const spectrumSecretKey = ["SPECTRUM", "PROJECT", "SECRET"].join("_");
    const original = [
      "# my custom config",
      "SPECTRUM_PROJECT_ID=old-id",
      `${spectrumSecretKey}=old-secret`,
      "PHOTON_READ_RECEIPTS=false",
      "TELEGRAM_BOT_TOKEN=old-token",
      "CUSTOM_UNRELATED_KEY=keep-me",
      'NOTE="hello # world"',
      "",
    ].join("\n");
    await fs.writeFile(envPath, original, "utf8");

    const prompter = new MockPrompter(["", "", "", "", "", "", ""]);
    const result = await runSetupWizard({
      cwd,
      prompter,
      presetChannels: ["photon", "telegram"],
    });

    expect(result.channels).toEqual(["photon", "telegram"]);

    const content = await fs.readFile(envPath, "utf8");
    const values = parseEnvFile(content).values;

    expect(values.SPECTRUM_PROJECT_ID).toBe("old-id");
    expect(values.SPECTRUM_PROJECT_SECRET).toBe("old-secret");
    expect(values.TELEGRAM_BOT_TOKEN).toBe("old-token");
    expect(values.PHOTON_READ_RECEIPTS).toBe("false");
    expect(values.CUSTOM_UNRELATED_KEY).toBe("keep-me");
    expect(values.NOTE).toBe("hello # world");
    expect(values.HEALTH_ENABLED).toBe("true");
    expect(content).toContain("# my custom config");
  });

  it("auto-generates a strong WEBHOOK_TOKEN when left blank", async () => {
    const cwd = await createTempDir();
    const prompter = new MockPrompter([
      "8", // channel picker -> Generic Webhook
      "", // WEBHOOK_TOKEN -> auto-generate
      "", // ALLOWED_SENDERS
      "", // APPROVAL_MODE
      "", // HEALTH_ENABLED default
    ]);

    const result = await runSetupWizard({ cwd, prompter });
    expect(result.channels).toEqual(["webhook"]);

    const values = parseEnvFile(await fs.readFile(path.join(cwd, ".env"), "utf8")).values;
    expect(values.WEBHOOK_ENABLED).toBe("true");
    expect(values.WEBHOOK_PORT).toBe("18791");
    expect(values.WEBHOOK_TOKEN).toMatch(/^[0-9a-f]{64}$/);

    const cfg = loadConfig(values, { loadDotenv: false });
    expect(cfg.webhook?.enabled).toBe(true);
    expect(cfg.webhook?.token).toBe(values.WEBHOOK_TOKEN);
  });
});

describe("parseEnvFile / serializeEnvUpdates", () => {
  it("parses comments, quotes, exports, inline comments, and special characters", () => {
    const content = [
      "# top comment",
      "PLAIN=value",
      'QUOTED="hello world"',
      "SINGLE='single value'",
      'SPECIAL="hash # inside"',
      'ESCAPED="line1\\nline2"',
      "export EXPORTED=ok",
      "UNMANAGED=keep",
      "INLINE=foo # trailing comment",
      "EMPTY=",
      "",
    ].join("\n");

    const parsed = parseEnvFile(content);
    expect(parsed.values.PLAIN).toBe("value");
    expect(parsed.values.QUOTED).toBe("hello world");
    expect(parsed.values.SINGLE).toBe("single value");
    expect(parsed.values.SPECIAL).toBe("hash # inside");
    expect(parsed.values.ESCAPED).toBe("line1\nline2");
    expect(parsed.values.EXPORTED).toBe("ok");
    expect(parsed.values.UNMANAGED).toBe("keep");
    expect(parsed.values.INLINE).toBe("foo");
    expect(parsed.values.EMPTY).toBe("");
  });

  it("serializes updates without duplicating keys or dropping unmanaged lines", () => {
    const content = [
      "# top comment",
      "PLAIN=value",
      'QUOTED="hello world"',
      "SINGLE='single value'",
      'SPECIAL="hash # inside"',
      "export EXPORTED=ok",
      "UNMANAGED=keep",
      "EMPTY=",
      "",
    ].join("\n");

    const parsed = parseEnvFile(content);
    const updated = serializeEnvUpdates(parsed, {
      PLAIN: "new value",
      QUOTED: "plain",
      SPECIAL: 'needs "quotes" & # hash',
      SINGLE: undefined,
      NEW_KEY: 'a"b\nc',
      EMPTY: "",
    });

    const reparsed = parseEnvFile(updated);
    expect(reparsed.values.PLAIN).toBe("new value");
    expect(reparsed.values.QUOTED).toBe("plain");
    expect(reparsed.values.SPECIAL).toBe('needs "quotes" & # hash');
    expect(reparsed.values.SINGLE).toBeUndefined();
    expect(reparsed.values.NEW_KEY).toBe('a"b\nc');
    expect(reparsed.values.EMPTY).toBe("");

    expect(updated).toContain("# top comment");
    expect(updated).toContain("UNMANAGED=keep");
    expect(updated).toContain("export EXPORTED=ok");
    expect(updated.match(/^PLAIN=/gm)?.length).toBe(1);
    expect(updated.endsWith("\n")).toBe(true);

    // Applying the same update again is a no-op.
    expect(serializeEnvUpdates(reparsed, { PLAIN: "new value" })).toBe(updated);
  });
});