import { createHmac } from "node:crypto";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayConfig, TeamsConfig, WhatsAppConfig } from "../src/config.js";
import type { InboundMessage } from "../src/types.js";
import {
  WhatsAppChannelAdapter,
  createAdapter as createWhatsApp,
  verifyWhatsAppSignature,
} from "../src/channels/whatsapp.js";
import {
  TeamsChannelAdapter,
  createAdapter as createTeams,
  verifyTeamsHmac,
} from "../src/channels/teams.js";

/* ------------------------------------------------------------------ helpers */

const WA_ACCESS_TOKEN = "wa-test-access-token";
const WA_PHONE_NUMBER_ID = "123456789012345";
const WA_VERIFY_TOKEN = "wa-verify-token-for-tests";
const WA_APP_SECRET = "wa-app-secret-for-tests";

const TEAMS_SECRET_RAW = "teams-signing-secret-for-tests";
const TEAMS_SECRET_B64 = Buffer.from(TEAMS_SECRET_RAW).toString("base64");
const TEAMS_SERVICE_URL = "https://smba.example.test/teams";
const TEAMS_CONVERSATION_ID = "19:channel_test@thread.tacv2";

let tmp: string;
const stops: Array<() => Promise<unknown>> = [];

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "agy-enterprise-channels-"));
});

afterEach(async () => {
  for (const stop of stops.splice(0)) {
    await stop();
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await rm(tmp, { recursive: true, force: true });
});

function makeWhatsAppConfig(overrides: Partial<WhatsAppConfig> = {}): WhatsAppConfig {
  return {
    enabled: true,
    accessToken: WA_ACCESS_TOKEN,
    phoneNumberId: WA_PHONE_NUMBER_ID,
    verifyToken: WA_VERIFY_TOKEN,
    appSecret: WA_APP_SECRET,
    apiVersion: "v21.0",
    webhookHost: "127.0.0.1",
    webhookPort: 0,
    webhookPath: "/whatsapp/webhook",
    allowedUsers: new Set(),
    ...overrides,
  };
}

function makeTeamsConfig(overrides: Partial<TeamsConfig> = {}): TeamsConfig {
  return {
    enabled: true,
    webhookSecret: TEAMS_SECRET_B64,
    appId: "",
    appPassword: "",
    tenantId: "botframework.com",
    incomingWebhookUrl: "",
    webhookHost: "127.0.0.1",
    webhookPort: 0,
    webhookPath: "/teams/messages",
    allowedUsers: new Set(),
    ...overrides,
  };
}

function makeConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    allowedSenders: new Set(),
    allowGroups: true,
    groupMentionPatterns: ["@agy", "@antigravity"],
    agyBin: "agy",
    defaultCwd: tmp,
    approvalMode: "auto",
    healthEnabled: false,
    healthHost: "127.0.0.1",
    healthPort: 0,
    quotaWarnThreshold: 15,
    dataDir: tmp,
    logLevel: "error",
    whatsapp: makeWhatsAppConfig(),
    teams: makeTeamsConfig(),
    ...overrides,
  };
}

function collector() {
  const messages: InboundMessage[] = [];
  return {
    messages,
    handler: (message: InboundMessage) => {
      messages.push(message);
    },
  };
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mockGlobalFetch(handler: (url: string, init?: RequestInit) => Promise<Response>) {
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    handler(String(input), init),
  );
  vi.stubGlobal("fetch", fn);
  return fn;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface HttpResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
}

/** Loopback HTTP request that does not depend on the (mocked) global fetch. */
function httpRequest(options: {
  port: number;
  path: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: options.port,
        path: options.path,
        method: options.method ?? "GET",
        headers: options.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk as Buffer));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            text: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    if (options.body !== undefined) {
      req.write(options.body);
    }
    req.end();
  });
}

/* ------------------------------------------------------------ WhatsApp tests */

function signWhatsApp(body: string | Buffer, secret = WA_APP_SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

function whatsappPayload(messages: unknown[], valueOverrides: Record<string, unknown> = {}) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "waba-test-id",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: {
                display_phone_number: "15550000000",
                phone_number_id: WA_PHONE_NUMBER_ID,
              },
              contacts: [{ profile: { name: "Test User" }, wa_id: "15550000001" }],
              statuses: [{ id: "wamid.status-1", status: "read" }],
              messages,
              ...valueOverrides,
            },
          },
        ],
      },
    ],
  };
}

