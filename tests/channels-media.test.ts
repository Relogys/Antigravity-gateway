import { createHmac } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GatewayConfig, MatrixConfig, TelegramConfig, WhatsAppConfig } from "../src/config.js";
import { MAX_INBOUND_MEDIA_BYTES, downloadInboundMedia } from "../src/channels/media.js";
import { TelegramChannelAdapter } from "../src/channels/telegram.js";
import { WhatsAppChannelAdapter } from "../src/channels/whatsapp.js";
import { MatrixChannelAdapter } from "../src/channels/matrix.js";
import type { InboundAttachment, InboundMessage } from "../src/types.js";

/* ------------------------------------------------------------------ helpers */

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_BYTES = Buffer.concat([PNG_MAGIC, Buffer.from([0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52])]);

const BOT_TOKEN = "test-bot-token";
const WA_TOKEN = "wa-test-access-token";
const WA_PHONE_ID = "123456789012345";
const WA_VERIFY_TOKEN = "wa-verify-token-for-tests";
const WA_SECRET = "wa-app-secret-for-tests";
const MATRIX_HS = "https://matrix.example.org";

type KindedAttachment = InboundAttachment & { kind?: string };

let tmp: string;
const stops: Array<() => Promise<unknown>> = [];

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "agy-media-bridge-"));
});

afterEach(async () => {
  for (const stop of stops.splice(0)) {
    await stop();
  }
  await rm(tmp, { recursive: true, force: true });
});

function makeConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    allowedSenders: new Set(),
    allowGroups: true,
    groupMentionPatterns: ["@agy"],
    agyBin: "agy",
    defaultCwd: tmp,
    approvalMode: "auto",
    healthEnabled: false,
    healthHost: "127.0.0.1",
    healthPort: 0,
    quotaWarnThreshold: 15,
    dataDir: tmp,
    logLevel: "error",
    ...overrides,
  };
}

function telegramConfig(): TelegramConfig {
  return { botToken: BOT_TOKEN, allowedUsers: new Set(), pollTimeoutSec: 1 };
}

function matrixConfig(): MatrixConfig {
  return {
    homeserverUrl: MATRIX_HS,
    accessToken: "test-access-token",
    userId: "@bot:example.org",
    allowedUsers: new Set(),
  };
}

function whatsappConfig(): WhatsAppConfig {
  return {
    enabled: true,
    accessToken: WA_TOKEN,
    phoneNumberId: WA_PHONE_ID,
    verifyToken: WA_VERIFY_TOKEN,
    appSecret: WA_SECRET,
    apiVersion: "v21.0",
    webhookHost: "127.0.0.1",
    webhookPort: 0,
    webhookPath: "/whatsapp/webhook",
    allowedUsers: new Set(),
  };
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function binary(data: Buffer, contentType: string): Response {
  return new Response(new Uint8Array(data), {
    status: 200,
    headers: { "content-type": contentType },
  });
}

function pendingResponse(init?: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const signal = init?.signal;
    const abort = () => reject(new DOMException("Aborted", "AbortError"));
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });
  });
}

