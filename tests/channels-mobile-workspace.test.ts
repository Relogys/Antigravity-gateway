import { afterEach, describe, expect, it } from "vitest";
import type { GatewayConfig } from "../src/config.js";
import type { InboundMessage } from "../src/types.js";
import {
  SignalChannelAdapter,
  type SignalAdapterOptions,
  type SignalConfig,
  type SignalSocketLike,
  type SignalWebSocketCtor,
  createAdapter as createSignal,
} from "../src/channels/signal.js";
import {
  GoogleChatChannelAdapter,
  type GoogleChatConfig,
  createAdapter as createGoogleChat,
} from "../src/channels/googlechat.js";

/* ------------------------------------------------------------------ helpers */

const SIGNAL_API = "http://127.0.0.1:8099";
const SIGNAL_ACCOUNT = "+15550000000";
const CHAT_VERIFY = "verify-token-for-tests";
const CHAT_ACCESS = "chat-access-token-for-tests";
const CHAT_WEBHOOK = "https://chat-webhook.example.test/v1/space";

type TestConfig = GatewayConfig & {
  signal?: SignalConfig;
  googlechat?: GoogleChatConfig;
};

const stops: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  for (const stop of stops.splice(0)) {
    await stop();
  }
});

function makeSignalConfig(overrides: Partial<SignalConfig> = {}): SignalConfig {
  return {
    enabled: true,
    apiUrl: SIGNAL_API,
    account: SIGNAL_ACCOUNT,
    pollIntervalMs: 20,
    ...overrides,
  };
}

function makeGoogleChatConfig(overrides: Partial<GoogleChatConfig> = {}): GoogleChatConfig {
  return {
    enabled: true,
    webhookUrl: "",
    accessToken: "",
    verificationToken: CHAT_VERIFY,
    webhookHost: "127.0.0.1",
    webhookPort: 0,
    webhookPath: "/googlechat/webhook",
    ...overrides,
  };
}

