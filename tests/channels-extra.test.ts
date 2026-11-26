import { createHmac, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GatewayConfig, IrcConfig, LineConfig } from "../src/config.js";
import type { InboundMessage } from "../src/types.js";
import {
  LineChannelAdapter,
  type LineAdapterOptions,
  createAdapter as createLine,
  verifyLineSignature,
} from "../src/channels/line.js";
import {
  IrcChannelAdapter,
  type IrcAdapterOptions,
  type IrcSocketFactory,
  type IrcSocketLike,
  createAdapter as createIrc,
  parseIrcLine,
} from "../src/channels/irc.js";

/* ------------------------------------------------------------------ helpers */

const LINE_SECRET = "line-webhook-secret-for-tests";
const LINE_TOKEN = "line-access-token-for-tests";
const IRC_NICK = "agytest";

let tmp: string;
const stops: Array<() => Promise<unknown>> = [];

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "agy-extra-channels-"));
});

afterEach(async () => {
  for (const stop of stops.splice(0)) {
    await stop();
  }
  await rm(tmp, { recursive: true, force: true });
});

function makeLineConfig(overrides: Partial<LineConfig> = {}): LineConfig {
  return {
    channelAccessToken: LINE_TOKEN,
    channelSecret: LINE_SECRET,
    host: "127.0.0.1",
    port: 0,
    allowedUsers: new Set(),
    ...overrides,
  };
}