async function waitFor(check: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function collector() {
  const messages: InboundMessage[] = [];
  return { messages, handler: (message: InboundMessage) => void messages.push(message) };
}

/* ------------------------------------------------------- downloadInboundMedia */

describe("downloadInboundMedia", () => {
  it("persists binary bytes intact (PNG magic preserved)", async () => {
    const mediaDir = path.join(tmp, "media");
    const result = await downloadInboundMedia({
      url: "https://cdn.example.test/picture.png",
      mediaDir,
      fetchImpl: (async () => binary(PNG_BYTES, "image/png")) as typeof fetch,
    });

    expect(result.mimeType).toBe("image/png");
    expect(result.sizeBytes).toBe(PNG_BYTES.byteLength);
    expect(result.name).toMatch(/\.png$/);
    expect(path.dirname(result.localPath)).toBe(path.resolve(mediaDir));

    const onDisk = await readFile(result.localPath);
    expect(onDisk.byteLength).toBe(PNG_BYTES.byteLength);
    expect(onDisk.subarray(0, PNG_MAGIC.byteLength)).toEqual(PNG_MAGIC);
  });

  it("rejects non-http(s) URLs", async () => {
    const mediaDir = path.join(tmp, "media");
    await expect(
      downloadInboundMedia({ url: "file:///etc/passwd", mediaDir }),
    ).rejects.toThrow(/non-HTTP/i);
    await expect(
      downloadInboundMedia({ url: "data:text/plain,hello", mediaDir }),
    ).rejects.toThrow(/non-HTTP/i);
  });

  it("rejects payloads exceeding maxBytes", async () => {
    const mediaDir = path.join(tmp, "media");
    await expect(
      downloadInboundMedia({
        url: "https://cdn.example.test/big.bin",
        mediaDir,
        maxBytes: 8,
        fetchImpl: (async () => binary(Buffer.alloc(32, 1), "application/octet-stream")) as typeof fetch,
      }),
    ).rejects.toThrow(/exceeds 8 bytes/);
  });

  it("passes caller auth headers through to the request", async () => {
    const mediaDir = path.join(tmp, "media");
    const seen: Array<Record<string, string> | undefined> = [];
    await downloadInboundMedia({
      url: "https://cdn.example.test/secret.png",
      mediaDir,
      headers: { Authorization: "Bearer sekret" },
      fetchImpl: (async (_url: RequestInfo | URL, init?: RequestInit) => {
        seen.push(init?.headers as Record<string, string> | undefined);
        return binary(PNG_BYTES, "image/png");
      }) as typeof fetch,
    });
    expect(seen[0]?.Authorization).toBe("Bearer sekret");
  });

  it("sanitizes hostile filenames and keeps writes inside the media dir", async () => {
    const mediaDir = path.join(tmp, "media");
    const result = await downloadInboundMedia({
      url: "https://cdn.example.test/drop",
      mediaDir,
      filenameHint: "../../etc/passwd.png",
      fetchImpl: (async () => binary(PNG_BYTES, "image/png")) as typeof fetch,
    });

    expect(result.name).not.toContain("/");
    expect(result.name).not.toContain("\\");
    expect(result.name).not.toContain("..");
    expect(path.dirname(result.localPath)).toBe(path.resolve(mediaDir));
    expect(path.basename(result.localPath)).not.toContain("..");
  });

  it("exposes a 15 MiB default cap", () => {
    expect(MAX_INBOUND_MEDIA_BYTES).toBe(15 * 1024 * 1024);
  });
});

/* ---------------------------------------------------------------- Telegram */

function makeTelegramFetch(options: { failGetFile?: boolean } = {}) {
  const calls: Array<{ url: string; body?: any }> = [];
  let servedUpdate = false;
  const impl = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url.includes("/file/bot")) {
      calls.push({ url });
      return binary(PNG_BYTES, "image/png");
    }
    const method = url.split("/").pop() ?? "";
    let body: any = init?.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        // keep raw body
      }
    }
    calls.push({ url, body });

    if (method === "getMe") {
      return json({ ok: true, result: { id: 777, is_bot: true, username: "agy_bot" } });
    }
    if (method === "getFile") {
      if (options.failGetFile) {
        return json({ ok: false, description: "file unavailable" }, 500);
      }
      return json({ ok: true, result: { file_path: "photos/file_1.jpg" } });
    }
    if (method === "getUpdates") {
      if (!servedUpdate) {
        servedUpdate = true;
        return json({
          ok: true,
          result: [
            {
              update_id: 1,
              message: {
                message_id: 10,
                date: 1_700_000_000,
                chat: { id: 4242, type: "private" },
                from: { id: 99, is_bot: false },
                caption: "look at this",
                photo: [
                  { file_id: "small", file_size: 5, width: 10, height: 10 },
                  { file_id: "large", file_size: 900, width: 800, height: 600 },
                ],
              },
            },
          ],
        });
      }
      return pendingResponse(init);
    }
    return json({ ok: true, result: true });
  };
  return { impl, calls };
}

