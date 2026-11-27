import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { QQBotChannelAdapter } from "../src/channels/qqbot.js";
import { verifyTeamsHmac } from "../src/channels/teams.js";
import { extractAuthSchemeToken } from "../src/channels/utils.js";
import { loadConfig } from "../src/config.js";
import { HealthServer } from "../src/health.js";
import type { HealthSnapshot } from "../src/types.js";

const servers: HealthServer[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  while (servers.length > 0) {
    const s = servers.pop();
    if (s) await s.stop();
  }
  while (tempDirs.length > 0) {
    const d = tempDirs.pop();
    if (d) fs.rmSync(d, { recursive: true, force: true });
  }
});

describe("Wave 14 CodeQL security remediations", () => {
  it("parses Bearer and HMAC headers in strict O(n) linear time without ReDoS", () => {
    expect(extractAuthSchemeToken("Bearer abc123", "Bearer")).toBe("abc123");
    expect(extractAuthSchemeToken("  bearer\t  tok-9  ", "Bearer")).toBe("tok-9");
    expect(extractAuthSchemeToken(["HMAC Zm9v"], "HMAC")).toBe("Zm9v");
    expect(extractAuthSchemeToken("Bearerabc", "Bearer")).toBeUndefined();
    expect(extractAuthSchemeToken("Bearer    ", "Bearer")).toBeUndefined();
    expect(extractAuthSchemeToken("Basic abc", "Bearer")).toBeUndefined();
    expect(extractAuthSchemeToken(undefined, "Bearer")).toBeUndefined();

    // Adversarial 100k-whitespace header that would trigger O(N^2) backtracking on /^Bearer\s+(.+)$/i
    const adversarial = `Bearer ${" ".repeat(100_000)}`;
    const start = performance.now();
    expect(extractAuthSchemeToken(adversarial, "Bearer")).toBeUndefined();
    expect(verifyTeamsHmac(Buffer.from("secret").toString("base64"), Buffer.from("{}"), `HMAC ${" ".repeat(100_000)}`)).toBe(false);
    expect(performance.now() - start).toBeLessThan(200);
  });

  it("clamps remote QQBot heartbeat_interval to safe finite bounds [1s, 300s]", async () => {
    const recordedDelays: number[] = [];
    const cfg = loadConfig(
      {
        QQBOT_APP_ID: "10001",
        QQBOT_CLIENT_SECRET: "qq-test-secret",
      },
      { loadDotenv: false },
    );

    const sentFrames: string[] = [];
    const fakeWs = {
      readyState: 1,
      send: (d: string) => sentFrames.push(d),
      close: () => {},
      addEventListener: () => {},
    };

    const adapter = new QQBotChannelAdapter(cfg, {
      defaultHeartbeatMs: 45_000,
      fetchImpl: async () =>
        new Response(JSON.stringify({ access_token: "tok", expires_in: 7200 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      onHeartbeatInterval: (ms) => {
        recordedDelays.push(ms);
      },
    });
    // Inject socket via private field seam to drive handleFrame directly
    (adapter as unknown as { socket: unknown }).socket = fakeWs;

    // Overflow / hostile remote values must fall back to safe default (45000ms)
    await adapter.handleFrame(JSON.stringify({ op: 10, d: { heartbeat_interval: 1e15 } }));
    await adapter.handleFrame(JSON.stringify({ op: 10, d: { heartbeat_interval: -10 } }));
    await adapter.handleFrame(JSON.stringify({ op: 10, d: { heartbeat_interval: 50 } }));
    // Legitimate remote interval within [1000, 300000] is honored
    await adapter.handleFrame(JSON.stringify({ op: 10, d: { heartbeat_interval: 30_000 } }));

    expect(recordedDelays).toEqual([45_000, 45_000, 45_000, 30_000]);
  });

  it("exposes OS-bound socket address from HealthServer.getBoundAddress()", async () => {
    const snap: HealthSnapshot = {
      status: "ok",
      startedAt: Date.now(),
      uptimeMs: 100,
      channelConnected: true,
      activeSessions: 0,
      activeTurns: 0,
      pendingPermissions: 0,
      activeLoops: 0,
    };
    const srv = new HealthServer({ healthHost: "127.0.0.1", healthPort: 0 }, () => snap);
    await srv.start();
    servers.push(srv);

    const bound = srv.getBoundAddress();
    expect(bound).not.toBeNull();
    expect(bound?.host).toBe("127.0.0.1");
    expect(bound?.port).toBeGreaterThan(0);
  });

  it("audit-secrets rejects lookalike example.com.attacker.net URLs from .env instead of ignoring them", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-w14-audit-"));
    tempDirs.push(dir);

    execFileSync("git", ["init", "-q"], { cwd: dir });
    fs.writeFileSync(path.join(dir, ".gitignore"), ".env\n", "utf8");
    // Put a lookalike domain URL in local .env AND leak it into a tracked file
    fs.writeFileSync(
      path.join(dir, ".env"),
      "WEBHOOK_CALLBACK_URL=https://example.com.attacker.net/secret-hook\n",
      "utf8",
    );
    fs.writeFileSync(
      path.join(dir, "leaked.txt"),
      "oops https://example.com.attacker.net/secret-hook\n",
      "utf8",
    );
    execFileSync("git", ["add", ".gitignore", "leaked.txt"], { cwd: dir });

    const auditScript = path.resolve(import.meta.dirname, "..", "scripts", "audit-secrets.mjs");
    let stderr = "";
    try {
      execFileSync(process.execPath, [auditScript], { cwd: dir, encoding: "utf8", stdio: "pipe" });
    } catch (err) {
      stderr = String((err as { stderr?: unknown }).stderr ?? "");
    }
    expect(stderr).toContain("WEBHOOK_CALLBACK_URL");

    // Genuine RFC 2606 example.com placeholder in .env is still allowed
    fs.writeFileSync(
      path.join(dir, ".env"),
      "WEBHOOK_CALLBACK_URL=https://example.com/hook\nALLOWED_SENDERS=user@example.org\n",
      "utf8",
    );
    fs.writeFileSync(
      path.join(dir, "leaked.txt"),
      "docs: https://example.com/hook and user@example.org\n",
      "utf8",
    );
    expect(() =>
      execFileSync(process.execPath, [auditScript], { cwd: dir, stdio: "pipe" }),
    ).not.toThrow();
  });
});
