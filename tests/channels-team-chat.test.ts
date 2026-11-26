import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GatewayConfig, RocketChatConfig, ZulipConfig } from "../src/config.js";
import type { InboundMessage } from "../src/types.js";
import { ZulipChannelAdapter, createAdapter as createZulipAdapter } from "../src/channels/zulip.js";
import {
  RocketChatChannelAdapter,
  createAdapter as createRocketChatAdapter,
  type RocketChatWebSocketCtor,
} from "../src/channels/rocketchat.js";

const ZULIP_SITE = "https://zulip.example.org";
const ZULIP_BOT_EMAIL = "gateway-bot@zulip.example.org";
const ZULIP_API_KEY = "test-zulip-api-key";
const RC_URL = "http://localhost:3000";
const RC_USER_ID = "rc-bot-id";
const RC_AUTH_TOKEN = "test-auth-token";

interface FetchCall {
  url: string;
  init?: RequestInit;
}

type FetchHandler = (url: string, init?: RequestInit) => Response | Promise<Response>;

function createFetch(handler: FetchHandler): { impl: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init });
    return handler(url, init);
  };
  return { impl: impl as unknown as typeof fetch, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function pendingFetch(init?: RequestInit): Promise<Response> {
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

function headersOf(init?: RequestInit): Record<string, string> {
  return (init?.headers ?? {}) as Record<string, string>;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(assertion: () => void, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      assertion();
      return;
    } catch (err) {
      if (Date.now() >= deadline) {
        throw err;
      }
      await delay(10);
    }
  }
}

interface Stoppable {
  stop(): Promise<void>;
}

let tempDir = "";
const running: Stoppable[] = [];

function makeConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    allowedSenders: new Set<string>(),
    allowGroups: true,
    groupMentionPatterns: ["@agy"],
    agyBin: "agy",
    defaultCwd: process.cwd(),
    approvalMode: "auto",
    healthEnabled: false,
    healthHost: "127.0.0.1",
    healthPort: 18_790,
    quotaWarnThreshold: 15,
    dataDir: tempDir,
    logLevel: "error",
    ...overrides,
  };
}

function zulipConfig(overrides: Partial<ZulipConfig> = {}): GatewayConfig {
  return makeConfig({
    zulip: {
      enabled: true,
      site: ZULIP_SITE,
      botEmail: ZULIP_BOT_EMAIL,
      apiKey: ZULIP_API_KEY,
      streams: ["general"],
      requireMention: true,
      allowedUsers: new Set<string>(),
      ...overrides,
    },
  });
}

function rocketchatConfig(overrides: Partial<RocketChatConfig> = {}): GatewayConfig {
  return makeConfig({
    rocketchat: {
      enabled: true,
      url: RC_URL,
      userId: RC_USER_ID,
      authToken: RC_AUTH_TOKEN,
      requireMention: true,
      allowedUsers: new Set<string>(),
      ...overrides,
    },
  });
}

const BASIC_AUTH = `Basic ${Buffer.from(`${ZULIP_BOT_EMAIL}:${ZULIP_API_KEY}`).toString("base64")}`;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "channels-team-chat-"));
  FakeWebSocket.instances = [];
});

afterEach(async () => {
  for (const adapter of running.splice(0)) {
    try {
      await adapter.stop();
    } catch {
      // best-effort shutdown
    }
  }
  await rm(tempDir, { recursive: true, force: true });
});

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];

  readonly url: string;
  readonly sent: string[] = [];
  closed = false;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.onclose?.({});
  }

  open(): void {
    this.onopen?.({});
  }

  deliver(payload: unknown): void {
    this.onmessage?.({ data: typeof payload === "string" ? payload : JSON.stringify(payload) });
  }
}

/* -------------------------------------------------------------------- Zulip */