function makeConfig(overrides: Partial<TestConfig> = {}): TestConfig {
  return {
    allowedSenders: new Set(),
    allowGroups: true,
    groupMentionPatterns: ["@agy", "@antigravity"],
    agyBin: "agy",
    defaultCwd: ".",
    approvalMode: "auto",
    healthEnabled: false,
    healthHost: "127.0.0.1",
    healthPort: 0,
    quotaWarnThreshold: 15,
    dataDir: ".",
    logLevel: "error",
    signal: makeSignalConfig(),
    googlechat: makeGoogleChatConfig(),
    ...overrides,
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

function collector() {
  const messages: InboundMessage[] = [];
  return {
    messages,
    handler: (message: InboundMessage) => {
      messages.push(message);
    },
  };
}

/* ------------------------------------------------------------- Signal harness */

class FakeSignalSocket implements SignalSocketLike {
  readyState = 0;
  closed: { code?: number; reason?: string } | null = null;
  private readonly listeners = new Map<string, Array<(event: any) => void>>();

  constructor(readonly url: string) {}

  addEventListener(type: string, listener: (event: any) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState === 3) {
      return;
    }
    this.readyState = 3;
    this.closed = { code, reason };
    this.emit("close", { code, reason });
  }

  open(): void {
    this.readyState = 1;
    this.emit("open", {});
  }

  feed(data: unknown): void {
    this.emit("message", { data });
  }

  serverClose(code = 1006): void {
    this.readyState = 3;
    this.emit("close", { code });
  }

  fail(message = "socket failure"): void {
    this.emit("error", { message });
  }

  private emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

function makeSignalSockets() {
  const sockets: FakeSignalSocket[] = [];
  class HarnessSocket extends FakeSignalSocket {
    constructor(url: string) {
      super(url);
      sockets.push(this);
    }
  }
  return { sockets, ctor: HarnessSocket as unknown as SignalWebSocketCtor };
}

function makeSignalApi(options: { pollBatches?: unknown[] } = {}) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const batches = options.pollBatches ?? [[]];
  let pollIndex = 0;
  const fetchImpl = async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith("/v2/send")) {
      return new Response(JSON.stringify({ timestamp: "1700000000999" }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    }
    const batch = batches[Math.min(pollIndex, batches.length - 1)];
    pollIndex += 1;
    return new Response(JSON.stringify(batch), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return {
    calls,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    receiveCalls: () => calls.filter((call) => call.url.includes("/v1/receive/")),
    sendCalls: () => calls.filter((call) => call.url.endsWith("/v2/send")),
  };
}

function signalEnvelope(
  overrides: {
    sourceNumber?: string;
    sourceUuid?: string;
    timestamp?: number;
    message?: string;
    groupId?: string;
    attachments?: Array<Record<string, unknown>>;
  } = {},
): Record<string, any> {
  const timestamp = overrides.timestamp ?? 1_700_000_000_000;
  return {
    envelope: {
      source: overrides.sourceNumber,
      sourceNumber: overrides.sourceNumber,
      sourceUuid: overrides.sourceUuid,
      timestamp,
      dataMessage: {
        timestamp,
        message: overrides.message ?? "",
        ...(overrides.groupId ? { groupInfo: { groupId: overrides.groupId } } : {}),
        ...(overrides.attachments ? { attachments: overrides.attachments } : {}),
      },
    },
  };
}

async function startSignal(
  options: {
    signal?: Partial<SignalConfig>;
    api?: ReturnType<typeof makeSignalApi>;
    sockets?: ReturnType<typeof makeSignalSockets>;
    adapterOptions?: Partial<SignalAdapterOptions>;
    socket?: (socket: FakeSignalSocket) => void;
  } = {},
) {
  const api = options.api ?? makeSignalApi();
  const sockets = options.sockets ?? makeSignalSockets();
  const adapter = new SignalChannelAdapter(makeConfig({ signal: makeSignalConfig(options.signal) }), {
    WebSocketCtor: sockets.ctor,
    fetchImpl: api.fetchImpl,
    reconnectDelay: () => 5,
    startupTimeoutMs: 300,
    ...options.adapterOptions,
  });
  stops.push(() => adapter.stop());
  const collected = collector();
  const startPromise = adapter.start(collected.handler);
  const socket = sockets.sockets[0];
  if (socket) {
    if (options.socket) {
      options.socket(socket);
    } else {
      socket.open();
    }
  }
  await startPromise;
  return { adapter, api, sockets, socket, ...collected };
}

/* ---------------------------------------------------------- Google Chat harness */

function makeChatApi(options: { restStatus?: number } = {}) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    calls.push({ url, init });
    const rest = url.startsWith("https://chat.googleapis.com/");
    if (rest && options.restStatus && options.restStatus >= 400) {
      return new Response("rest failure", { status: options.restStatus });
    }
    const name = rest
      ? "spaces/TESTSPACE/messages/m-rest-1"
      : "spaces/TESTSPACE/messages/m-hook-1";
    return new Response(JSON.stringify({ name }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return {
    calls,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    restCalls: () => calls.filter((call) => call.url.startsWith("https://chat.googleapis.com/")),
    webhookCalls: () => calls.filter((call) => call.url.startsWith(CHAT_WEBHOOK)),
  };
}

function chatMessageEvent(
  overrides: {
    token?: string | null;
    text?: string;
    argumentText?: string | null;
    messageName?: string;
    threadName?: string | null;
    spaceType?: string;
  } = {},
): Record<string, any> {
  return {
    type: "MESSAGE",
    eventTime: "2026-01-02T03:04:05.000Z",
    ...(overrides.token === null ? {} : { token: overrides.token ?? CHAT_VERIFY }),
    space: { name: "spaces/TESTSPACE", type: overrides.spaceType ?? "ROOM", displayName: "Test room" },
    user: { name: "users/BOT", type: "BOT" },
    message: {
      name: overrides.messageName ?? "spaces/TESTSPACE/messages/MSG1",
      sender: {
        name: "users/USER1",
        displayName: "Test User",
        email: "user@example.test",
        type: "HUMAN",
      },
      createTime: "2026-01-02T03:04:05.000Z",
      text: overrides.text ?? "@TestBot hello there",
      ...(overrides.argumentText === null
        ? {}
        : { argumentText: overrides.argumentText ?? " hello there" }),
      ...(overrides.threadName === null
        ? {}
        : { thread: { name: overrides.threadName ?? "spaces/TESTSPACE/threads/THREAD1" } }),
    },
  };
}

async function postChatEvent(
  port: number,
  path: string,
  payload: Record<string, unknown>,
  bearer?: string,
): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (bearer) {
    headers.Authorization = `Bearer ${bearer}`;
  }
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
}

async function startGoogleChat(
  overrides: Partial<GoogleChatConfig> = {},
  api = makeChatApi(),
  adapterOptions: { maxBodyBytes?: number } = {},
) {
  const cfg = makeGoogleChatConfig(overrides);
  const adapter = new GoogleChatChannelAdapter(makeConfig({ googlechat: cfg }), {
    fetchImpl: api.fetchImpl,
    ...adapterOptions,
  });
  stops.push(() => adapter.stop());
  const collected = collector();
  await adapter.start(collected.handler);
  return {
    adapter,
    api,
    port: adapter.getPort() as number,
    path: cfg.webhookPath,
    ...collected,
  };
}

/* --------------------------------------------------------------- Signal tests */

describe("Signal channel", () => {
  it("exposes the channel name and requires Signal config", () => {
    expect(createSignal(makeConfig()).name).toBe("signal");
    expect(() => createSignal(makeConfig({ signal: undefined }))).toThrow(/not configured/);
  });

  it("ingests WS envelopes for DMs, groups and uuid-only senders with raw ids", async () => {
    const { adapter, socket, messages } = await startSignal();
    expect(socket?.url).toBe(
      `ws://127.0.0.1:8099/v1/receive/${encodeURIComponent(SIGNAL_ACCOUNT)}`,
    );
    expect(adapter.isConnected()).toBe(true);

    socket!.feed([
      signalEnvelope({
        sourceNumber: "+15550001001",
        sourceUuid: "uuid-ignored",
        timestamp: 1_700_000_000_000,
        message: "hello from dm",
        attachments: [{ contentType: "image/png", filename: "photo.png", size: 42 }],
      }),
    ]);
    socket!.feed(
      signalEnvelope({
        sourceNumber: "+15550001002",
        timestamp: 1_700_000_000_100,
        message: "@antigravity status",
        groupId: "grp==",
      }),
    );
    socket!.feed(
      signalEnvelope({
        sourceUuid: "uuid-only",
        timestamp: 1_700_000_000_200,
        message: "uuid sender",
      }),
    );
    socket!.feed(
      signalEnvelope({
        sourceNumber: SIGNAL_ACCOUNT,
        timestamp: 1_700_000_000_300,
        message: "message from myself",
      }),
    );
    socket!.feed(
      signalEnvelope({
        sourceNumber: "+15550001001",
        timestamp: 1_700_000_000_000,
        message: "duplicate delivery",
      }),
    );

    await waitFor(() => messages.length === 3);
    await sleep(30);
    expect(messages).toHaveLength(3);

    expect(messages[0]).toMatchObject({
      id: "1700000000000:+15550001001",
      channel: "signal",
      chatId: "+15550001001",
      senderId: "+15550001001",
      isGroup: false,
      text: "hello from dm",
      mentionsBot: true,
      timestamp: 1_700_000_000_000,
    });
    expect(messages[0]!.attachments).toEqual([
      { type: "image", name: "photo.png", mimeType: "image/png", sizeBytes: 42 },
    ]);

    expect(messages[1]).toMatchObject({
      chatId: "group:grp==",
      senderId: "+15550001002",
      isGroup: true,
      text: "@antigravity status",
      mentionsBot: true,
    });

    expect(messages[2]).toMatchObject({
      chatId: "uuid-only",
      senderId: "uuid-only",
      isGroup: false,
      text: "uuid sender",
    });
  });

  it("falls back to HTTP polling when the WebSocket errors", async () => {
    const api = makeSignalApi({
      pollBatches: [
        [
          signalEnvelope({
            sourceNumber: "+15550001003",
            timestamp: 1_700_000_000_500,
            message: "polled message",
          }),
        ],
      ],
    });
    const { adapter, sockets, messages } = await startSignal({
      api,
      socket: (socket) => socket.fail("ws unavailable"),
    });

    await waitFor(() => messages.length === 1);
    expect(messages[0]).toMatchObject({
      chatId: "+15550001003",
      text: "polled message",
    });
    expect(sockets.sockets).toHaveLength(1);
    const receive = api.receiveCalls();
    expect(receive.length).toBeGreaterThan(0);
    expect(receive[0]!.url).toBe(
      `http://127.0.0.1:8099/v1/receive/${encodeURIComponent(SIGNAL_ACCOUNT)}`,
    );
    expect(receive[0]!.init?.method).toBe("GET");
    expect(adapter.isConnected()).toBe(true);

    await sleep(60);
    expect(messages).toHaveLength(1);
  });

  it("falls back to HTTP polling when the WebSocket closes with a non-normal code", async () => {
    const api = makeSignalApi({
      pollBatches: [
        [
          signalEnvelope({
            sourceNumber: "+15550001004",
            timestamp: 1_700_000_000_600,
            message: "after abnormal close",
          }),
        ],
      ],
    });
    const { messages } = await startSignal({
      api,
      socket: (socket) => socket.serverClose(1011),
    });

    await waitFor(() => messages.length === 1);
    expect(messages[0]).toMatchObject({
      chatId: "+15550001004",
      text: "after abnormal close",
    });
    expect(api.receiveCalls().length).toBeGreaterThan(0);
  });

  it("sends DM and group messages through /v2/send with chunking", async () => {
    const { adapter, api } = await startSignal();
    const long = "a".repeat(4000 * 2 + 100);
    const result = await adapter.sendMessage({ chatId: "+15550001001", text: long });

    const calls = api.sendCalls();
    expect(calls).toHaveLength(3);
    const bodies = calls.map((call) => JSON.parse(String(call.init?.body)));
    for (const [index, call] of calls.entries()) {
      expect(call.url).toBe("http://127.0.0.1:8099/v2/send");
      expect(call.init?.method).toBe("POST");
      expect((call.init?.headers as Record<string, string>)["content-type"]).toBe(
        "application/json",
      );
      expect(bodies[index].number).toBe(SIGNAL_ACCOUNT);
      expect(bodies[index].recipients).toEqual(["+15550001001"]);
      expect(bodies[index].message.length).toBeLessThanOrEqual(4000);
    }
    expect(bodies.map((body) => body.message).join("")).toBe(long);
    expect(result).toEqual({ messageId: "1700000000999" });
    expect(adapter.getStats().lastOutboundAt).toBeDefined();

    api.calls.length = 0;
    await adapter.sendMessage({ chatId: "group:grp==", text: "group hello" });
    const groupBody = JSON.parse(String(api.sendCalls()[0]!.init?.body));
    expect(groupBody).toMatchObject({
      message: "group hello",
      number: SIGNAL_ACCOUNT,
      recipients: ["grp=="],
    });

    api.calls.length = 0;
    await expect(
      adapter.sendMessage({ chatId: "+15550001001", text: "   " }),
    ).resolves.toBeUndefined();
    expect(api.sendCalls()).toHaveLength(0);
  });

  it("closes the WebSocket on stop without starting a poll loop", async () => {
    const { adapter, socket, api } = await startSignal();
    await adapter.stop();

    expect(adapter.isConnected()).toBe(false);
    expect(socket?.closed?.code).toBe(1000);
    await sleep(40);
    expect(api.receiveCalls()).toHaveLength(0);
  });

  it("aborts the in-flight polling fetch on stop", async () => {
    const sockets = makeSignalSockets();
    const urls: string[] = [];
    let aborted = false;
    const fetchImpl = (input: unknown, init?: RequestInit): Promise<Response> => {
      urls.push(String(input));
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) {
          return;
        }
        if (signal.aborted) {
          aborted = true;
          reject(new Error("aborted"));
          return;
        }
        signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(new Error("aborted"));
          },
          { once: true },
        );
      });
    };
    const adapter = new SignalChannelAdapter(makeConfig(), {
      WebSocketCtor: sockets.ctor,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      reconnectDelay: () => 5,
      startupTimeoutMs: 300,
    });
    stops.push(() => adapter.stop());

    const startPromise = adapter.start(() => undefined);
    sockets.sockets[0]!.serverClose(1006);
    await startPromise;
    expect(urls.length).toBeGreaterThan(0);

    await adapter.stop();
    expect(aborted).toBe(true);
    expect(adapter.isConnected()).toBe(false);
  });
});

