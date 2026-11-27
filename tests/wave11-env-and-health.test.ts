import { describe, expect, it } from "vitest";
import {
  buildChildProcessEnv,
  isSensitiveGatewayEnvKey,
} from "../src/acp/client.js";
import { HealthServer } from "../src/health.js";
import type { HealthSnapshot } from "../src/types.js";

const CHANNEL_CREDENTIALS: Record<string, string> = {
  SPECTRUM_PROJECT_SECRET: "dummy-spectrum-secret",
  PHOTON_TOKEN: "dummy-photon-token",
  TELEGRAM_BOT_TOKEN: "dummy-telegram-token",
  DISCORD_BOT_TOKEN: "dummy-discord-token",
  SLACK_BOT_TOKEN: "dummy-slack-token",
  FEISHU_APP_SECRET: "dummy-feishu-secret",
  DINGTALK_CLIENT_SECRET: "dummy-dingtalk-secret",
  ONEBOT_ACCESS_TOKEN: "dummy-onebot-token",
  WEBHOOK_SECRET: "dummy-webhook-secret",
  WECOM_ENCODING_AES_KEY: "dummy-wecom-aes-key",
  QQBOT_TOKEN: "dummy-qqbot-token",
  MATRIX_ACCESS_TOKEN: "dummy-matrix-token",
  MATTERMOST_TOKEN: "dummy-mattermost-token",
  LINE_CHANNEL_SECRET: "dummy-line-secret",
  IRC_PASSWORD: "dummy-irc-password",
  WHATSAPP_TOKEN: "dummy-whatsapp-token",
  ZULIP_API_KEY: "dummy-zulip-key",
  ROCKETCHAT_AUTH_TOKEN: "dummy-rocketchat-token",
  SIGNAL_PHONE_NUMBER: "dummy-signal-number",
  TEAMS_CLIENT_SECRET: "dummy-teams-secret",
  GOOGLECHAT_ACCESS_TOKEN: "dummy-googlechat-token",
};

const INTERNAL_CONFIG: Record<string, string> = {
  ANTIGRAVITY_CSRF_TOKEN: "dummy-csrf",
  ANTIGRAVITY_LS_ADDRESS: "127.0.0.1:1",
  ALLOWED_SENDERS: "dummy-sender",
  ADMIN_SENDERS: "dummy-admin",
  ALLOW_GROUPS: "true",
  GROUP_MENTION_PATTERNS: "dummy-pattern",
  AGY_PASSTHROUGH_ENV: "dummy-pass",
  QUOTA_WARN_THRESHOLD: "10",
  TURN_MAX_RETRIES: "3",
  INGRESS_DEBOUNCE_MS: "50",
  AUTO_BOOTSTRAP_CHANNEL_SESSION: "true",
  HEALTH_HOST: "127.0.0.1",
  TOOL_PROGRESS_NOTIFY: "true",
  PROGRESS_SILENCE_MS: "1000",
  SESSION_STALL_MS: "2000",
};

const RUNTIME_PRESERVED: Record<string, string> = {
  PATH: "/usr/bin:/bin",
  HOME: "/home/node",
  HTTP_PROXY: "http://proxy.internal:8080",
  HTTPS_PROXY: "http://proxy.internal:8080",
  NO_PROXY: "localhost",
  LANG: "en_US.UTF-8",
  SYSTEMROOT: "C:\\Windows",
  TEMP: "C:\\Temp",
};

describe("isSensitiveGatewayEnvKey", () => {
  it("flags every channel family and internal config key regardless of case", () => {
    for (const key of [...Object.keys(CHANNEL_CREDENTIALS), ...Object.keys(INTERNAL_CONFIG)]) {
      expect(isSensitiveGatewayEnvKey(key)).toBe(true);
      expect(isSensitiveGatewayEnvKey(key.toLowerCase())).toBe(true);
    }
  });

  it("does not flag ordinary OS/runtime variables", () => {
    for (const key of ["PATH", "HOME", "HTTP_PROXY", "LANG", "GEMINI_API_KEY"]) {
      expect(isSensitiveGatewayEnvKey(key)).toBe(false);
    }
  });
});

describe("buildChildProcessEnv", () => {
  it("strips gateway/channel credentials from all channel families", () => {
    const base: NodeJS.ProcessEnv = {
      ...CHANNEL_CREDENTIALS,
      ...INTERNAL_CONFIG,
      ...RUNTIME_PRESERVED,
    };

    const env = buildChildProcessEnv(base);

    for (const key of Object.keys(CHANNEL_CREDENTIALS)) {
      expect(env[key]).toBeUndefined();
    }
    for (const key of Object.keys(INTERNAL_CONFIG)) {
      expect(env[key]).toBeUndefined();
    }
  });

  it("preserves OS runtime, PATH, HOME, and proxy variables", () => {
    const env = buildChildProcessEnv({ ...RUNTIME_PRESERVED });
    for (const [key, value] of Object.entries(RUNTIME_PRESERVED)) {
      expect(env[key]).toBe(value);
    }
    expect(env.PYTHONUTF8).toBe("1");
  });

  it("honors passthroughKeys (case-insensitive) while still stripping others", () => {
    const base: NodeJS.ProcessEnv = {
      ...CHANNEL_CREDENTIALS,
      PATH: "/usr/bin",
    };

    const env = buildChildProcessEnv(base, {}, ["telegram_bot_token"]);

    expect(env.TELEGRAM_BOT_TOKEN).toBe("dummy-telegram-token");
    expect(env.DISCORD_BOT_TOKEN).toBeUndefined();
    expect(env.SPECTRUM_PROJECT_SECRET).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin");
  });

  it("applies the GEMINI_API_KEY override last and keeps PYTHONUTF8 default", () => {
    const env = buildChildProcessEnv(
      { PATH: "/usr/bin", PYTHONUTF8: "0" },
      { GEMINI_API_KEY: "test-key-not-real" },
    );
    expect(env.GEMINI_API_KEY).toBe("test-key-not-real");
    expect(env.PYTHONUTF8).toBe("0");
  });
});

