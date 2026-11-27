import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { HealthServer } from "../src/health.js";
import type { HealthSnapshot } from "../src/types.js";

const servers: HealthServer[] = [];

afterEach(async () => {
  while (servers.length > 0) {
    const srv = servers.pop();
    if (srv) {
      await srv.stop();
    }
  }
});

async function startHealth(
  cfg: { healthHost: string; healthPort: number; healthToken?: string },
  snapshot: HealthSnapshot,
): Promise<{ port: number; server: HealthServer }> {
  const server = new HealthServer(cfg, () => snapshot);
  await server.start();
  servers.push(server);
  const port = server.getPort();
  if (!port) {
    throw new Error("HealthServer did not bind a port");
  }
  return { port, server };
}

function makeSnapshot(overrides: Partial<HealthSnapshot> = {}): HealthSnapshot {
  return {
    status: "degraded",
    startedAt: Date.now() - 10_000,
    uptimeMs: 10_000,
    channelConnected: true,
    activeSessions: 1,
    activeTurns: 0,
    pendingPermissions: 0,
    activeLoops: 0,
    lastError: "Upstream rejected Authorization: Bearer super-secret-token-12345",
    channels: {
      telegram: {
        name: "telegram",
        connected: false,
        lastError: "HTTP 401 for bot 123456789:AAHfakeTelegramSecretTokenValue1234567",
      },
      photon: {
        name: "photon",
        connected: true,
      },
    },
    ...overrides,
  };
}

describe("Wave 12 config security defaults", () => {
  it("defaults WEBHOOK_REQUIRE_TIMESTAMP to true on non-loopback hosts and false on loopback", () => {
    const nonLoopback = loadConfig(
      {
        WEBHOOK_ENABLED: "true",
        WEBHOOK_HOST: "0.0.0.0",
        WEBHOOK_SECRET: "test-signing-secret",
      },
      { loadDotenv: false },
    );
    expect(nonLoopback.webhook?.requireTimestamp).toBe(true);

    const loopbackIpv4 = loadConfig(
      {
        WEBHOOK_ENABLED: "true",
        WEBHOOK_HOST: "127.0.0.1",
        WEBHOOK_SECRET: "test-signing-secret",
      },
      { loadDotenv: false },
    );
    expect(loopbackIpv4.webhook?.requireTimestamp).toBe(false);

    const loopbackIpv6Bracketed = loadConfig(
      {
        WEBHOOK_ENABLED: "true",
        WEBHOOK_HOST: "[::1]",
        WEBHOOK_SECRET: "test-signing-secret",
      },
      { loadDotenv: false },
    );
    expect(loopbackIpv6Bracketed.webhook?.requireTimestamp).toBe(false);

    const explicitFalse = loadConfig(
      {
        WEBHOOK_ENABLED: "true",
        WEBHOOK_HOST: "0.0.0.0",
        WEBHOOK_SECRET: "test-signing-secret",
        WEBHOOK_REQUIRE_TIMESTAMP: "false",
      },
      { loadDotenv: false },
    );
    expect(explicitFalse.webhook?.requireTimestamp).toBe(false);
  });

  it("parses HEALTH_TOKEN and LOG_DIR cleanly while treating placeholders as unset", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agy-w12-cfg-"));
    try {
      const cfg = loadConfig(
        {
          HEALTH_TOKEN: "my-ops-health-token",
          LOG_DIR: tmp,
        },
        { loadDotenv: false },
      );
      expect(cfg.healthToken).toBe("my-ops-health-token");
      expect(cfg.logDir).toBe(path.resolve(tmp));

      const unset = loadConfig(
        {
          HEALTH_TOKEN: "your-health-token",
          LOG_DIR: "",
        },
        { loadDotenv: false },
      );
      expect(unset.healthToken).toBeUndefined();
      expect(unset.logDir).toBeUndefined();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("Wave 12 HealthServer hardening", () => {
  it("redacts secrets in /status lastError fields on loopback", async () => {
    const { port } = await startHealth(
      { healthHost: "127.0.0.1", healthPort: 0 },
      makeSnapshot(),
    );

    const res = await fetch(`http://127.0.0.1:${port}/status`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as HealthSnapshot;
    expect(body.lastError).toContain("Bearer ***");
    expect(body.lastError).not.toContain("super-secret-token-12345");
    expect(body.channels?.telegram?.lastError).toContain("***");
    expect(body.channels?.telegram?.lastError).not.toContain("AAHfakeTelegramSecretTokenValue");
  });

  it("enforces Bearer HEALTH_TOKEN on /status while keeping /healthz and /readyz accessible", async () => {
    const { port } = await startHealth(
      {
        healthHost: "127.0.0.1",
        healthPort: 0,
        healthToken: "strict-status-token-42",
      },
      makeSnapshot({ status: "ok" }),
    );

    // Probes stay open for Docker / Kubernetes / systemd healthchecks.
    const healthz = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(healthz.status).toBe(200);
    const readyz = await fetch(`http://127.0.0.1:${port}/readyz`);
    expect(readyz.status).toBe(200);

    // Unauthenticated or wrong token is rejected on /status.
    const noAuth = await fetch(`http://127.0.0.1:${port}/status`);
    expect(noAuth.status).toBe(401);
    expect(noAuth.headers.get("www-authenticate")).toBe("Bearer");

    const badAuth = await fetch(`http://127.0.0.1:${port}/status`, {
      headers: { Authorization: "Bearer wrong-token" },
    });
    expect(badAuth.status).toBe(401);

    // Valid token returns full redacted diagnostics.
    const okAuth = await fetch(`http://127.0.0.1:${port}/status`, {
      headers: { Authorization: "Bearer strict-status-token-42" },
    });
    expect(okAuth.status).toBe(200);
    const body = (await okAuth.json()) as HealthSnapshot;
    expect(body.lastError).toContain("Bearer ***");
    expect(body.lastError).not.toContain("super-secret-token-12345");
  });

  it("strips lastError diagnostics on non-loopback listeners when HEALTH_TOKEN is unset", async () => {
    const { port } = await startHealth(
      { healthHost: "0.0.0.0", healthPort: 0 },
      makeSnapshot(),
    );

    const res = await fetch(`http://127.0.0.1:${port}/status`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as HealthSnapshot;
    expect(body.status).toBe("degraded");
    expect(body.lastError).toBeUndefined();
    expect(body.channels?.telegram?.connected).toBe(false);
    expect(body.channels?.telegram?.lastError).toBeUndefined();
  });
});