async function startZulip(
  impl: typeof fetch,
  messages: InboundMessage[],
  overrides: Partial<ZulipConfig> = {},
): Promise<ZulipChannelAdapter> {
  const adapter = new ZulipChannelAdapter(zulipConfig(overrides), { fetchImpl: impl });
  running.push(adapter);
  await adapter.start((msg) => {
    messages.push(msg);
  });
  return adapter;
}

function registerResponse(overrides: Record<string, unknown> = {}): Response {
  return json({
    result: "success",
    msg: "",
    queue_id: "queue-1",
    last_event_id: 10,
    full_name: "Gateway Bot",
    user_id: 42,
    ...overrides,
  });
}

function streamEvent(id: number, content: string, subject = "ops", sender = "alice@zulip.example.org") {
  return {
    type: "message",
    message: {
      id,
      type: "stream",
      sender_email: sender,
      sender_full_name: "Alice",
      display_recipient: "general",
      subject,
      content,
      timestamp: 1_700_000_000 + id,
    },
  };
}

function directEvent(id: number, content: string, sender = "bob@zulip.example.org") {
  return {
    type: "message",
    message: {
      id,
      type: "private",
      sender_email: sender,
      sender_full_name: "Bob",
      display_recipient: [{ email: ZULIP_BOT_EMAIL }, { email: sender }],
      content,
      timestamp: 1_700_000_000 + id,
    },
  };
}

describe("adapter factories", () => {
  it("exposes createAdapter factories with stable channel names", () => {
    expect(createZulipAdapter(zulipConfig()).name).toBe("zulip");
    expect(createRocketChatAdapter(rocketchatConfig()).name).toBe("rocketchat");
  });
});