function postWhatsApp(
  port: number,
  body: string,
  options: { signature?: string | null } = {},
): Promise<HttpResult> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const signature = options.signature === undefined ? signWhatsApp(body) : options.signature;
  if (signature !== null) {
    headers["x-hub-signature-256"] = signature;
  }
  return httpRequest({
    port,
    path: "/whatsapp/webhook",
    method: "POST",
    headers,
    body,
  });
}

async function startWhatsApp(overrides: Partial<WhatsAppConfig> = {}) {
  const adapter = new WhatsAppChannelAdapter(
    makeConfig({ whatsapp: makeWhatsAppConfig(overrides) }),
  );
  stops.push(() => adapter.stop());
  const messages = collector();
  await adapter.start(messages.handler);
  return { adapter, messages: messages.messages, port: adapter.getPort() as number };
}

describe("WhatsApp channel", () => {
  it("exposes the channel name and requires WhatsApp config", () => {
    expect(createWhatsApp(makeConfig()).name).toBe("whatsapp");
    expect(() => createWhatsApp(makeConfig({ whatsapp: undefined }))).toThrow(/not configured/);
  });

  it("serves Meta webhook verification with hub.challenge and rejects wrong tokens", async () => {
    const { port } = await startWhatsApp();

    const ok = await httpRequest({
      port,
      path:
        "/whatsapp/webhook?hub.mode=subscribe" +
        `&hub.verify_token=${encodeURIComponent(WA_VERIFY_TOKEN)}` +
        "&hub.challenge=challenge-123",
    });
    expect(ok.status).toBe(200);
    expect(ok.text).toBe("challenge-123");

    const wrongToken = await httpRequest({
      port,
      path:
        "/whatsapp/webhook?hub.mode=subscribe" +
        "&hub.verify_token=wrong-token&hub.challenge=challenge-123",
    });
    expect(wrongToken.status).toBe(403);

    const wrongMode = await httpRequest({
      port,
      path:
        "/whatsapp/webhook?hub.mode=unsubscribe" +
        `&hub.verify_token=${encodeURIComponent(WA_VERIFY_TOKEN)}` +
        "&hub.challenge=challenge-123",
    });
    expect(wrongMode.status).toBe(403);
  });

  it("verifies X-Hub-Signature-256 with timing-safe HMAC-SHA256", () => {
    const body = Buffer.from(JSON.stringify({ entry: [] }));
    expect(verifyWhatsAppSignature(WA_APP_SECRET, body, signWhatsApp(body))).toBe(true);
    expect(verifyWhatsAppSignature("other-secret", body, signWhatsApp(body))).toBe(false);
    expect(verifyWhatsAppSignature(WA_APP_SECRET, Buffer.from("tampered"), signWhatsApp(body))).toBe(
      false,
    );
    expect(verifyWhatsAppSignature(WA_APP_SECRET, body, "")).toBe(false);
    expect(verifyWhatsAppSignature(WA_APP_SECRET, body, "sha256=not-hex")).toBe(false);
  });

  it("ingests text and interactive replies with raw ids and ignores statuses", async () => {
    const { port, messages } = await startWhatsApp();
    const payload = whatsappPayload([
      {
        from: "15550000001",
        id: "wamid.text-1",
        timestamp: "1700000000",
        type: "text",
        text: { body: "hello gateway" },
      },
      {
        from: "15550000001",
        id: "wamid.button-1",
        timestamp: "1700000001",
        type: "interactive",
        interactive: {
          type: "button_reply",
          button_reply: { id: "btn-yes", title: "Yes please" },
        },
      },
      {
        from: "15550000001",
        id: "wamid.list-1",
        timestamp: "1700000002",
        type: "interactive",
        interactive: {
          type: "list_reply",
          list_reply: { id: "row-1", title: "Deploy" },
        },
      },
    ]);
    const body = JSON.stringify(payload);
    const res = await postWhatsApp(port, body);
    expect(res.status).toBe(200);

    await waitFor(() => messages.length === 3);
    expect(messages[0]).toMatchObject({
      id: "wamid.text-1",
      channel: "whatsapp",
      chatId: "15550000001",
      senderId: "15550000001",
      isGroup: false,
      text: "hello gateway",
      timestamp: 1_700_000_000_000,
      mentionsBot: true,
    });
    expect(
      (messages[0] as InboundMessage & { metadata?: Record<string, unknown> }).metadata,
    ).toMatchObject({
      phoneNumberId: WA_PHONE_NUMBER_ID,
      profileName: "Test User",
    });
    expect(messages[1]).toMatchObject({ id: "wamid.button-1", text: "Yes please" });
    expect(messages[2]).toMatchObject({ id: "wamid.list-1", text: "Deploy" });

    await sleep(50);
    expect(messages).toHaveLength(3);
  });

  it("rejects missing or invalid signatures", async () => {
    const { port, messages } = await startWhatsApp();
    const body = JSON.stringify(
      whatsappPayload([
        {
          from: "15550000001",
          id: "wamid.bad-sig",
          timestamp: "1700000000",
          type: "text",
          text: { body: "should not arrive" },
        },
      ]),
    );

    const invalid = await postWhatsApp(port, body, { signature: signWhatsApp(body, "wrong") });
    expect(invalid.status).toBe(401);
    const missing = await postWhatsApp(port, body, { signature: null });
    expect(missing.status).toBe(401);

    await sleep(60);
    expect(messages).toHaveLength(0);
  });

  it("dedupes repeated message ids across webhook deliveries", async () => {
    const { port, messages } = await startWhatsApp();
    const body = JSON.stringify(
      whatsappPayload([
        {
          from: "15550000001",
          id: "wamid.dup-1",
          timestamp: "1700000000",
          type: "text",
          text: { body: "only once" },
        },
      ]),
    );
    await postWhatsApp(port, body);
    await postWhatsApp(port, body);
    await waitFor(() => messages.length === 1);
    await sleep(60);
    expect(messages).toHaveLength(1);
  });

  it("sends Graph API text messages, chunks to 4096 chars, and sets reply context", async () => {
    const { adapter } = await startWhatsApp();
    let sent = 0;
    const fetchMock = mockGlobalFetch(async () =>
      jsonResponse({ messages: [{ id: `wamid.out-${++sent}` }] }),
    );

    const long = "a".repeat(4096 * 2 + 300);
    const result = await adapter.sendMessage({
      chatId: "15550000001",
      text: long,
      replyToMessageId: "wamid.parent",
    });

    const calls = fetchMock.mock.calls;
    expect(calls).toHaveLength(3);
    expect(String(calls[0]![0])).toBe(
      `https://graph.facebook.com/v21.0/${WA_PHONE_NUMBER_ID}/messages`,
    );
    for (const call of calls) {
      const headers = call[1]?.headers as Record<string, string>;
      expect(headers.Authorization).toBe(`Bearer ${WA_ACCESS_TOKEN}`);
      const body = JSON.parse(String(call[1]?.body));
      expect(body).toMatchObject({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: "15550000001",
        type: "text",
      });
      expect(body.text.body.length).toBeLessThanOrEqual(4096);
    }
    const bodies = calls.map((call) => JSON.parse(String(call[1]?.body)));
    expect(bodies.map((body) => body.text.body).join("")).toBe(long);
    expect(bodies[0].context).toEqual({ message_id: "wamid.parent" });
    expect(bodies[1].context).toBeUndefined();
    expect(result).toEqual({ messageId: "wamid.out-3" });
    expect(adapter.getStats().lastOutboundAt).toBeDefined();
  });

  it("sends outbound media links with a caption", async () => {
    const { adapter } = await startWhatsApp();
    const fetchMock = mockGlobalFetch(async () =>
      jsonResponse({ messages: [{ id: "wamid.media-1" }] }),
    );

    const result = await adapter.sendMessage({
      chatId: "15550000001",
      text: "look at this",
      attachments: [
        {
          url: "https://cdn.example.test/pic.png",
          mimeType: "image/png",
          name: "pic.png",
        },
      ],
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body));
    expect(body).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "15550000001",
      type: "image",
      image: { link: "https://cdn.example.test/pic.png", caption: "look at this" },
    });
    expect(result).toEqual({ messageId: "wamid.media-1" });
  });

  it("returns nothing for empty outbound text and stops cleanly", async () => {
    const { adapter } = await startWhatsApp();
    const fetchMock = mockGlobalFetch(async () => jsonResponse({}));
    await expect(
      adapter.sendMessage({ chatId: "15550000001", text: "   " }),
    ).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();

    await adapter.stop();
    expect(adapter.isConnected()).toBe(false);
  });
});