describe("Telegram inbound image media bridge", () => {
  it("resolves getFile and downloads the photo into attachments", async () => {
    const fake = makeTelegramFetch();
    const adapter = new TelegramChannelAdapter(
      makeConfig({ telegram: telegramConfig() }),
      { fetchImpl: fake.impl, mediaDir: path.join(tmp, "media"), backoffMs: () => 5 },
    );
    stops.push(() => adapter.stop());
    const c = collector();
    await adapter.start(c.handler);

    await waitFor(() => c.messages.length === 1);
    const msg = c.messages[0]!;
    expect(msg.text).toBe("look at this");
    expect(msg.attachments).toHaveLength(1);

    const att = msg.attachments[0] as KindedAttachment;
    expect(att.type).toBe("image");
    expect(att.kind).toBe("image");
    expect(att.mimeType).toBe("image/png");
    expect(att.localPath).toBeDefined();
    expect((await readFile(att.localPath!)).subarray(0, 8)).toEqual(PNG_MAGIC);

    expect(fake.calls.some((call) => call.url.endsWith("/getFile"))).toBe(true);
    const downloadCall = fake.calls.find((call) => call.url.includes("/file/bot"));
    expect(downloadCall?.url).toBe(
      `https://api.telegram.org/file/bot${BOT_TOKEN}/photos/file_1.jpg`,
    );
  });

  it("keeps the caption when the download fails", async () => {
    const fake = makeTelegramFetch({ failGetFile: true });
    const adapter = new TelegramChannelAdapter(
      makeConfig({ telegram: telegramConfig() }),
      { fetchImpl: fake.impl, mediaDir: path.join(tmp, "media"), backoffMs: () => 5 },
    );
    stops.push(() => adapter.stop());
    const c = collector();
    await adapter.start(c.handler);

    await waitFor(() => c.messages.length === 1);
    expect(c.messages[0]!.text).toBe("look at this");
    expect(c.messages[0]!.attachments).toHaveLength(0);
  });
});

/* ---------------------------------------------------------------- WhatsApp */

function signWhatsApp(body: string): string {
  return `sha256=${createHmac("sha256", WA_SECRET).update(body).digest("hex")}`;
}

function httpPost(port: number, pathName: string, body: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: pathName, method: "POST", headers },
      (res) => {
        res.on("data", () => {});
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

/* --------------------------------------------------------------- Matrix */

function makeMatrixFetch(pngBytes: Buffer) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let syncCount = 0;
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init });
    if (url.includes("/account_data/m.direct")) {
      return json({});
    }
    if (url.includes("/_matrix/client/v3/sync")) {
      syncCount += 1;
      if (!new URL(url).searchParams.get("since")) {
        return json({ next_batch: "m1" });
      }
      if (syncCount === 2) {
        return json({
          next_batch: "m2",
          rooms: {
            join: {
              "!room:example.org": {
                summary: { "m.joined_member_count": 3 },
                timeline: {
                  events: [
                    {
                      type: "m.room.message",
                      event_id: "$img",
                      sender: "@alice:example.org",
                      origin_server_ts: 300,
                      content: {
                        msgtype: "m.image",
                        body: "cat.png",
                        filename: "cat.png",
                        url: "mxc://example.org/media123",
                        info: { mimetype: "image/png", size: pngBytes.byteLength },
                      },
                    },
                  ],
                },
              },
            },
          },
        });
      }
      return pendingResponse(init);
    }
    if (url.includes("/_matrix/client/v1/media/download/example.org/media123")) {
      return binary(pngBytes, "image/png");
    }
    if (url.includes("/_matrix/media/v3/download/example.org/media123")) {
      return binary(pngBytes, "image/png");
    }
    throw new Error(`Unexpected request ${url}`);
  };
  return { impl: impl as unknown as typeof fetch, calls };
}