describe("ZulipChannelAdapter", () => {
  it("registers a queue and ingests stream + direct messages with filters and mention stripping", async () => {
    const events = [
      streamEvent(11, "@**Gateway Bot** deploy status?"),
      streamEvent(11, "@**Gateway Bot** deploy status?"),
      streamEvent(12, "no mention here"),
      directEvent(13, "hello via dm"),
      streamEvent(14, "self echo", "ops", ZULIP_BOT_EMAIL),
    ];

    let eventsCalls = 0;
    const { impl, calls } = createFetch((url, init) => {
      if (url === `${ZULIP_SITE}/api/v1/register`) {
        return registerResponse();
      }
      if (url.startsWith(`${ZULIP_SITE}/api/v1/events?`)) {
        eventsCalls += 1;
        if (eventsCalls === 1) {
          return json({ result: "success", events, last_event_id: 14 });
        }
        return pendingFetch(init);
      }
      throw new Error(`Unexpected request ${url}`);
    });

    const messages: InboundMessage[] = [];
    const adapter = await startZulip(impl, messages);

    await waitFor(() => expect(messages).toHaveLength(2));
    expect(adapter.isConnected()).toBe(true);

    expect(messages[0]).toMatchObject({
      id: "11",
      channel: "zulip",
      chatId: "stream:general:ops",
      senderId: "alice@zulip.example.org",
      rawSenderId: "alice@zulip.example.org",
      isGroup: true,
      text: "deploy status?",
      mentionsBot: true,
      timestamp: 1_700_000_011_000,
    });
    expect(messages[1]).toMatchObject({
      id: "13",
      chatId: "pm:bob@zulip.example.org",
      senderId: "bob@zulip.example.org",
      isGroup: false,
      text: "hello via dm",
    });

    const registerCall = calls.find((call) => call.url === `${ZULIP_SITE}/api/v1/register`);
    expect(registerCall?.init?.method).toBe("POST");
    expect(headersOf(registerCall?.init).Authorization).toBe(BASIC_AUTH);
    const form = new URLSearchParams(String(registerCall?.init?.body));
    expect(JSON.parse(form.get("event_types") ?? "[]")).toEqual(["message"]);
    expect(JSON.parse(form.get("narrow") ?? "[]")).toEqual([
      { operator: "stream", operand: "general" },
    ]);

    const eventsUrl = new URL(calls.find((call) => call.url.includes("/api/v1/events"))?.url ?? "");
    expect(eventsUrl.searchParams.get("queue_id")).toBe("queue-1");
    expect(eventsUrl.searchParams.get("last_event_id")).toBe("10");
    expect(headersOf(calls.find((call) => call.url.includes("/api/v1/events"))?.init).Authorization).toBe(
      BASIC_AUTH,
    );

    await delay(20);
    expect(messages).toHaveLength(2);
  });

  it("re-registers when Zulip reports BAD_EVENT_QUEUE_ID", async () => {
    let registerCount = 0;
    let eventsCount = 0;
    const { impl } = createFetch((url, init) => {
      if (url === `${ZULIP_SITE}/api/v1/register`) {
        registerCount += 1;
        return registerResponse({ queue_id: `queue-${registerCount}`, last_event_id: 0 });
      }
      if (url.startsWith(`${ZULIP_SITE}/api/v1/events?`)) {
        eventsCount += 1;
        if (eventsCount === 1) {
          return json({ result: "error", code: "BAD_EVENT_QUEUE_ID", msg: "Bad event queue ID" });
        }
        if (eventsCount === 2) {
          expect(new URL(url).searchParams.get("queue_id")).toBe("queue-2");
          return json({
            result: "success",
            events: [streamEvent(21, "@**Gateway Bot** ping")],
            last_event_id: 21,
          });
        }
        return pendingFetch(init);
      }
      throw new Error(`Unexpected request ${url}`);
    });

    const messages: InboundMessage[] = [];
    await startZulip(impl, messages);

    await waitFor(() => expect(messages).toHaveLength(1));
    expect(messages[0]).toMatchObject({ id: "21", text: "ping", mentionsBot: true });
    expect(registerCount).toBe(2);
  });

  it("sends stream and direct messages with Basic auth and chunking", async () => {
    const sent: { form: URLSearchParams; auth?: string }[] = [];
    const { impl } = createFetch((url, init) => {
      if (url === `${ZULIP_SITE}/api/v1/register`) {
        return registerResponse();
      }
      if (url.startsWith(`${ZULIP_SITE}/api/v1/events?`)) {
        return pendingFetch(init);
      }
      if (url === `${ZULIP_SITE}/api/v1/messages`) {
        sent.push({
          form: new URLSearchParams(String(init?.body)),
          auth: headersOf(init).Authorization,
        });
        return json({ result: "success", msg: "", id: 900 + sent.length });
      }
      throw new Error(`Unexpected request ${url}`);
    });

    const adapter = await startZulip(impl, []);

    const streamResult = await adapter.sendMessage({
      chatId: "stream:general:ops",
      text: "A".repeat(9500),
    });
    expect(streamResult).toEqual({ messageId: "902" });
    expect(sent).toHaveLength(2);
    expect(sent[0]?.form.get("type")).toBe("stream");
    expect(sent[0]?.form.get("to")).toBe("general");
    expect(sent[0]?.form.get("topic")).toBe("ops");
    expect(sent[0]?.form.get("content")).toBe("A".repeat(9000));
    expect(sent[1]?.form.get("content")).toBe("A".repeat(500));
    expect(sent[0]?.auth).toBe(BASIC_AUTH);

    const pmResult = await adapter.sendMessage({
      chatId: "pm:alice@zulip.example.org",
      text: "hello",
    });
    expect(pmResult).toEqual({ messageId: "903" });
    const pm = sent[2];
    expect(pm?.form.get("type")).toBe("direct");
    expect(JSON.parse(pm?.form.get("to") ?? "[]")).toEqual(["alice@zulip.example.org"]);
    expect(pm?.form.get("content")).toBe("hello");
  });

  it("stops the long poll cleanly", async () => {
    let eventsCalls = 0;
    const { impl } = createFetch((url, init) => {
      if (url === `${ZULIP_SITE}/api/v1/register`) {
        return registerResponse();
      }
      if (url.startsWith(`${ZULIP_SITE}/api/v1/events?`)) {
        eventsCalls += 1;
        return pendingFetch(init);
      }
      throw new Error(`Unexpected request ${url}`);
    });

    const adapter = await startZulip(impl, []);
    await waitFor(() => expect(eventsCalls).toBe(1));
    expect(adapter.isConnected()).toBe(true);

    await adapter.stop();
    expect(adapter.isConnected()).toBe(false);

    const callsAfterStop = eventsCalls;
    await delay(50);
    expect(eventsCalls).toBe(callsAfterStop);
  });
});