function makeIrcConfig(overrides: Partial<IrcConfig> = {}): IrcConfig {
  return {
    host: "irc.test.invalid",
    port: 6667,
    tls: true,
    nick: IRC_NICK,
    channels: ["#general", "#dev"],
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
    line: makeLineConfig(),
    irc: makeIrcConfig(),
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

/* --------------------------------------------------------------- LINE tests */

interface LineFetchCall {
  url: string;
  init?: RequestInit;
}

function makeLineApi(options: { media?: Record<string, Buffer>; sendError?: boolean } = {}) {
  const calls: LineFetchCall[] = [];
  const fetchImpl = async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    calls.push({ url, init });
    if (url.startsWith("https://api-data.line.me/")) {
      const id = decodeURIComponent(url.split("/message/")[1]?.split("/")[0] ?? "");
      const data = options.media?.[id] ?? Buffer.from(`bytes-${id}`);
      return new Response(data, { status: 200 });
    }
    if (options.sendError) {
      return new Response("blocked", { status: 500 });
    }
    return new Response(JSON.stringify({ sentMessages: [{ id: `sent-${calls.length}` }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return {
    calls,
    fetchImpl: fetchImpl as typeof fetch,
    apiCalls: () => calls.filter((call) => call.url.startsWith("https://api.line.me/")),
    contentCalls: () => calls.filter((call) => call.url.startsWith("https://api-data.line.me/")),
  };
}

function signLine(body: string | Buffer, secret = LINE_SECRET): string {
  return createHmac("sha256", secret).update(body).digest("base64");
}

function lineEvent(overrides: Record<string, unknown> = {}): Record<string, any> {
  return {
    type: "message",
    webhookEventId: `we-${randomUUID()}`,
    replyToken: "reply-token-1",
    timestamp: 1_700_000_000_000,
    source: { type: "user", userId: "U123" },
    message: { id: `m-${randomUUID()}`, type: "text", text: "hello" },
    ...overrides,
  };
}

async function postLineWebhook(
  port: number,
  payload: unknown,
  options: { secret?: string | null } = {},
): Promise<Response> {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  const headers: Record<string, string> = { "content-type": "application/json" };
  const secret = options.secret === undefined ? LINE_SECRET : options.secret;
  if (secret !== null) {
    headers["x-line-signature"] = signLine(body, secret);
  }
  return fetch(`http://127.0.0.1:${port}/line/webhook`, { method: "POST", headers, body });
}

async function startLine(
  api = makeLineApi(),
  overrides: Partial<GatewayConfig> = {},
  options: Partial<LineAdapterOptions> = {},
) {
  const adapter = new LineChannelAdapter(makeConfig(overrides), {
    fetchImpl: api.fetchImpl,
    mediaDir: path.join(tmp, "media"),
    ...options,
  });
  stops.push(() => adapter.stop());
  const messages = collector();
  await adapter.start(messages.handler);
  return { adapter, api, ...messages, port: adapter.getPort() as number };
}

describe("LINE channel", () => {
  it("verifies the x-line-signature header with timing-safe HMAC-SHA256", () => {
    const body = Buffer.from(JSON.stringify({ events: [] }));
    const signature = signLine(body);
    expect(verifyLineSignature(LINE_SECRET, body, signature)).toBe(true);
    expect(verifyLineSignature("another-secret", body, signature)).toBe(false);
    expect(verifyLineSignature(LINE_SECRET, Buffer.from("tampered"), signature)).toBe(false);
    expect(verifyLineSignature(LINE_SECRET, body, "")).toBe(false);
    expect(verifyLineSignature(LINE_SECRET, body, "!!!not-base64!!!")).toBe(false);
  });

  it("exposes name and requires LINE config", () => {
    expect(createLine(makeConfig()).name).toBe("line");
    expect(() => createLine(makeConfig({ line: undefined }))).toThrow(/not configured/);
  });

  it("serves /line/health and rejects invalid or missing signatures", async () => {
    const api = makeLineApi();
    const { port, messages } = await startLine(api);

    const health = await fetch(`http://127.0.0.1:${port}/line/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true, channel: "line" });

    const payload = { destination: "Ubot", events: [lineEvent()] };
    const wrongSecret = await postLineWebhook(port, payload, { secret: "wrong-secret" });
    expect(wrongSecret.status).toBe(401);
    const missing = await postLineWebhook(port, payload, { secret: null });
    expect(missing.status).toBe(401);
    await sleep(60);
    expect(messages).toHaveLength(0);
  });

  it("accepts signed webhooks and maps DMs with raw ids", async () => {
    const api = makeLineApi();
    const { port, messages } = await startLine(api);
    const event = lineEvent({
      message: {
        id: "m-dm-1",
        type: "text",
        text: "hello there",
        quotedMessageId: "q-1",
      },
    });
    const res = await postLineWebhook(port, { destination: "Ubot", events: [event] });
    expect(res.status).toBe(200);
    await waitFor(() => messages.length === 1);
    expect(messages[0]).toMatchObject({
      id: "m-dm-1",
      channel: "line",
      chatId: "U123",
      senderId: "U123",
      isGroup: false,
      text: "hello there",
      mentionsBot: true,
      timestamp: 1_700_000_000_000,
      replyToMessageId: "q-1",
    });
  });

  it("maps group and room sources and detects mentions", async () => {
    const api = makeLineApi();
    const { port, messages } = await startLine(api);
    const events = [
      lineEvent({
        source: { type: "group", groupId: "G1", userId: "U2" },
        message: { id: "g1", type: "text", text: "hello everyone" },
      }),
      lineEvent({
        source: { type: "group", groupId: "G1", userId: "U2" },
        message: {
          id: "g2",
          type: "text",
          text: "hey bot",
          mention: { mentionees: [{ type: "user", userId: "Ubot", isSelf: true }] },
        },
      }),
      lineEvent({
        source: { type: "group", groupId: "G1", userId: "U3" },
        message: { id: "g3", type: "text", text: "@agy status" },
      }),
      lineEvent({
        source: { type: "room", roomId: "R1", userId: "U4" },
        message: { id: "r1", type: "text", text: "room chat" },
      }),
    ];
    await postLineWebhook(port, { destination: "Ubot", events });
    await waitFor(() => messages.length === 4);
    const byId = new Map(messages.map((message) => [message.id, message]));
    expect(byId.get("g1")).toMatchObject({
      chatId: "G1",
      senderId: "U2",
      isGroup: true,
      mentionsBot: false,
    });
    expect(byId.get("g2")?.mentionsBot).toBe(true);
    expect(byId.get("g3")?.mentionsBot).toBe(true);
    expect(byId.get("r1")).toMatchObject({
      chatId: "R1",
      senderId: "U4",
      isGroup: true,
      mentionsBot: false,
    });
  });

  it("dedupes repeated message ids across webhook deliveries", async () => {
    const api = makeLineApi();
    const { port, messages } = await startLine(api);
    const payload = {
      destination: "Ubot",
      events: [lineEvent({ message: { id: "m-dup", type: "text", text: "once" } })],
    };
    await postLineWebhook(port, payload);
    await postLineWebhook(port, payload);
    await waitFor(() => messages.length === 1);
    await sleep(60);
    expect(messages).toHaveLength(1);
  });

  it("replies with a fresh single-use reply token, then falls back to push", async () => {
    const api = makeLineApi();
    const { adapter, port, messages } = await startLine(api);
    await postLineWebhook(port, {
      destination: "Ubot",
      events: [lineEvent({ message: { id: "m-rt", type: "text", text: "ping" } })],
    });
    await waitFor(() => messages.length === 1);

    await adapter.sendMessage({ chatId: "U123", text: "first reply" });
    const calls = api.apiCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.line.me/v2/bot/message/reply");
    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${LINE_TOKEN}`);
    const firstBody = JSON.parse(String(calls[0]!.init?.body));
    expect(firstBody).toEqual({
      replyToken: "reply-token-1",
      messages: [{ type: "text", text: "first reply" }],
    });

    await adapter.sendMessage({ chatId: "U123", text: "second reply" });
    const second = api.apiCalls()[1]!;
    expect(second.url).toBe("https://api.line.me/v2/bot/message/push");
    const secondBody = JSON.parse(String(second.init?.body));
    expect(secondBody.to).toBe("U123");
    expect(secondBody.replyToken).toBeUndefined();
    expect(secondBody.messages).toEqual([{ type: "text", text: "second reply" }]);
  });

  it("ignores an expired reply token and pushes instead", async () => {
    const api = makeLineApi();
    const { adapter, port, messages } = await startLine(api, {}, { replyTokenTtlMs: 20 });
    await postLineWebhook(port, {
      destination: "Ubot",
      events: [lineEvent({ message: { id: "m-ttl", type: "text", text: "hi" } })],
    });
    await waitFor(() => messages.length === 1);
    await sleep(40);
    await adapter.sendMessage({ chatId: "U123", text: "too late for reply" });
    const calls = api.apiCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.line.me/v2/bot/message/push");
  });

  it("chunks text to <= 4800 chars and batches <= 5 messages per request", async () => {
    const api = makeLineApi();
    const { adapter, port, messages } = await startLine(api);
    await postLineWebhook(port, {
      destination: "Ubot",
      events: [lineEvent({ message: { id: "m-batch", type: "text", text: "go" } })],
    });
    await waitFor(() => messages.length === 1);

    const long = "a".repeat(4800 * 11);
    const result = await adapter.sendMessage({ chatId: "U123", text: long });
    const calls = api.apiCalls();
    expect(calls.map((call) => call.url)).toEqual([
      "https://api.line.me/v2/bot/message/reply",
      "https://api.line.me/v2/bot/message/push",
      "https://api.line.me/v2/bot/message/push",
    ]);
    const bodies = calls.map((call) => JSON.parse(String(call.init?.body)));
    expect(bodies.map((body) => body.messages.length)).toEqual([5, 5, 1]);
    for (const body of bodies) {
      for (const message of body.messages) {
        expect(message.type).toBe("text");
        expect(message.text.length).toBeLessThanOrEqual(4800);
      }
    }
    expect(bodies[0].replyToken).toBe("reply-token-1");
    expect(bodies[1].to).toBe("U123");
    expect(result).toEqual({ messageId: `sent-${calls.length}` });
    expect(adapter.getStats().lastOutboundAt).toBeDefined();
  });

  it("downloads image, file and audio content into the media dir", async () => {
    const api = makeLineApi({
      media: {
        "img-1": Buffer.from("IMG"),
        "file-1": Buffer.from("FILE"),
        "audio-1": Buffer.from("AUDIO"),
      },
    });
    const { port, messages } = await startLine(api);
    const events = [
      lineEvent({ message: { id: "img-1", type: "image" } }),
      lineEvent({
        message: { id: "file-1", type: "file", fileName: "../report.pdf", fileSize: 4 },
      }),
      lineEvent({ message: { id: "audio-1", type: "audio", fileSize: 5 } }),
    ];
    await postLineWebhook(port, { destination: "Ubot", events });
    await waitFor(() => messages.length === 3);

    const byId = new Map(messages.map((message) => [message.id, message]));
    const image = byId.get("img-1")!;
    expect(image.text).toBe("");
    expect(image.attachments).toHaveLength(1);
    expect(image.attachments[0]).toMatchObject({ type: "image" });
    expect((await readFile(image.attachments[0]!.localPath!)).toString()).toBe("IMG");
    expect(path.dirname(image.attachments[0]!.localPath!)).toBe(
      path.join(tmp, "media", "line"),
    );

    const file = byId.get("file-1")!;
    expect(file.attachments[0]).toMatchObject({ type: "file" });
    expect(path.dirname(file.attachments[0]!.localPath!)).toBe(path.join(tmp, "media", "line"));
    expect((await readFile(file.attachments[0]!.localPath!)).toString()).toBe("FILE");
    expect(file.attachments[0]!.name).toBe("../report.pdf");

    const audio = byId.get("audio-1")!;
    expect(audio.attachments[0]).toMatchObject({ type: "audio" });
    expect((await readFile(audio.attachments[0]!.localPath!)).toString()).toBe("AUDIO");

    const contentCalls = api.contentCalls();
    expect(contentCalls.map((call) => call.url)).toEqual([
      "https://api-data.line.me/v2/bot/message/img-1/content",
      "https://api-data.line.me/v2/bot/message/file-1/content",
      "https://api-data.line.me/v2/bot/message/audio-1/content",
    ]);
    const headers = contentCalls[0]!.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${LINE_TOKEN}`);
  });

  it("surfaces LINE API send failures through lastError", async () => {
    const api = makeLineApi({ sendError: true });
    const { adapter } = await startLine(api);
    await expect(adapter.sendMessage({ chatId: "U123", text: "boom" })).rejects.toThrow(
      /HTTP 500/,
    );
    expect(adapter.getStats().lastError).toMatch(/HTTP 500/);
  });

  it("returns nothing for empty outbound text", async () => {
    const api = makeLineApi();
    const { adapter } = await startLine(api);
    await expect(adapter.sendMessage({ chatId: "U123", text: "   " })).resolves.toBeUndefined();
    expect(api.apiCalls()).toHaveLength(0);
  });
});

/* ---------------------------------------------------------------- IRC tests */

class FakeIrcSocket extends EventEmitter implements IrcSocketLike {
  readonly written: string[] = [];
  destroyed = false;

  write(data: string): boolean {
    this.written.push(data);
    return true;
  }

  end(): void {
    this.emit("close");
  }

  destroy(): void {
    this.destroyed = true;
    this.emit("close");
  }

  feed(data: string): void {
    this.emit("data", Buffer.from(data));
  }

  lines(): string[] {
    return this.written.join("").split("\r\n").filter(Boolean);
  }

  privmsgWrites(): string[] {
    return this.written.filter((write) => write.startsWith("PRIVMSG"));
  }
}

function makeIrcHarness() {
  const sockets: FakeIrcSocket[] = [];
  const tlsFlags: boolean[] = [];
  const factory: IrcSocketFactory = (_host, _port, useTls) => {
    const socket = new FakeIrcSocket();
    sockets.push(socket);
    tlsFlags.push(useTls);
    queueMicrotask(() => {
      if (!socket.destroyed) {
        socket.emit("connect");
      }
    });
    return socket;
  };
  return { sockets, tlsFlags, factory };
}

async function startIrc(
  overrides: Partial<GatewayConfig> = {},
  options: Partial<IrcAdapterOptions> = {},
) {
  const harness = makeIrcHarness();
  const adapter = new IrcChannelAdapter(makeConfig(overrides), {
    socketFactory: harness.factory,
    reconnectDelay: () => 1,
    startupTimeoutMs: 200,
    ...options,
  });
  stops.push(() => adapter.stop());
  const messages = collector();
  await adapter.start(messages.handler);
  return { adapter, ...harness, ...messages, socket: harness.sockets[0]! };
}

function ircPayload(write: string): string {
  const marker = write.indexOf(" :");
  return write.slice(marker === -1 ? write.indexOf(":") : marker + 2, -2);
}

describe("parseIrcLine", () => {
  it("parses prefix, command, params and trailing", () => {
    expect(parseIrcLine(":alice!user@host PRIVMSG #general :hello world")).toEqual({
      prefix: "alice!user@host",
      nick: "alice",
      command: "PRIVMSG",
      params: ["#general"],
      trailing: "hello world",
    });
  });

  it("parses server numerics without a nick", () => {
    expect(parseIrcLine(":irc.example.test 001 agytest :Welcome to the network")).toEqual({
      prefix: "irc.example.test",
      command: "001",
      params: ["agytest"],
      trailing: "Welcome to the network",
    });
  });

  it("parses PING trailing and params-only messages", () => {
    expect(parseIrcLine("PING :token-42")).toEqual({
      command: "PING",
      params: [],
      trailing: "token-42",
    });
    expect(parseIrcLine("PRIVMSG #chan")).toEqual({
      command: "PRIVMSG",
      params: ["#chan"],
    });
  });

  it("keeps colons inside the trailing text", () => {
    expect(parseIrcLine(":a!b@c PRIVMSG #x ::) hi")).toMatchObject({
      nick: "a",
      command: "PRIVMSG",
      params: ["#x"],
      trailing: ":) hi",
    });
  });

  it("strips IRCv3 tags and tolerates extra spaces", () => {
    expect(
      parseIrcLine("@time=2020-01-01T00:00:00Z;msgid=abc  :nick!u@h   PRIVMSG   #c   :hi"),
    ).toMatchObject({
      prefix: "nick!u@h",
      nick: "nick",
      command: "PRIVMSG",
      params: ["#c"],
      trailing: "hi",
    });
  });

  it("returns null for blank, tag-only or command-less lines", () => {
    expect(parseIrcLine("")).toBeNull();
    expect(parseIrcLine("   ")).toBeNull();
    expect(parseIrcLine(":prefixonly")).toBeNull();
    expect(parseIrcLine("@tags-only")).toBeNull();
  });
});

describe("IRC channel", () => {
  it("exposes name and requires IRC config", () => {
    expect(createIrc(makeConfig()).name).toBe("irc");
    expect(() => createIrc(makeConfig({ irc: undefined }))).toThrow(/not configured/);
  });

  it("connects with TLS by default and registers NICK/USER", async () => {
    const { socket, tlsFlags, adapter } = await startIrc();
    expect(tlsFlags).toEqual([true]);
    expect(adapter.isConnected()).toBe(true);
    expect(socket.lines()).toEqual([
      `NICK ${IRC_NICK}`,
      `USER ${IRC_NICK} 0 * :Antigravity Gateway`,
    ]);
  });

  it("uses a plain socket when tls is disabled and sends PASS before NICK", async () => {
    const { socket, tlsFlags } = await startIrc({
      irc: makeIrcConfig({ tls: false, password: "irc-test-password" }),
    });
    expect(tlsFlags).toEqual([false]);
    expect(socket.lines()).toEqual([
      "PASS irc-test-password",
      `NICK ${IRC_NICK}`,
      `USER ${IRC_NICK} 0 * :Antigravity Gateway`,
    ]);
  });

  it("answers PING with PONG and joins configured channels on 001", async () => {
    const { socket } = await startIrc();
    socket.feed("PING :ping-token-9\r\n");
    expect(socket.written).toContain("PONG :ping-token-9\r\n");

    socket.feed(":server 001 agytest :Welcome\r\n");
    expect(socket.written).toContain("JOIN #general\r\n");
    expect(socket.written).toContain("JOIN #dev\r\n");
  });

  it("delivers DMs addressed to the bot nick", async () => {
    const { socket, messages } = await startIrc();
    socket.feed(":alice!user@host PRIVMSG agytest :hello direct\r\n");
    socket.feed(":bob!user@host PRIVMSG AGYTEST :case insensitive\r\n");
    await waitFor(() => messages.length === 2);
    expect(messages[0]).toMatchObject({
      channel: "irc",
      chatId: "alice",
      senderId: "alice",
      isGroup: false,
      text: "hello direct",
      mentionsBot: true,
    });
    expect(messages[1]).toMatchObject({ chatId: "bob", text: "case insensitive" });
    expect(typeof messages[0]!.id).toBe("string");
  });

  it("handles channel mentions, strips nick: prefix, and splits batched lines", async () => {
    const { socket, messages } = await startIrc();
    socket.feed(
      [
        ":alice!u@h PRIVMSG #general :agytest: run the tests",
        ":alice!u@h PRIVMSG #general :hey @agytest check this",
        ":bob!u@h PRIVMSG #general :@agy deploy",
        ":carol!u@h PRIVMSG #general :just chatting",
        "",
      ].join("\r\n"),
    );
    await waitFor(() => messages.length === 4);
    expect(messages.map((message) => message.isGroup)).toEqual([true, true, true, true]);
    expect(messages.map((message) => message.mentionsBot)).toEqual([true, true, true, false]);
    expect(messages[0]!.text).toBe("run the tests");
    expect(messages[1]!.text).toBe("hey @agytest check this");
    expect(messages.every((message) => message.chatId === "#general")).toBe(true);
  });

  it("ignores self messages, unrelated DMs, and duplicate lines", async () => {
    const { socket, messages } = await startIrc();
    socket.feed(`:${IRC_NICK}!u@h PRIVMSG #general :from myself\r\n`);
    socket.feed(":alice!u@h PRIVMSG someoneelse :private to another user\r\n");
    socket.feed(
      ":alice!u@h PRIVMSG agytest :dup line\r\n" +
        ":alice!u@h PRIVMSG agytest :dup line\r\n",
    );
    await waitFor(() => messages.length === 1);
    await sleep(30);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.text).toBe("dup line");
  });

  it("strips CR/LF and writes PRIVMSG payloads", async () => {
    const { adapter, socket } = await startIrc();
    await adapter.sendMessage({ chatId: "#general", text: "line one\r\nline two\rmore" });
    expect(socket.privmsgWrites()).toEqual(["PRIVMSG #general :line one line two more\r\n"]);
    expect(adapter.getStats().lastOutboundAt).toBeDefined();
  });

  it("wraps outbound text at 400 UTF-8 bytes without splitting code points", async () => {
    const { adapter, socket } = await startIrc();
    await adapter.sendMessage({ chatId: "#general", text: "a".repeat(900) });
    let writes = socket.privmsgWrites();
    expect(writes).toHaveLength(3);
    for (const write of writes) {
      expect(Buffer.byteLength(ircPayload(write), "utf8")).toBeLessThanOrEqual(400);
    }
    expect(writes.map(ircPayload).join("")).toBe("a".repeat(900));

    socket.written.length = 0;
    const emoji = "😀".repeat(150); // 600 UTF-8 bytes
    await adapter.sendMessage({ chatId: "#general", text: emoji });
    writes = socket.privmsgWrites();
    expect(writes).toHaveLength(2);
    for (const write of writes) {
      expect(Buffer.byteLength(ircPayload(write), "utf8")).toBeLessThanOrEqual(400);
    }
    expect(writes.map(ircPayload).join("")).toBe(emoji);
  });

  it("sanitizes the chatId so payloads cannot inject extra IRC commands", async () => {
    const { adapter, socket } = await startIrc();
    await adapter.sendMessage({ chatId: "#safe\r\nQUIT", text: "hi" });
    expect(socket.privmsgWrites()).toEqual(["PRIVMSG #safeQUIT :hi\r\n"]);
    expect(socket.written.some((write) => write.startsWith("QUIT"))).toBe(false);
  });

  it("rejects sends while disconnected", async () => {
    const { adapter } = await startIrc();
    await adapter.stop();
    await expect(adapter.sendMessage({ chatId: "#general", text: "x" })).rejects.toThrow(
      /not connected/,
    );
  });

  it("destroys the socket on stop", async () => {
    const { adapter, socket } = await startIrc();
    await adapter.stop();
    expect(socket.destroyed).toBe(true);
    expect(adapter.isConnected()).toBe(false);
  });

  it("reconnects after a socket close and re-registers", async () => {
    const { socket, sockets, messages, adapter } = await startIrc();
    socket.feed(":alice!u@h PRIVMSG agytest :before reconnect\r\n");
    await waitFor(() => messages.length === 1);

    socket.emit("close");
    expect(adapter.isConnected()).toBe(false);
    await waitFor(() => sockets.length === 2);
    const socket2 = sockets[1]!;
    await waitFor(() => socket2.written.some((write) => write.startsWith("NICK ")));
    expect(adapter.isConnected()).toBe(true);

    socket2.feed(":alice!u@h PRIVMSG agytest :after reconnect\r\n");
    await waitFor(() => messages.length === 2);
    expect(messages[1]!.text).toBe("after reconnect");
  });
});