describe("Matrix inbound mxc media bridge", () => {
  it("downloads m.image via the authenticated media endpoint", async () => {
    const fake = makeMatrixFetch(PNG_BYTES);
    const adapter = new MatrixChannelAdapter(
      makeConfig({ matrix: matrixConfig() }),
      { fetchImpl: fake.impl },
    );
    stops.push(() => adapter.stop());
    const c = collector();
    await adapter.start(c.handler);

    await waitFor(() => c.messages.length === 1);
    const att = c.messages[0]!.attachments[0] as KindedAttachment;
    expect(att.type).toBe("image");
    expect(att.kind).toBe("image");
    expect(att.mimeType).toBe("image/png");
    expect(att.name).toBe("cat.png");
    expect(att.localPath).toBeDefined();
    expect((await readFile(att.localPath!)).subarray(0, 8)).toEqual(PNG_MAGIC);

    const mediaCalls = fake.calls.filter((call) => call.url.includes("download/example.org/media123"));
    expect(mediaCalls).toHaveLength(1);
    expect(mediaCalls[0]!.url).toContain("/_matrix/client/v1/media/download/example.org/media123");
    const auth = (mediaCalls[0]!.init?.headers as Record<string, string> | undefined)?.Authorization;
    expect(auth).toBe("Bearer test-access-token");
  });
});

/* --------------------------------------------------------------- WhatsApp */

describe("WhatsApp inbound image media bridge", () => {
  it("resolves the media URL and downloads with bearer auth", async () => {
    const calls: Array<{ url: string; headers?: Record<string, string> }> = [];
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      calls.push({ url, headers: init?.headers as Record<string, string> | undefined });
      if (url.includes(`/v21.0/MEDIA123`)) {
        return json({ url: "https://cdn.example.test/wa-image.png", mime_type: "image/png" });
      }
      if (url === "https://cdn.example.test/wa-image.png") {
        return binary(PNG_BYTES, "image/png");
      }
      throw new Error(`Unexpected request ${url}`);
    };

    const adapter = new WhatsAppChannelAdapter(
      makeConfig({ whatsapp: whatsappConfig() }),
      { fetchImpl: fetchImpl as typeof fetch },
    );
    stops.push(() => adapter.stop());
    const c = collector();
    await adapter.start(c.handler);
    const port = adapter.getPort() as number;

    const payload = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "waba-test",
          changes: [
            {
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                metadata: { display_phone_number: "15550000000", phone_number_id: WA_PHONE_ID },
                contacts: [{ profile: { name: "Test User" }, wa_id: "15550000001" }],
                messages: [
                  {
                    from: "15550000001",
                    id: "wamid.image-1",
                    timestamp: "1700000000",
                    type: "image",
                    image: { id: "MEDIA123", mime_type: "image/png", caption: "look at this" },
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    const status = await httpPost(port, "/whatsapp/webhook", payload, {
      "content-type": "application/json",
      "x-hub-signature-256": signWhatsApp(payload),
    });
    expect(status).toBe(200);

    await waitFor(() => c.messages.length === 1);
    const msg = c.messages[0]!;
    expect(msg.text).toBe("look at this");
    const att = msg.attachments[0] as KindedAttachment;
    expect(att.type).toBe("image");
    expect(att.kind).toBe("image");
    expect(att.mimeType).toBe("image/png");
    expect(att.localPath).toBeDefined();
    expect((await readFile(att.localPath!)).subarray(0, 8)).toEqual(PNG_MAGIC);

    const metaCall = calls.find((call) => call.url.includes("/v21.0/MEDIA123"));
    expect(metaCall?.headers?.Authorization).toBe(`Bearer ${WA_TOKEN}`);
    const mediaCall = calls.find((call) => call.url === "https://cdn.example.test/wa-image.png");
    expect(mediaCall?.headers?.Authorization).toBe(`Bearer ${WA_TOKEN}`);
  });
});