/* -------------------------------------------------------------- Rocket.Chat */

async function startRocketChat(
  impl: typeof fetch,
  messages: InboundMessage[],
  overrides: Partial<RocketChatConfig> = {},
): Promise<{ adapter: RocketChatChannelAdapter; socket: FakeWebSocket }> {
  const adapter = new RocketChatChannelAdapter(rocketchatConfig(overrides), {
    fetchImpl: impl,
    WebSocketCtor: FakeWebSocket as unknown as RocketChatWebSocketCtor,
  });
  running.push(adapter);
  await adapter.start((msg) => {
    messages.push(msg);
  });
  await waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(0));
  const socket = FakeWebSocket.instances[0];
  if (!socket) {
    throw new Error("fake websocket was not created");
  }
  socket.open();
  await waitFor(() => expect(socket.sent).toHaveLength(1));
  return { adapter, socket };
}

async function completeHandshake(socket: FakeWebSocket): Promise<void> {
  socket.deliver({ msg: "connected", session: "session-1" });
  await waitFor(() => expect(socket.sent).toHaveLength(2));
  socket.deliver({
    msg: "result",
    id: "login-1",
    result: { id: RC_USER_ID, token: "resumed-token", me: { _id: RC_USER_ID, username: "gateway-bot" } },
  });
  await waitFor(() => expect(socket.sent).toHaveLength(3));
}

function deliverRoomMessage(socket: FakeWebSocket, message: Record<string, unknown>): void {
  socket.deliver({
    msg: "changed",
    collection: "stream-room-messages",
    fields: { eventName: "__my_messages__", args: [message] },
  });
}

