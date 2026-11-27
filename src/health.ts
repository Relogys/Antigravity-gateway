import http from "node:http";
import type { GatewayConfig } from "./config.js";
import type { HealthSnapshot } from "./types.js";

/**
 * Read-only localhost health & status HTTP server (`GET /healthz`, `GET /status`).
 * Never exposes secrets or personal sender identifiers.
 */
export class HealthServer {
  private server: http.Server | null = null;

  constructor(
    private readonly config: Pick<GatewayConfig, "healthHost" | "healthPort">,
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
        const isOk = snapshot.status === "ok";
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

      if (urlPath === "/status") {
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
          lastError: snapshot.lastError,
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
                    lastError: c.lastError,
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
  ): void {
    const body = JSON.stringify(payload);
    res.writeHead(statusCode, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Length": Buffer.byteLength(body),
    });
    res.end(body);
  }
}
