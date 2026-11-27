import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ZodError, z } from "zod";
import {
  exportGatewayBundle,
  importGatewayBundle,
  parseRemapRule,
  remapDirectoryPath,
} from "../src/backup.js";
import { formatConfigError } from "../src/cli.js";
import { GatewayStore } from "../src/gateway/store.js";
import { HealthServer, formatPrometheusMetrics } from "../src/health.js";
import { RotatingFileLogger } from "../src/logger.js";
import type { HealthSnapshot } from "../src/types.js";

const tempDirs: string[] = [];
const servers: HealthServer[] = [];

function createTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-w13-obs-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (servers.length > 0) {
    const s = servers.pop();
    if (s) await s.stop();
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("Wave 13 Prometheus /metrics & structured JSON logging", () => {
  const sampleSnapshot: HealthSnapshot = {
    status: "ok",
    startedAt: Date.now() - 65_000,
    uptimeMs: 65_000,
    channelConnected: true,
    activeSessions: 4,
    activeTurns: 1,
    pendingPermissions: 2,
    activeLoops: 3,
    lastError: "Bearer secret-must-never-appear-in-metrics",
    channels: {
      photon: {
        name: "photon",
        connected: true,
        lastInboundAt: 1_700_000_100_000,
        lastOutboundAt: 1_700_000_200_000,
        lastHeartbeatAt: 1_700_000_300_000,
      },
      telegram: {
        name: "telegram",
        connected: false,
        lastError: "123456789:AAHsuperSecretTelegramTokenValue1234567",
      },
    },
  };

  it("formats bounded-cardinality Prometheus metrics with zero secrets or PII", () => {
    const text = formatPrometheusMetrics(sampleSnapshot);
    expect(text).toContain("antigravity_gateway_up 1");
    expect(text).toContain("antigravity_gateway_ready 1");
    expect(text).toContain("antigravity_gateway_uptime_seconds 65");
    expect(text).toContain("antigravity_gateway_active_sessions 4");
    expect(text).toContain("antigravity_gateway_active_turns 1");
    expect(text).toContain("antigravity_gateway_pending_permissions 2");
    expect(text).toContain("antigravity_gateway_active_loops 3");
    expect(text).toContain('antigravity_gateway_channel_connected{channel="photon"} 1');
    expect(text).toContain('antigravity_gateway_channel_connected{channel="telegram"} 0');
    expect(text).toContain(
      'antigravity_gateway_channel_last_heartbeat_timestamp_seconds{channel="photon"} 1700000300',
    );
    expect(text).not.toContain("secret-must-never-appear-in-metrics");
    expect(text).not.toContain("AAHsuperSecretTelegramTokenValue");
  });

  it("serves GET /metrics and enforces HEALTH_TOKEN when configured", async () => {
    const srv = new HealthServer(
      { healthHost: "127.0.0.1", healthPort: 0, healthToken: "metrics-secret-99" },
      () => sampleSnapshot,
    );
    await srv.start();
    servers.push(srv);
    const port = srv.getPort()!;

    const unauth = await fetch(`http://127.0.0.1:${port}/metrics`);
    expect(unauth.status).toBe(401);

    const authed = await fetch(`http://127.0.0.1:${port}/metrics`, {
      headers: { Authorization: "Bearer metrics-secret-99" },
    });
    expect(authed.status).toBe(200);
    expect(authed.headers.get("content-type")).toContain("text/plain; version=0.0.4");
    const body = await authed.text();
    expect(body).toContain("antigravity_gateway_up 1");
  });

  it("writes redacted single-line JSON logs when RotatingFileLogger format is json", () => {
    const dir = createTempDir();
    const logFile = path.join(dir, "gateway.log");
    const logger = new RotatingFileLogger({ logFile, format: "json" });

    logger.write("warn", "Failed with Authorization: Bearer super-secret-xyz", {
      channel: "telegram",
      detail: "token=my-secret-value",
    });

    const lines = fs.readFileSync(logFile, "utf8").trim().split(/\r?\n/);
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]) as {
      ts: string;
      level: string;
      msg: string;
      meta?: Record<string, string>;
    };
    expect(parsed.level).toBe("warn");
    expect(parsed.msg).toContain("Bearer ***");
    expect(parsed.msg).not.toContain("super-secret-xyz");
    expect(parsed.meta?.channel).toBe("telegram");
    expect(parsed.meta?.detail).toBe("token=***");
  });
});

