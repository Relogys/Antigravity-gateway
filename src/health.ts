import crypto from "node:crypto";
import http from "node:http";
import { extractAuthSchemeToken, isLoopbackHost } from "./channels/utils.js";
import type { GatewayConfig } from "./config.js";
import { redactSecrets } from "./logger.js";
import type { HealthSnapshot } from "./types.js";

function verifyBearerToken(req: http.IncomingMessage, expectedToken: string): boolean {
  const provided = extractAuthSchemeToken(req.headers.authorization, "Bearer");
  if (!provided) {
    return false;
  }
  const a = crypto.createHash("sha256").update(provided).digest();
  const b = crypto.createHash("sha256").update(expectedToken).digest();
  return crypto.timingSafeEqual(a, b);
}

function escapePromLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

/**
 * Render a HealthSnapshot in Prometheus text exposition format (0.0.4).
 * Strictly bounded cardinality: exports only aggregate counters/gauges and
 * channel-name labels — never sender IDs, chat IDs, or raw error strings.
 */
export function formatPrometheusMetrics(snapshot: HealthSnapshot): string {
  const isUp =
    snapshot.status === "ok" ||
    (snapshot.status === "degraded" && snapshot.channelConnected === true)
      ? 1
      : 0;
  const isReady = snapshot.status === "ok" ? 1 : 0;
  const uptimeSec = Math.max(0, Math.floor(snapshot.uptimeMs / 1000));

  const lines: string[] = [
    "# HELP antigravity_gateway_up Gateway liveness (1 when at least one channel is live).",
    "# TYPE antigravity_gateway_up gauge",
    `antigravity_gateway_up ${isUp}`,
    "# HELP antigravity_gateway_ready Gateway readiness (1 when all configured channels are connected).",
    "# TYPE antigravity_gateway_ready gauge",
    `antigravity_gateway_ready ${isReady}`,
    "# HELP antigravity_gateway_uptime_seconds Process uptime in seconds.",
    "# TYPE antigravity_gateway_uptime_seconds gauge",
    `antigravity_gateway_uptime_seconds ${uptimeSec}`,
    "# HELP antigravity_gateway_active_sessions Number of persisted gateway chat sessions.",
    "# TYPE antigravity_gateway_active_sessions gauge",
    `antigravity_gateway_active_sessions ${snapshot.activeSessions}`,
    "# HELP antigravity_gateway_active_turns Number of currently running ACP agent turns.",
    "# TYPE antigravity_gateway_active_turns gauge",
    `antigravity_gateway_active_turns ${snapshot.activeTurns}`,
    "# HELP antigravity_gateway_pending_permissions Number of pending interactive tool approvals.",
    "# TYPE antigravity_gateway_pending_permissions gauge",
    `antigravity_gateway_pending_permissions ${snapshot.pendingPermissions}`,
    "# HELP antigravity_gateway_active_loops Number of enabled scheduled loops and reminders.",
    "# TYPE antigravity_gateway_active_loops gauge",
    `antigravity_gateway_active_loops ${snapshot.activeLoops}`,
  ];

  const channels = snapshot.channels ? Object.entries(snapshot.channels) : [];
  if (channels.length > 0) {
    lines.push(
      "# HELP antigravity_gateway_channel_connected Channel connection status (1=connected, 0=disconnected).",
      "# TYPE antigravity_gateway_channel_connected gauge",
    );
    for (const [name, c] of channels) {
      const label = escapePromLabel(name);
      lines.push(`antigravity_gateway_channel_connected{channel="${label}"} ${c.connected ? 1 : 0}`);
    }

    const inbound = channels.filter(([, c]) => typeof c.lastInboundAt === "number");
    if (inbound.length > 0) {
      lines.push(
        "# HELP antigravity_gateway_channel_last_inbound_timestamp_seconds Unix timestamp of last inbound message per channel.",
        "# TYPE antigravity_gateway_channel_last_inbound_timestamp_seconds gauge",
      );
      for (const [name, c] of inbound) {
        lines.push(
          `antigravity_gateway_channel_last_inbound_timestamp_seconds{channel="${escapePromLabel(name)}"} ${Math.floor((c.lastInboundAt as number) / 1000)}`,
        );
      }
    }

    const outbound = channels.filter(([, c]) => typeof c.lastOutboundAt === "number");
    if (outbound.length > 0) {
      lines.push(
        "# HELP antigravity_gateway_channel_last_outbound_timestamp_seconds Unix timestamp of last outbound message per channel.",
        "# TYPE antigravity_gateway_channel_last_outbound_timestamp_seconds gauge",
      );
      for (const [name, c] of outbound) {
        lines.push(
          `antigravity_gateway_channel_last_outbound_timestamp_seconds{channel="${escapePromLabel(name)}"} ${Math.floor((c.lastOutboundAt as number) / 1000)}`,
        );
      }
    }

    const heartbeats = channels.filter(([, c]) => typeof c.lastHeartbeatAt === "number");
    if (heartbeats.length > 0) {
      lines.push(
        "# HELP antigravity_gateway_channel_last_heartbeat_timestamp_seconds Unix timestamp of last transport heartbeat per channel.",
        "# TYPE antigravity_gateway_channel_last_heartbeat_timestamp_seconds gauge",
      );
      for (const [name, c] of heartbeats) {
        lines.push(
          `antigravity_gateway_channel_last_heartbeat_timestamp_seconds{channel="${escapePromLabel(name)}"} ${Math.floor((c.lastHeartbeatAt as number) / 1000)}`,
        );
      }
    }
  }

  return `${lines.join("\n")}\n`;
}

