import crypto from "node:crypto";
import http from "node:http";
import { isLoopbackHost } from "./channels/utils.js";
import type { GatewayConfig } from "./config.js";
import { redactSecrets } from "./logger.js";
import type { HealthSnapshot } from "./types.js";

function verifyBearerToken(req: http.IncomingMessage, expectedToken: string): boolean {
  const raw = req.headers.authorization;
  const header = Array.isArray(raw) ? (raw[0] ?? "") : (raw ?? "");
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) {
    return false;
  }
  const provided = match[1].trim();
  const a = crypto.createHash("sha256").update(provided).digest();
  const b = crypto.createHash("sha256").update(expectedToken).digest();
  return crypto.timingSafeEqual(a, b);
}

/**
 * Read-only health & status HTTP server (`GET /healthz`, `GET /readyz`, `GET /status`).
 * Never exposes secrets or personal sender identifiers; redacts error strings and
 * optionally protects `/status` with `HEALTH_TOKEN` Bearer auth.
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