describe("Wave 13 portable export/import backup & doctor config formatting", () => {
  it("exports secret-free bundles and imports with dry-run preview and cross-OS path remapping", async () => {
    const srcDir = createTempDir();
    const dstDir = createTempDir();

    const srcStore = new GatewayStore(srcDir);
    await srcStore.load();
    await srcStore.upsertSession({
      chatId: "telegram::100",
      sessionId: "acp-sess-1",
      cwd: "C:\\work\\repos\\app",
      approvalMode: "interactive",
      busyMode: "queue",
      updatedAt: 1000,
    });
    await srcStore.upsertLoop({
      id: "abc123",
      chatId: "telegram::100",
      prompt: "daily check",
      cron: "0 9 * * 1-5",
      cwd: "C:\\work\\repos\\app\\sub",
      enabled: true,
      createdAt: 1000,
    });
    await srcStore.setWorkspace("app", "C:\\work\\repos\\app");
    await srcStore.addApprovedSender("telegram:alice");

    // Default export omits approvedSenders
    const bundle = exportGatewayBundle(srcStore, { gatewayVersion: "0.4.0" });
    expect(bundle.approvedSenders).toBeUndefined();
    expect(bundle.sessions).toHaveLength(1);
    expect(bundle.loops).toHaveLength(1);
    expect(bundle.workspaces.app).toBe("C:\\work\\repos\\app");

    const rule = parseRemapRule("C:\\work\\repos=/Users/dev/repos");
    expect(rule).not.toBeNull();
    expect(remapDirectoryPath("C:\\work\\repos\\app\\sub", [rule!])).toEqual({
      value: "/Users/dev/repos/app/sub",
      remapped: true,
    });

    // Dry-run reports counts without writing
    const dstStore = new GatewayStore(dstDir);
    await dstStore.load();
    const preview = await importGatewayBundle(dstStore, bundle, {
      dryRun: true,
      remapCwd: [rule!],
    });
    expect(preview.dryRun).toBe(true);
    expect(preview.sessionsAdded).toBe(1);
    expect(preview.loopsAdded).toBe(1);
    expect(preview.workspacesImported).toBe(1);
    expect(preview.pathsRemapped).toBe(3);
    expect(dstStore.listSessions()).toHaveLength(0);

    // Real import persists remapped paths
    const applied = await importGatewayBundle(dstStore, bundle, {
      remapCwd: [rule!],
    });
    expect(applied.dryRun).toBe(false);
    expect(dstStore.getSession("telegram::100")?.cwd).toBe("/Users/dev/repos/app");
    expect(dstStore.getLoops()[0]?.cwd).toBe("/Users/dev/repos/app/sub");
    expect(dstStore.getWorkspace("app")).toBe("/Users/dev/repos/app");
  });

  it("formats redacted Zod field errors clearly for pnpm cli doctor", () => {
    const schema = z.object({
      HEALTH_PORT: z.coerce.number().int().min(1).max(65535),
      APPROVAL_MODE: z.enum(["auto", "interactive", "sandbox"]),
    });
    try {
      schema.parse({ HEALTH_PORT: "999999", APPROVAL_MODE: "invalid" });
    } catch (err) {
      expect(err).toBeInstanceOf(ZodError);
      const formatted = formatConfigError(err);
      expect(formatted).toContain("HEALTH_PORT:");
      expect(formatted).toContain("APPROVAL_MODE:");
    }
    expect(formatConfigError(new Error("Bad Bearer secret-token-123"))).toContain("Bearer ***");
  });

  it("ships checksum-verified install.sh (LF) and install.ps1 scripts", () => {
    const repoRoot = path.resolve(import.meta.dirname, "..");
    const sh = fs.readFileSync(path.join(repoRoot, "scripts", "install.sh"), "utf8");
    const ps1 = fs.readFileSync(path.join(repoRoot, "scripts", "install.ps1"), "utf8");
    expect(sh.startsWith("#!/usr/bin/env bash\n")).toBe(true);
    expect(sh.includes("\r\n")).toBe(false);
    expect(sh).toContain("SHA256SUMS.txt");
    expect(ps1).toContain("SHA256SUMS.txt");
    expect(ps1).toContain("Get-FileHash");
  });
});