/* ---------------------------------------------------------------- Teams tests */

function signTeams(body: string, secretB64 = TEAMS_SECRET_B64): string {
  return `HMAC ${createHmac("sha256", Buffer.from(secretB64, "base64"))
    .update(body)
    .digest("base64")}`;
}

function teamsActivity(overrides: Record<string, unknown> = {}) {
  return {
    type: "message",
    id: "activity-1",
    text: "<at>Antigravity</at> hello team",
    from: { id: "user-raw-1", name: "Test User" },
    conversation: { id: TEAMS_CONVERSATION_ID, conversationType: "channel" },
    serviceUrl: TEAMS_SERVICE_URL,
    channelData: { tenant: { id: "tenant-raw-1" } },
    replyToId: "parent-activity",
    timestamp: "2024-01-02T03:04:05.000Z",
    ...overrides,
  };
}

function postTeams(
  port: number,
  body: string,
  options: { authorization?: string | null } = {},
): Promise<HttpResult> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const authorization =
    options.authorization === undefined ? signTeams(body) : options.authorization;
  if (authorization !== null) {
    headers.authorization = authorization;
  }
  return httpRequest({
    port,
    path: "/teams/messages",
    method: "POST",
    headers,
    body,
  });
}

async function startTeams(overrides: Partial<TeamsConfig> = {}) {
  const adapter = new TeamsChannelAdapter(makeConfig({ teams: makeTeamsConfig(overrides) }));
  stops.push(() => adapter.stop());
  const messages = collector();
  await adapter.start(messages.handler);
  return { adapter, messages: messages.messages, port: adapter.getPort() as number };
}