describe("RocketChatChannelAdapter", () => {
  it("converts the URL and completes DDP connect, login, ping/pong, and subscription", async () => {
    const { impl } = createFetch((url) => {
      throw new Error(`Unexpected request ${url}`);
    });

    const messages: InboundMessage[] = [];
    const { adapter, socket } = await startRocketChat(impl, messages);

    expect(socket.url).toBe("ws://localhost:3000/websocket");
    expect(JSON.parse(socket.sent[0] ?? "")).toEqual({
      msg: "connect",
      version: "1",
      support: ["1"],
    });

    socket.deliver({ msg: "connected", session: "session-1" });
    await waitFor(() => expect(socket.sent).toHaveLength(2));
    expect(JSON.parse(socket.sent[1] ?? "")).toEqual({
      msg: "method",
      method: "login",
      id: "login-1",
      params: [{ resume: RC_AUTH_TOKEN }],
    });

    socket.deliver({ msg: "ping" });
    await waitFor(() => expect(socket.sent).toHaveLength(3));
    expect(JSON.parse(socket.sent[2] ?? "")).toEqual({ msg: "pong" });

    socket.deliver({
      msg: "result",
      id: "login-1",
      result: { id: RC_USER_ID, token: "resumed-token", me: { _id: RC_USER_ID, username: "gateway-bot" } },
    });
    await waitFor(() => expect(socket.sent).toHaveLength(4));
    expect(JSON.parse(socket.sent[3] ?? "")).toEqual({
      msg: "method",
      method: "stream-room-messages",
      id: "sub-1",
      params: ["__my_messages__", false],
    });
    expect(adapter.isConnected()).toBe(true);
  });

  it("ingests DMs and mentioned room messages, filtering self and duplicates", async () => {
    const { impl } = createFetch((url) => {
      throw new Error(`Unexpected request ${url}`);
    });

    const messages: InboundMessage[] = [];
    const { socket } = await startRocketChat(impl, messages);
    await completeHandshake(socket);

    const dm = {
      _id: "m1",
      rid: "room-dm",
      roomType: "d",
      msg: "hello dm",
      u: { _id: "user-1", username: "alice" },
      ts: "2026-01-02T03:04:05.000Z",
    };
    deliverRoomMessage(socket, dm);
    await waitFor(() => expect(messages).toHaveLength(1));
    expect(messages[0]).toMatchObject({
      id: "m1",
      channel: "rocketchat",
      chatId: "room-dm",
      senderId: "user-1",
      rawSenderId: "user-1",
      isGroup: false,
      text: "hello dm",
      timestamp: Date.parse("2026-01-02T03:04:05.000Z"),
    });

    deliverRoomMessage(socket, dm);
    deliverRoomMessage(socket, {
      _id: "m2",
      rid: "room-group",
      roomType: "c",
      msg: "no mention here",
      u: { _id: "user-2", username: "bob" },
      ts: 1_700_000_000_000,
    });
    deliverRoomMessage(socket, {
      _id: "m3",
      rid: "room-group",
      roomType: "c",
      msg: "@gateway-bot status?",
      u: { _id: "user-2", username: "bob" },
      ts: 1_700_000_001_000,
    });
    deliverRoomMessage(socket, {
      _id: "m4",
      rid: "room-group",
      roomType: "c",
      msg: "self echo",
      u: { _id: RC_USER_ID, username: "gateway-bot" },
      ts: 1_700_000_002_000,
    });

    await waitFor(() => expect(messages).toHaveLength(2));
    expect(messages[1]).toMatchObject({
      id: "m3",
      chatId: "room-group",
      senderId: "user-2",
      isGroup: true,
      text: "@gateway-bot status?",
      mentionsBot: true,
      timestamp: 1_700_000_001_000,
    });

    await delay(20);
    expect(messages).toHaveLength(2);
  });

  it("posts REST messages with auth headers, tmid, and chunking", async () => {
    const posts: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
    const { impl } = createFetch((url, init) => {
      if (url === `${RC_URL}/api/v1/chat.postMessage`) {
        posts.push({
          url,
          headers: headersOf(init),
          body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
        });
        return json({ success: true, message: { _id: `msg-${posts.length}` } });
      }
      throw new Error(`Unexpected request ${url}`);
    });

    const { adapter } = await startRocketChat(impl, []);

    const result = await adapter.sendMessage({
      chatId: "room-group",
      text: "C".repeat(4100),
      replyToMessageId: "parent-1",
    });

    expect(result).toEqual({ messageId: "msg-2" });
    expect(posts).toHaveLength(2);
    expect(posts[0]).toMatchObject({
      url: `${RC_URL}/api/v1/chat.postMessage`,
      headers: { "X-User-Id": RC_USER_ID, "X-Auth-Token": RC_AUTH_TOKEN },
      body: { roomId: "room-group", text: "C".repeat(4000), tmid: "parent-1" },
    });
    expect(posts[1]?.body).toEqual({ roomId: "room-group", text: "C".repeat(100), tmid: "parent-1" });
  });

  it("reconnects after a socket close and stops cleanly", async () => {
    const { impl } = createFetch((url) => {
      throw new Error(`Unexpected request ${url}`);
    });

    const { adapter, socket } = await startRocketChat(impl, []);
    await completeHandshake(socket);

    socket.close();
    await waitFor(() => expect(FakeWebSocket.instances.length).toBe(2), 5000);
    expect(adapter.isConnected()).toBe(false);

    const second = FakeWebSocket.instances[1];
    if (!second) {
      throw new Error("reconnect socket was not created");
    }
    second.open();
    await waitFor(() => expect(second.sent).toHaveLength(1));

    await adapter.stop();
    expect(adapter.isConnected()).toBe(false);
    expect(second.closed).toBe(true);
  });
});