/**
 * Read-only health, metrics & status HTTP server (`GET /healthz`, `GET /readyz`,
 * `GET /status`, `GET /metrics`). Never exposes secrets or personal sender identifiers;
 * redacts error strings and optionally protects `/status` & `/metrics` with `HEALTH_TOKEN`.
 */
export class HealthServer {
  private server: http.Server | null = null;

  constructor(
    private readonly config: Pick<GatewayConfig, "healthHost" | "healthPort" | "healthToken">,
    private readonly getSnapshot: () => HealthSnapshot,
  ) {}

  async start(): Promise<void> {
    if (this.server) {
      return;
    }

    const server = http.createServer((req, res) => {
      if (req.method !== "GET") {
        this.sendJson(res, 405, { error: "Method Not Allowed" });
        return;
      }

      let urlPath: string;
      try {
        urlPath = new URL(req.url ?? "/", "http://localhost").pathname;
      } catch {
        this.sendJson(res, 400, { error: "Bad Request" });
        return;
      }
      const snapshot = this.getSnapshot();

      if (urlPath === "/healthz") {
        // Liveness: a degraded multi-channel deployment with at least one live
        // channel stays alive so a single flapping channel cannot crash-loop
        // the whole gateway. Only total outage or startup is unhealthy.
        const isOk =
          snapshot.status === "ok" ||
          (snapshot.status === "degraded" && snapshot.channelConnected === true);
        this.sendJson(res, isOk ? 200 : 503, {
          ok: isOk,
          status: snapshot.status,
          uptimeMs: snapshot.uptimeMs,
          channelConnected: snapshot.channelConnected,
          channels: snapshot.channels
            ? Object.fromEntries(
                Object.entries(snapshot.channels).map(([key, c]) => [key, c.connected]),
              )
            : undefined,
        });
        return;
      }

      if (urlPath === "/readyz") {
        // Strict readiness: only truly "ok" is ready (every channel upstream).
        const isReady = snapshot.status === "ok";
        this.sendJson(res, isReady ? 200 : 503, {
          ok: isReady,
          status: snapshot.status,
          uptimeMs: snapshot.uptimeMs,
          channelConnected: snapshot.channelConnected,
          channels: snapshot.channels
            ? Object.fromEntries(
                Object.entries(snapshot.channels).map(([key, c]) => [key, c.connected]),
              )
            : undefined,
        });
        return;
      }

      if (urlPath === "/status") {
        const expectedToken = this.config.healthToken?.trim();
        if (expectedToken && !verifyBearerToken(req, expectedToken)) {
          this.sendJson(
            res,
            401,
            { error: "Unauthorized" },
            { "WWW-Authenticate": "Bearer" },
          );
          return;
        }

        // Only expose redacted diagnostic error strings to authenticated callers or
        // loopback listeners; unauthenticated non-loopback requests receive counts/states only.
        const includeErrorDetails =
          Boolean(expectedToken) || isLoopbackHost(this.config.healthHost);
        const sanitizeError = (raw?: string): string | undefined => {
          if (!raw || !includeErrorDetails) {
            return undefined;
          }
          return redactSecrets(raw);
        };

        const sanitized: HealthSnapshot = {
          status: snapshot.status,
          startedAt: snapshot.startedAt,
          uptimeMs: snapshot.uptimeMs,
          channelConnected: snapshot.channelConnected,
          activeSessions: snapshot.activeSessions,
          activeTurns: snapshot.activeTurns,
          pendingPermissions: snapshot.pendingPermissions,
          activeLoops: snapshot.activeLoops,
          lastInboundAt: snapshot.lastInboundAt,
          lastOutboundAt: snapshot.lastOutboundAt,
          lastError: sanitizeError(snapshot.lastError),
          channels: snapshot.channels
            ? Object.fromEntries(
                Object.entries(snapshot.channels).map(([key, c]) => [
                  key,
                  {
                    name: c.name,
                    connected: c.connected,
                    lastInboundAt: c.lastInboundAt,
                    lastOutboundAt: c.lastOutboundAt,
                    lastHeartbeatAt: c.lastHeartbeatAt,
                    heartbeatStream: c.heartbeatStream,
                    heartbeatLineId: c.heartbeatLineId,
                    lastError: sanitizeError(c.lastError),
                  },
                ]),
              )
            : undefined,
        };
        this.sendJson(res, 200, sanitized);
        return;
      }

      if (urlPath === "/metrics") {
        const expectedToken = this.config.healthToken?.trim();
        if (expectedToken && !verifyBearerToken(req, expectedToken)) {
          this.sendJson(
            res,
            401,
            { error: "Unauthorized" },
            { "WWW-Authenticate": "Bearer" },
          );
          return;
        }
        const body = formatPrometheusMetrics(snapshot);
        res.writeHead(200, {
          "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
          "Cache-Control": "no-store",
          "Content-Length": Buffer.byteLength(body),
        });
        res.end(body);
        return;
      }

      this.sendJson(res, 404, { error: "Not Found" });
    });

    server.keepAliveTimeout = 60_000;
    server.headersTimeout = 65_000;
    server.requestTimeout = 30_000;

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => reject(err);
      server.once("error", onError);
      server.listen(this.config.healthPort, this.config.healthHost, () => {
        server.off("error", onError);
        resolve();
      });
    });

    this.server = server;
  }

  getPort(): number | null {
    const addr = this.server?.address();
    if (addr && typeof addr === "object") {
      return addr.port;
    }
    return null;
  }

  getBoundAddress(): { host: string; port: number } | null {
    const addr = this.server?.address();
    if (addr && typeof addr === "object") {
      return { host: addr.address, port: addr.port };
    }
    return null;
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) {
      return;
    }
    this.server = null;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  }

  private sendJson(
    res: http.ServerResponse,
    statusCode: number,
    payload: unknown,
    extraHeaders?: Record<string, string>,
  ): void {
    const body = JSON.stringify(payload);
    res.writeHead(statusCode, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Length": Buffer.byteLength(body),
      ...extraHeaders,
    });
    res.end(body);
  }
}