function snapshot(overrides: Partial<HealthSnapshot>): HealthSnapshot {
  return {
    status: "ok",
    startedAt: 1000,
    uptimeMs: 5000,
    channelConnected: true,
    activeSessions: 0,
    activeTurns: 0,
    pendingPermissions: 0,
    activeLoops: 0,
    ...overrides,
  };
}

async function withHealthServer(
  getSnapshot: () => HealthSnapshot,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const health = new HealthServer(
    { healthHost: "127.0.0.1", healthPort: 0 },
    getSnapshot,
  );
  await health.start();
  try {
    await run(`http://127.0.0.1:${health.getPort()}`);
  } finally {
    await health.stop();
  }
}

describe("HealthServer liveness vs readiness", () => {
  it("keeps /healthz live during a partial multi-channel outage but /readyz is not ready", async () => {
    const snap = snapshot({
      status: "degraded",
      channelConnected: true,
      channels: {
        alpha: { name: "alpha", connected: true },
        beta: { name: "beta", connected: false },
      },
    });

    await withHealthServer(
      () => snap,
      async (base) => {
        const healthz = await fetch(`${base}/healthz`);
        expect(healthz.status).toBe(200);
        const healthzBody = (await healthz.json()) as Record<string, unknown>;
        expect(healthzBody.ok).toBe(true);
        expect(healthzBody.status).toBe("degraded");
        expect(healthzBody.channelConnected).toBe(true);
        expect(healthzBody.channels).toEqual({ alpha: true, beta: false });

        const readyz = await fetch(`${base}/readyz`);
        expect(readyz.status).toBe(503);
        const readyzBody = (await readyz.json()) as Record<string, unknown>;
        expect(readyzBody.ok).toBe(false);
        expect(readyzBody.status).toBe("degraded");
      },
    );
  });

  it("returns 503 from both probes during a total outage", async () => {
    const snap = snapshot({ status: "degraded", channelConnected: false });
    await withHealthServer(
      () => snap,
      async (base) => {
        const healthz = await fetch(`${base}/healthz`);
        expect(healthz.status).toBe(503);
        expect(((await healthz.json()) as Record<string, unknown>).ok).toBe(false);

        const readyz = await fetch(`${base}/readyz`);
        expect(readyz.status).toBe(503);
        expect(((await readyz.json()) as Record<string, unknown>).ok).toBe(false);
      },
    );
  });

  it("returns 503 from both probes while starting", async () => {
    const snap = snapshot({ status: "starting", channelConnected: false });
    await withHealthServer(
      () => snap,
      async (base) => {
        const healthz = await fetch(`${base}/healthz`);
        expect(healthz.status).toBe(503);
        expect(((await healthz.json()) as Record<string, unknown>).status).toBe("starting");

        const readyz = await fetch(`${base}/readyz`);
        expect(readyz.status).toBe(503);
        expect(((await readyz.json()) as Record<string, unknown>).status).toBe("starting");
      },
    );
  });

  it("returns 200 from both probes when fully connected", async () => {
    const snap = snapshot({ status: "ok", channelConnected: true });
    await withHealthServer(
      () => snap,
      async (base) => {
        const healthz = await fetch(`${base}/healthz`);
        expect(healthz.status).toBe(200);
        expect(((await healthz.json()) as Record<string, unknown>).ok).toBe(true);

        const readyz = await fetch(`${base}/readyz`);
        expect(readyz.status).toBe(200);
        expect(((await readyz.json()) as Record<string, unknown>).ok).toBe(true);
      },
    );
  });

  it("includes heartbeat stream/line info in sanitized /status channel snapshots", async () => {
    const snap = snapshot({
      status: "ok",
      channelConnected: true,
      channels: {
        alpha: {
          name: "alpha",
          connected: true,
          lastHeartbeatAt: 4000,
          heartbeatStream: "stream-1",
          heartbeatLineId: "line-9",
        },
      },
    });

    await withHealthServer(
      () => snap,
      async (base) => {
        const statusRes = await fetch(`${base}/status`);
        expect(statusRes.status).toBe(200);
        const body = (await statusRes.json()) as {
          channels: Record<string, Record<string, unknown>>;
        };
        expect(body.channels.alpha).toMatchObject({
          connected: true,
          heartbeatStream: "stream-1",
          heartbeatLineId: "line-9",
        });
      },
    );
  });
});