/* ---------------------------------------------------------- Google Chat tests */

describe("Google Chat channel", () => {
  it("exposes the channel name and requires Google Chat config", () => {
    expect(createGoogleChat(makeConfig()).name).toBe("googlechat");
    expect(() => createGoogleChat(makeConfig({ googlechat: undefined }))).toThrow(
      /not configured/,
    );
  });

  it("verifies the token from the body or the bearer header and returns 401 otherwise", async () => {
    const { port, path, messages } = await startGoogleChat();

    const wrongBody = await postChatEvent(
      port,
      path,
      chatMessageEvent({ token: "wrong-token" }),
    );
    expect(wrongBody.status).toBe(401);

    const missingToken = await postChatEvent(port, path, chatMessageEvent({ token: null }));
    expect(missingToken.status).toBe(401);

    await sleep(30);
    expect(messages).toHaveLength(0);

    const validBearer = await postChatEvent(
      port,
      path,
      chatMessageEvent({ token: "wrong-token" }),
      CHAT_VERIFY,
    );
    expect(validBearer.status).toBe(200);
    await waitFor(() => messages.length === 1);
  });

  it("parses MESSAGE events with raw ids, stripped mentions and thread metadata", async () => {
    const { port, path, messages } = await startGoogleChat();

    const first = await postChatEvent(
      port,
      path,
      chatMessageEvent({ argumentText: null }),
    );
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({});

    const second = await postChatEvent(
      port,
      path,
      chatMessageEvent({
        messageName: "spaces/TESTSPACE/messages/MSG2",
        text: "@TestBot actual argument",
        argumentText: "actual argument",
        spaceType: "DM",
        threadName: null,
      }),
    );
    expect(second.status).toBe(200);

    await waitFor(() => messages.length === 2);

    expect(messages[0]).toMatchObject({
      id: "spaces/TESTSPACE/messages/MSG1",
      channel: "googlechat",
      chatId: "spaces/TESTSPACE",
      senderId: "users/USER1",
      isGroup: true,
      text: "hello there",
      mentionsBot: true,
      timestamp: Date.parse("2026-01-02T03:04:05.000Z"),
    });
    expect(
      (messages[0] as InboundMessage & { metadata?: { threadName?: string } }).metadata,
    ).toEqual({ threadName: "spaces/TESTSPACE/threads/THREAD1" });

    expect(messages[1]).toMatchObject({
      id: "spaces/TESTSPACE/messages/MSG2",
      chatId: "spaces/TESTSPACE",
      senderId: "users/USER1",
      isGroup: false,
      text: "actual argument",
    });
    expect(
      (messages[1] as InboundMessage & { metadata?: { threadName?: string } }).metadata,
    ).toBeUndefined();
  });

  it("answers ADDED_TO_SPACE with a friendly acknowledgement and no inbound message", async () => {
    const { port, path, messages } = await startGoogleChat();
    const res = await postChatEvent(port, path, {
      type: "ADDED_TO_SPACE",
      token: CHAT_VERIFY,
      space: { name: "spaces/TESTSPACE", type: "ROOM" },
      user: { name: "users/USER1" },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { text?: string };
    expect(typeof body.text).toBe("string");
    expect(body.text!.length).toBeGreaterThan(0);
    await sleep(30);
    expect(messages).toHaveLength(0);
  });

  it("replies through the Chat REST API using the captured thread and bearer token", async () => {
    const api = makeChatApi();
    const { adapter, port, path, messages } = await startGoogleChat(
      { accessToken: CHAT_ACCESS },
      api,
    );
    await postChatEvent(port, path, chatMessageEvent());
    await waitFor(() => messages.length === 1);

    const result = await adapter.sendMessage({
      chatId: "spaces/TESTSPACE",
      text: "bot reply",
    });

    const calls = api.restCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      "https://chat.googleapis.com/v1/spaces/TESTSPACE/messages?messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD",
    );
    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${CHAT_ACCESS}`);
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({
      text: "bot reply",
      thread: { name: "spaces/TESTSPACE/threads/THREAD1" },
    });
    expect(result).toEqual({ messageId: "spaces/TESTSPACE/messages/m-rest-1" });
    expect(adapter.getStats().lastOutboundAt).toBeDefined();
  });

  it("chunks REST messages at 4096 characters without a thread when none is known", async () => {
    const api = makeChatApi();
    const { adapter } = await startGoogleChat({ accessToken: CHAT_ACCESS }, api);
    const long = "b".repeat(4096 + 100);

    await adapter.sendMessage({ chatId: "spaces/TESTSPACE", text: long });

    const calls = api.restCalls();
    expect(calls).toHaveLength(2);
    const bodies = calls.map((call) => JSON.parse(String(call.init?.body)));
    for (const call of calls) {
      expect(call.url).toBe("https://chat.googleapis.com/v1/spaces/TESTSPACE/messages");
    }
    for (const body of bodies) {
      expect(body.text.length).toBeLessThanOrEqual(4096);
      expect(body.thread).toBeUndefined();
    }
    expect(bodies.map((body) => body.text).join("")).toBe(long);

    const explicit = await adapter.sendMessage(
      { chatId: "spaces/OTHER", text: "explicit thread" },
      { threadName: "spaces/OTHER/threads/T9" },
    );
    const explicitCall = api.restCalls()[2]!;
    expect(explicitCall.url).toBe(
      "https://chat.googleapis.com/v1/spaces/OTHER/messages?messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD",
    );
    expect(JSON.parse(String(explicitCall.init?.body))).toEqual({
      text: "explicit thread",
      thread: { name: "spaces/OTHER/threads/T9" },
    });
    expect(explicit).toEqual({ messageId: "spaces/TESTSPACE/messages/m-rest-1" });
  });

  it("falls back to the incoming webhook URL with a thread key", async () => {
    const api = makeChatApi();
    const { adapter } = await startGoogleChat(
      { accessToken: "", webhookUrl: CHAT_WEBHOOK },
      api,
    );

    const result = await adapter.sendMessage(
      { chatId: "spaces/TESTSPACE", text: "hook reply" },
      { threadKey: "thread-key-1" },
    );

    const calls = api.webhookCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(CHAT_WEBHOOK);
    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({
      text: "hook reply",
      thread: { threadKey: "thread-key-1" },
    });
    expect(result).toEqual({ messageId: "spaces/TESTSPACE/messages/m-hook-1" });
    expect(api.restCalls()).toHaveLength(0);

    await adapter.sendMessage({ chatId: "not-a-space", text: "plain hook" });
    const plain = JSON.parse(String(api.webhookCalls()[1]!.init?.body));
    expect(plain).toEqual({ text: "plain hook" });
  });

  it("throws a clear configuration error when no send transport is configured", async () => {
    const { adapter } = await startGoogleChat({ accessToken: "", webhookUrl: "" });
    await expect(
      adapter.sendMessage({ chatId: "spaces/TESTSPACE", text: "nowhere to go" }),
    ).rejects.toThrow(/not configured for sending/i);
  });

  it("rejects request bodies over the size limit", async () => {
    const { port, path } = await startGoogleChat({}, makeChatApi(), { maxBodyBytes: 64 });
    const res = await postChatEvent(port, path, { blob: "x".repeat(200) });
    expect(res.status).toBe(413);
  });

  it("closes the webhook server on stop", async () => {
    const { adapter, port, path } = await startGoogleChat();
    expect(adapter.isConnected()).toBe(true);

    await adapter.stop();

    expect(adapter.isConnected()).toBe(false);
    expect(adapter.getPort()).toBeNull();
    await expect(
      postChatEvent(port, path, chatMessageEvent()),
    ).rejects.toThrow();
  });
});