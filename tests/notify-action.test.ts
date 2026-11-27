import { createHmac } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
// Plain ESM JavaScript action helper shipped without type declarations.
// @ts-expect-error -- resolved at runtime by Node/Vitest
import {
  buildSignedWebhookHeaders,
  sendWebhookNotification,
} from "../.github/actions/notify/send.mjs";

const SECRET = "unit-test-hmac-secret";
const TOKEN = "unit-test-bearer-token";
const FIXED_TS = 1_700_000_000;
const FIXED_ID = "11111111-1111-4111-8111-111111111111";
const BODY = JSON.stringify({ chatId: "chat-1", text: "ping" });

function expectedSignature(timestamp: string | number, deliveryId: string, body: string): string {
  const digest = createHmac("sha256", SECRET)
    .update(`${timestamp}.${deliveryId}.${body}`)
    .digest("hex");
  return `sha256=${digest}`;
}

interface CapturedRequest {
  headers: http.IncomingHttpHeaders;
  body: string;
}

interface TestServer {
  endpoint: string;
  captured: CapturedRequest[];
  close: () => Promise<void>;
}

const openServers: TestServer[] = [];

async function startServer(
  respond: (request: CapturedRequest) => { status: number; body: unknown },
): Promise<TestServer> {
  const captured: CapturedRequest[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const request: CapturedRequest = {
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      captured.push(request);
      const { status, body } = respond(request);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  const testServer: TestServer = {
    endpoint: `http://127.0.0.1:${port}/v1/messages`,
    captured,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
  openServers.push(testServer);
  return testServer;
}

afterEach(async () => {
  while (openServers.length > 0) {
    await openServers.pop()?.close();
  }
});

describe("buildSignedWebhookHeaders", () => {
  it("signs `${timestamp}.${deliveryId}.${body}` and adds the Bearer token", () => {
    const headers = buildSignedWebhookHeaders({
      body: BODY,
      secret: SECRET,
      token: TOKEN,
      timestamp: FIXED_TS,
      deliveryId: FIXED_ID,
    });

    expect(headers["X-Webhook-Timestamp"]).toBe(String(FIXED_TS));
    expect(headers["X-Webhook-Id"]).toBe(FIXED_ID);
    expect(headers["X-Webhook-Signature"]).toBe(expectedSignature(FIXED_TS, FIXED_ID, BODY));
    expect(headers["X-Webhook-Signature"]).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("normalizes millisecond timestamps to Unix seconds", () => {
    const headers = buildSignedWebhookHeaders({
      body: BODY,
      secret: SECRET,
      timestamp: FIXED_TS * 1000,
      deliveryId: FIXED_ID,
    });

    expect(headers["X-Webhook-Timestamp"]).toBe(String(FIXED_TS));
    expect(headers["X-Webhook-Signature"]).toBe(expectedSignature(FIXED_TS, FIXED_ID, BODY));
  });

  it("still sends anti-replay headers when no secret or token is configured", () => {
    const first = buildSignedWebhookHeaders({ body: BODY });
    const second = buildSignedWebhookHeaders({ body: BODY });

    expect(first["X-Webhook-Timestamp"]).toMatch(/^\d+$/);
    expect(first["X-Webhook-Id"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(first["X-Webhook-Id"]).not.toBe(second["X-Webhook-Id"]);
    expect(first["X-Webhook-Signature"]).toBeUndefined();
    expect(first.Authorization).toBeUndefined();
  });
});

describe("sendWebhookNotification", () => {
  it("delivers a signed, authenticated request and parses wait replies end-to-end", async () => {
    const replies = [
      {
        messageId: "reply-1",
        chatId: "chat-1",
        text: "pong",
        attachments: [],
        timestamp: FIXED_TS * 1000,
      },
    ];
    const server = await startServer(() => ({
      status: 200,
      body: { ok: true, messageId: "gw-msg-1", replies },
    }));

    const result = await sendWebhookNotification({
      url: server.endpoint,
      chatId: "chat-1",
      text: "ping",
      senderId: "sender-9",
      token: TOKEN,
      secret: SECRET,
      wait: true,
      timeoutMs: 5_000,
    });

    expect(server.captured).toHaveLength(1);
    const request = server.captured[0];
    const timestamp = request.headers["x-webhook-timestamp"];
    const deliveryId = request.headers["x-webhook-id"];

    expect(typeof timestamp).toBe("string");
    expect(timestamp).toMatch(/^\d+$/);
    expect(String(deliveryId)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(request.headers["x-webhook-signature"]).toBe(
      expectedSignature(String(timestamp), String(deliveryId), request.body),
    );
    expect(request.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(request.headers["content-type"]).toContain("application/json");

    expect(JSON.parse(request.body)).toEqual({
      chatId: "chat-1",
      text: "ping",
      senderId: "sender-9",
      wait: true,
      timeoutMs: 5_000,
    });

    expect(result.status).toBe(200);
    expect(result.messageId).toBe("gw-msg-1");
    expect(result.replies).toEqual(replies);
  });

  it("sends fire-and-forget payloads without wait fields by default", async () => {
    const server = await startServer(() => ({
      status: 202,
      body: { ok: true, messageId: "gw-msg-2" },
    }));

    const result = await sendWebhookNotification({
      url: server.endpoint,
      chatId: "chat-2",
      text: "hello",
      secret: SECRET,
    });

    expect(JSON.parse(server.captured[0].body)).toEqual({
      chatId: "chat-2",
      text: "hello",
    });
    expect(result.status).toBe(202);
    expect(result.messageId).toBe("gw-msg-2");
    expect(result.replies).toEqual([]);
  });

  it("rejects non-2xx responses with a clear error", async () => {
    const server = await startServer(() => ({
      status: 401,
      body: { error: "unauthorized" },
    }));

    await expect(
      sendWebhookNotification({
        url: server.endpoint,
        chatId: "chat-3",
        text: "nope",
        secret: SECRET,
        timeoutMs: 5_000,
      }),
    ).rejects.toThrow(/HTTP 401/);
    expect(server.captured).toHaveLength(1);
  });

  it("rejects invalid inputs before any network call", async () => {
    await expect(
      sendWebhookNotification({ url: "ftp://example.com/hook", chatId: "c", text: "t" }),
    ).rejects.toThrow(/http or https/);
    await expect(
      sendWebhookNotification({ url: "http://127.0.0.1:9/hook", chatId: "c", text: "  " }),
    ).rejects.toThrow(/text is required/);
  });
});