describe("Teams channel", () => {
  it("exposes the channel name and requires Teams config", () => {
    expect(createTeams(makeConfig()).name).toBe("teams");
    expect(() => createTeams(makeConfig({ teams: undefined }))).toThrow(/not configured/);
  });

  it("verifies Authorization: HMAC with timing-safe HMAC-SHA256", () => {
    const body = Buffer.from(JSON.stringify({ type: "message" }));
    expect(verifyTeamsHmac(TEAMS_SECRET_B64, body, signTeams(body.toString()))).toBe(true);
    expect(verifyTeamsHmac(TEAMS_SECRET_B64, body, signTeams("tampered"))).toBe(false);
    expect(verifyTeamsHmac(TEAMS_SECRET_B64, body, "")).toBe(false);
    expect(verifyTeamsHmac(TEAMS_SECRET_B64, body, "Bearer token")).toBe(false);
    expect(verifyTeamsHmac("", body, signTeams(body.toString()))).toBe(false);
  });

  it("accepts signed outgoing webhooks and strips <at> mention tags", async () => {
    const { port, messages } = await startTeams();
    const activity = teamsActivity();
    const body = JSON.stringify(activity);
    const res = await postTeams(port, body);
    expect(res.status).toBe(200);

    await waitFor(() => messages.length === 1);
    expect(messages[0]).toMatchObject({
      id: "activity-1",
      channel: "teams",
      chatId: TEAMS_CONVERSATION_ID,
      senderId: "user-raw-1",
      isGroup: true,
      text: "hello team",
      mentionsBot: true,
      replyToMessageId: "parent-activity",
      timestamp: Date.parse("2024-01-02T03:04:05.000Z"),
    });
    expect(
      (messages[0] as InboundMessage & { metadata?: Record<string, unknown> }).metadata,
    ).toMatchObject({
      serviceUrl: TEAMS_SERVICE_URL,
      fromName: "Test User",
      conversationType: "channel",
    });
  });

  it("rejects missing or invalid HMAC signatures", async () => {
    const { port, messages } = await startTeams();
    const body = JSON.stringify(teamsActivity({ id: "activity-bad-hmac" }));

    const invalid = await postTeams(port, body, {
      authorization: signTeams(body, Buffer.from("wrong-secret").toString("base64")),
    });
    expect(invalid.status).toBe(401);
    const missing = await postTeams(port, body, { authorization: null });
    expect(missing.status).toBe(401);

    await sleep(60);
    expect(messages).toHaveLength(0);
  });

  it("caches Bot Framework OAuth tokens and sends proactive activities via the cached serviceUrl", async () => {
    const { adapter, port, messages } = await startTeams({
      appId: "teams-app-id-for-tests",
      appPassword: "teams-app-password-for-tests",
      tenantId: "tenant-for-tests",
      incomingWebhookUrl: "",
    });

    const inboundBody = JSON.stringify(
      teamsActivity({ id: "activity-cache-1", text: "<at>Antigravity</at> ping" }),
    );
    const inboundRes = await postTeams(port, inboundBody);
    expect(inboundRes.status).toBe(200);
    await waitFor(() => messages.length === 1);

    let outbound = 0;
    const tokenUrl = "https://login.microsoftonline.com/tenant-for-tests/oauth2/v2.0/token";
    const activityUrl = `${TEAMS_SERVICE_URL}/v3/conversations/${encodeURIComponent(
      TEAMS_CONVERSATION_ID,
    )}/activities`;
    const fetchMock = mockGlobalFetch(async (url) => {
      if (url === tokenUrl) {
        return jsonResponse({
          token_type: "Bearer",
          expires_in: 3600,
          access_token: "bf-access-token-for-tests",
        });
      }
      if (url === activityUrl) {
        outbound += 1;
        return jsonResponse({ id: `bf-out-${outbound}` });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const first = await adapter.sendMessage({
      chatId: TEAMS_CONVERSATION_ID,
      text: "proactive reply",
      replyToMessageId: "parent-activity",
    });
    const second = await adapter.sendMessage({
      chatId: TEAMS_CONVERSATION_ID,
      text: "second reply",
    });

    const urls = fetchMock.mock.calls.map((call) => String(call[0]));
    const tokenCalls = urls.filter((url) => url === tokenUrl);
    expect(tokenCalls).toHaveLength(1);

    const tokenInit = fetchMock.mock.calls[urls.indexOf(tokenUrl)]![1];
    const params = new URLSearchParams(String(tokenInit?.body));
    expect(params.get("grant_type")).toBe("client_credentials");
    expect(params.get("client_id")).toBe("teams-app-id-for-tests");
    expect(params.get("client_secret")).toBe("teams-app-password-for-tests");
    expect(params.get("scope")).toBe("https://api.botframework.com/.default");

    const activityCalls = fetchMock.mock.calls.filter((call) => String(call[0]) === activityUrl);
    expect(activityCalls).toHaveLength(2);
    for (const call of activityCalls) {
      const headers = call[1]?.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer bf-access-token-for-tests");
    }
    expect(JSON.parse(String(activityCalls[0]![1]?.body))).toEqual({
      type: "message",
      text: "proactive reply",
      replyToId: "parent-activity",
    });
    expect(JSON.parse(String(activityCalls[1]![1]?.body))).toEqual({
      type: "message",
      text: "second reply",
    });
    expect(first).toEqual({ messageId: "bf-out-1" });
    expect(second).toEqual({ messageId: "bf-out-2" });
    expect(adapter.getStats().lastOutboundAt).toBeDefined();
  });

  it("falls back to the incoming webhook and chunks to 4000 chars", async () => {
    const webhookUrl = "https://teams.example.test/webhooks/incoming";
    const { adapter } = await startTeams({
      webhookSecret: "",
      incomingWebhookUrl: webhookUrl,
      appId: "",
      appPassword: "",
    });
    const fetchMock = mockGlobalFetch(async () => new Response("1", { status: 200 }));

    await adapter.sendMessage({ chatId: "channel-without-cache", text: "fallback hello" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(webhookUrl);
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toMatchObject({ text: "fallback hello" });

    fetchMock.mockClear();
    const long = "b".repeat(4500);
    await adapter.sendMessage({ chatId: "channel-without-cache", text: long });
    const calls = fetchMock.mock.calls;
    expect(calls).toHaveLength(2);
    const chunks = calls.map((call) => JSON.parse(String(call[1]?.body)).text as string);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(4000);
    }
    expect(chunks.join("")).toBe(long);
  });

  it("throws a clear error when neither serviceUrl nor incoming webhook can be used", async () => {
    const { adapter } = await startTeams({
      webhookSecret: TEAMS_SECRET_B64,
      incomingWebhookUrl: "",
      appId: "",
      appPassword: "",
    });
    await expect(
      adapter.sendMessage({ chatId: "channel-without-cache", text: "nowhere to send" }),
    ).rejects.toThrow(/cannot send/i);
  });

  it("stops cleanly", async () => {
    const { adapter } = await startTeams();
    expect(adapter.isConnected()).toBe(true);
    await adapter.stop();
    expect(adapter.isConnected()).toBe(false);
  });
});