import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GatewayConfig } from "../src/config.js";
import type { InboundMessage } from "../src/types.js";
import {
  DiscordChannelAdapter,
  type DiscordClientLike,
  createAdapter as createDiscord,
} from "../src/channels/discord.js";
import {
  SlackChannelAdapter,
  type SlackAppLike,
  toSlackReactionName,
  createAdapter as createSlack,
} from "../src/channels/slack.js";
import {
  TelegramChannelAdapter,
  createAdapter as createTelegram,
} from "../src/channels/telegram.js";

/* ------------------------------------------------------------------ helpers */

const BOT_TOKEN = "test-bot-token";
const SLACK_APP_TOKEN = "test-app-token";

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "agy-global-channels-"));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

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
    quotaWarnThreshold: 0.1,
    dataDir: tmp,
    logLevel: "error",
    telegram: { botToken: BOT_TOKEN, allowedUsers: new Set(), pollTimeoutSec: 1 },
    discord: { botToken: BOT_TOKEN, allowedUsers: new Set(), allowGuilds: true },
    slack: { botToken: BOT_TOKEN, appToken: SLACK_APP_TOKEN, allowedUsers: new Set() },
    ...overrides,
  };
}

async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor timed out");
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

function collector() {
  const messages: InboundMessage[] = [];
  return { messages, handler: (m: InboundMessage) => void messages.push(m) };
}

/* ----------------------------------------------------------------- Telegram */

interface TgCall {
  method: string;
  body: unknown;
}

function makeTelegramFake(botUsername = "agy_test_bot") {
  const calls: TgCall[] = [];
  const updateBatches: unknown[][] = [];
  const results: Record<string, (body: any) => unknown> = {
    getMe: () => ({ id: 777, is_bot: true, username: botUsername }),
    sendMessage: () => ({ message_id: 900 + calls.filter((c) => c.method === "sendMessage").length }),
    getFile: (b) => ({ file_path: `files/${b.file_id}` }),
    sendPhoto: () => ({ message_id: 950 }),
    sendDocument: () => ({ message_id: 951 }),
  };
  const failures: Array<{ method: string; times: number }> = [];

  const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
    const method = input.split("/").pop()!;
    expect(input).toContain(`/bot${BOT_TOKEN}/`);
    let body: unknown = init?.body;
    if (typeof body === "string") {
      body = JSON.parse(body);
    }
    calls.push({ method, body });

    const failure = failures.find((f) => f.method === method && f.times > 0);
    if (failure) {
      failure.times -= 1;
      return new Response(JSON.stringify({ ok: false, description: "boom" }), { status: 500 });
    }

    if (method === "getUpdates") {
      const batch = updateBatches.shift();
      if (batch) {
        return new Response(JSON.stringify({ ok: true, result: batch }));
      }
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        const onAbort = () => reject(new DOMException("aborted", "AbortError"));
        if (signal?.aborted) {
          onAbort();
          return;
        }
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    }
    const result = results[method]?.(body) ?? true;
    return new Response(JSON.stringify({ ok: true, result }));
  };

  return { calls, updateBatches, results, failures, fetchImpl };
}

function tgDownload(map: Record<string, Buffer> = {}) {
  const urls: string[] = [];
  return {
    urls,
    download: async (url: string) => {
      urls.push(url);
      return map[url.split("/").pop()!] ?? Buffer.from("tg-bytes");
    },
  };
}

function tgMessage(overrides: Record<string, unknown> = {}) {
  return {
    message_id: 10,
    date: 1_700_000_000,
    chat: { id: 4242, type: "private" },
    from: { id: 99, is_bot: false },
    text: "hello",
    ...overrides,
  };
}

describe("TelegramChannelAdapter", () => {
  let adapter: TelegramChannelAdapter | undefined;

  afterEach(async () => {
    await adapter?.stop();
    adapter = undefined;
  });

  function build(
    fake: ReturnType<typeof makeTelegramFake>,
    dl = tgDownload(),
    config = makeConfig(),
  ) {
    adapter = new TelegramChannelAdapter(config, {
      fetchImpl: fake.fetchImpl,
      download: dl.download,
      mediaDir: path.join(tmp, "media"),
      backoffMs: () => 5,
    });
    return adapter;
  }

  it("exposes name and requires config", () => {
    expect(createTelegram(makeConfig()).name).toBe("telegram");
    expect(() => createTelegram(makeConfig({ telegram: undefined }))).toThrow(/not configured/);
  });

  it("calls getMe on start, becomes connected, and stops cleanly", async () => {
    const fake = makeTelegramFake();
    const a = build(fake);
    await a.start(() => {});
    expect(a.isConnected()).toBe(true);
    expect(fake.calls[0]?.method).toBe("getMe");
    await waitFor(() => fake.calls.some((c) => c.method === "getUpdates"));
    const poll = fake.calls.find((c) => c.method === "getUpdates")!.body as any;
    expect(poll.timeout).toBe(1);
    await a.stop();
    expect(a.isConnected()).toBe(false);
  });

  it("parses private messages with raw ids and no mention gating", async () => {
    const fake = makeTelegramFake();
    fake.updateBatches.push([{ update_id: 1, message: tgMessage() }]);
    const c = collector();
    await build(fake).start(c.handler);
    await waitFor(() => c.messages.length === 1);
    const m = c.messages[0]!;
    expect(m).toMatchObject({
      id: "10",
      channel: "telegram",
      chatId: "4242",
      senderId: "99",
      isGroup: false,
      text: "hello",
      mentionsBot: true,
      timestamp: 1_700_000_000_000,
    });
  });

  it("advances the offset after processing updates", async () => {
    const fake = makeTelegramFake();
    fake.updateBatches.push([{ update_id: 41, message: tgMessage() }]);
    await build(fake).start(() => {});
    await waitFor(() => fake.calls.filter((c) => c.method === "getUpdates").length >= 2);
    const second = fake.calls.filter((c) => c.method === "getUpdates")[1]!.body as any;
    expect(second.offset).toBe(42);
  });

  it("gates group messages on @botname, patterns, and replies to the bot", async () => {
    const fake = makeTelegramFake("agy_test_bot");
    const group = { id: -100123, type: "supergroup" };
    fake.updateBatches.push([
      { update_id: 1, message: tgMessage({ message_id: 1, chat: group, text: "just chatting" }) },
      { update_id: 2, message: tgMessage({ message_id: 2, chat: group, text: "@agy_test_bot hi there" }) },
      { update_id: 3, message: tgMessage({ message_id: 3, chat: group, text: "hey @AGY run tests" }) },
      {
        update_id: 4,
        message: tgMessage({
          message_id: 4,
          chat: group,
          text: "following up",
          reply_to_message: { message_id: 2, from: { id: 777, is_bot: true, username: "agy_test_bot" } },
        }),
      },
    ]);
    const c = collector();
    await build(fake).start(c.handler);
    await waitFor(() => c.messages.length === 4);
    expect(c.messages.map((m) => m.isGroup)).toEqual([true, true, true, true]);
    expect(c.messages.map((m) => m.mentionsBot)).toEqual([false, true, true, true]);
    expect(c.messages[1]!.text).toBe("hi there");
    expect(c.messages[0]!.chatId).toBe("-100123");
    expect(c.messages[3]!.replyToMessageId).toBe("2");
  });

  it("dedupes by update_id and message_id and ignores bot senders", async () => {
    const fake = makeTelegramFake();
    fake.updateBatches.push([
      { update_id: 1, message: tgMessage() },
      { update_id: 1, message: tgMessage() },
      { update_id: 2, message: tgMessage() }, // same message_id, new update
      { update_id: 3, message: tgMessage({ message_id: 11, from: { id: 5, is_bot: true } }) },
      { update_id: 4, message: tgMessage({ message_id: 12, text: undefined }) }, // empty
    ]);
    const c = collector();
    await build(fake).start(c.handler);
    await waitFor(() => fake.calls.filter((x) => x.method === "getUpdates").length >= 2);
    expect(c.messages).toHaveLength(1);
  });

  it("downloads the largest photo, documents, voice and audio into the media dir", async () => {
    const fake = makeTelegramFake();
    fake.updateBatches.push([
      {
        update_id: 1,
        message: tgMessage({
          caption: "look",
          text: undefined,
          photo: [
            { file_id: "small", file_size: 10, width: 10, height: 10 },
            { file_id: "large", file_size: 500, width: 800, height: 600 },
          ],
          document: { file_id: "doc1", file_name: "../notes.txt", mime_type: "text/plain", file_size: 8 },
          voice: { file_id: "voice1", mime_type: "audio/ogg", file_size: 4 },
          audio: { file_id: "aud1", file_name: "song.mp3", mime_type: "audio/mpeg", file_size: 4 },
        }),
      },
    ]);
    const dl = tgDownload({ large: Buffer.from("PHOTO") });
    const c = collector();
    await build(fake, dl).start(c.handler);
    await waitFor(() => c.messages.length === 1);

    const m = c.messages[0]!;
    expect(m.text).toBe("look");
    expect(m.attachments.map((a) => a.type)).toEqual(["image", "file", "audio", "audio"]);
    expect(dl.urls[0]).toBe(`https://api.telegram.org/file/bot${BOT_TOKEN}/files/large`);
    expect(dl.urls).not.toContain(`https://api.telegram.org/file/bot${BOT_TOKEN}/files/small`);
    const photo = m.attachments[0]!;
    expect(photo.data?.toString()).toBe("PHOTO");
    expect((await readFile(photo.localPath!)).toString()).toBe("PHOTO");
    expect(photo.localPath!.startsWith(path.join(tmp, "media", "telegram"))).toBe(true);
    // hostile filename cannot escape the media dir
    const doc = m.attachments[1]!;
    expect(path.dirname(doc.localPath!)).toBe(path.join(tmp, "media", "telegram"));
    expect(doc.name).toBe("../notes.txt");
  });

  it("chunks long outbound text, quotes the original on the first chunk only", async () => {
    const fake = makeTelegramFake();
    const a = build(fake);
    await a.start(() => {});
    const long = Array.from({ length: 900 }, (_, i) => `word${i}`).join(" ");
    const res = await a.sendMessage({ chatId: "4242", text: long, replyToMessageId: "55" });
    const sends = fake.calls.filter((c) => c.method === "sendMessage").map((c) => c.body as any);
    expect(sends.length).toBeGreaterThan(1);
    for (const s of sends) {
      expect(s.text.length).toBeLessThanOrEqual(4000);
      expect(s.chat_id).toBe("4242");
    }
    expect(sends[0].reply_parameters).toEqual({ message_id: 55, allow_sending_without_reply: true });
    expect(sends[1].reply_parameters).toBeUndefined();
    expect(sends.map((s) => s.text).join(" ")).toBe(long);
    expect(res).toEqual({ messageId: expect.any(String) });
    expect(a.getStats().lastOutboundAt).toBeDefined();
  });

  it("sends buffer and file attachments as multipart sendPhoto / sendDocument", async () => {
    const fake = makeTelegramFake();
    const a = build(fake);
    await a.start(() => {});
    const filePath = path.join(tmp, "report.txt");
    await writeFile(filePath, "report body");
    await a.sendMessage({
      chatId: "4242",
      attachments: [
        { buffer: Buffer.from("PNGDATA"), name: "pic.png", mimeType: "image/png" },
        { path: filePath },
        { url: "https://example.com/x.pdf", name: "x.pdf" },
      ],
    });
    const photo = fake.calls.find((c) => c.method === "sendPhoto")!.body as FormData;
    expect(photo).toBeInstanceOf(FormData);
    expect(photo.get("chat_id")).toBe("4242");
    const photoFile = photo.get("photo") as File;
    expect(photoFile.name).toBe("pic.png");
    expect(await photoFile.text()).toBe("PNGDATA");

    const docs = fake.calls.filter((c) => c.method === "sendDocument");
    expect(docs).toHaveLength(2);
    const localDoc = docs[0]!.body as FormData;
    expect(((localDoc.get("document") as File).name)).toBe("report.txt");
    expect(await (localDoc.get("document") as File).text()).toBe("report body");
    expect((docs[1]!.body as any).document).toBe("https://example.com/x.pdf");
  });

  it("implements typing, reactions and edits", async () => {
    const fake = makeTelegramFake();
    const a = build(fake);
    await a.start(() => {});
    await a.sendTyping("4242", true);
    await a.sendTyping("4242", false);
    await a.react("4242", "10", "👀");
    await a.editMessage("4242", "10", "updated");
    const by = (m: string) => fake.calls.filter((c) => c.method === m).map((c) => c.body as any);
    expect(by("sendChatAction")).toEqual([{ chat_id: "4242", action: "typing" }]);
    expect(by("setMessageReaction")).toEqual([
      { chat_id: "4242", message_id: 10, reaction: [{ type: "emoji", emoji: "👀" }] },
    ]);
    expect(by("editMessageText")).toEqual([{ chat_id: "4242", message_id: 10, text: "updated" }]);
  });

  it("swallows typing/react failures but throws on API errors for sendMessage", async () => {
    const fake = makeTelegramFake();
    const a = build(fake);
    await a.start(() => {});
    fake.failures.push({ method: "sendChatAction", times: 1 }, { method: "sendMessage", times: 1 });
    await expect(a.sendTyping("1", true)).resolves.toBeUndefined();
    expect(a.getStats().lastError).toMatch(/boom/);
    await expect(a.sendMessage({ chatId: "1", text: "x" })).rejects.toThrow(/boom/);
  });

  it("backs off and recovers after poll errors, retrying getMe if it failed at start", async () => {
    const fake = makeTelegramFake();
    fake.failures.push({ method: "getMe", times: 1 }, { method: "getUpdates", times: 1 });
    fake.updateBatches.push([{ update_id: 1, message: tgMessage() }]);
    const c = collector();
    const a = build(fake);
    await a.start(c.handler); // must not throw on a transient getMe failure
    expect(a.isConnected()).toBe(false);
    await waitFor(() => c.messages.length === 1);
    expect(a.isConnected()).toBe(true);
    expect(fake.calls.filter((x) => x.method === "getMe").length).toBeGreaterThanOrEqual(2);
  });

  it("stop() aborts the in-flight long poll promptly and stops polling", async () => {
    const fake = makeTelegramFake();
    const a = build(fake);
    await a.start(() => {});
    await waitFor(() => fake.calls.some((c) => c.method === "getUpdates"));
    const before = fake.calls.length;
    await a.stop();
    await new Promise((r) => setTimeout(r, 30));
    expect(fake.calls.length).toBe(before);
  });
});

/* ------------------------------------------------------------------ Discord */

class FakeDiscordChannel {
  sent: Array<Record<string, unknown>> = [];
  typing = 0;
  fetched = new Map<string, FakeDiscordMessage>();
  messages = { fetch: async (id: string) => this.fetched.get(id)! };
  async send(options: Record<string, unknown>) {
    this.sent.push(options);
    return { id: `sent-${this.sent.length}` };
  }
  async sendTyping() {
    this.typing += 1;
  }
}

class FakeDiscordMessage {
  reactions: string[] = [];
  edits: string[] = [];
  async react(e: string) {
    this.reactions.push(e);
  }
  async edit(c: string) {
    this.edits.push(c);
  }
}

class FakeDiscordClient extends EventEmitter {
  user: { id: string } | null = { id: "B0T" };
  destroyed = false;
  loggedInWith?: string;
  channel = new FakeDiscordChannel();
  channels = { fetch: async (id: string) => (id === "chan-1" ? this.channel : null) };
  async login(token: string) {
    this.loggedInWith = token;
    queueMicrotask(() => this.emit("clientReady"));
    return token;
  }
  async destroy() {
    this.destroyed = true;
  }
  isReady() {
    return false;
  }
}

function dMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: "m1",
    channelId: "chan-1",
    content: "hello",
    createdTimestamp: 1_700_000_000_000,
    author: { id: "u1", bot: false },
    guild: null,
    mentions: { has: () => false },
    attachments: new Map(),
    ...overrides,
  };
}

describe("DiscordChannelAdapter", () => {
  let adapter: DiscordChannelAdapter | undefined;

  afterEach(async () => {
    await adapter?.stop();
    adapter = undefined;
  });

  function build(client = new FakeDiscordClient(), download?: (url: string) => Promise<Buffer>) {
    adapter = new DiscordChannelAdapter(makeConfig(), {
      clientFactory: () => client as unknown as DiscordClientLike,
      download: download ?? (async () => Buffer.from("dc-bytes")),
      mediaDir: path.join(tmp, "media"),
      readyTimeoutMs: 200,
    });
    return { client, adapter };
  }

  it("exposes name and requires config", () => {
    expect(createDiscord(makeConfig()).name).toBe("discord");
    expect(() => createDiscord(makeConfig({ discord: undefined }))).toThrow(/not configured/);
  });

  it("logs in, waits for ready, and destroys the client on stop", async () => {
    const { client, adapter: a } = build();
    await a.start(() => {});
    expect(client.loggedInWith).toBe(BOT_TOKEN);
    expect(a.isConnected()).toBe(true);
    await a.stop();
    expect(client.destroyed).toBe(true);
    expect(a.isConnected()).toBe(false);
  });

  it("tracks disconnect/resume state and rethrows login failures", async () => {
    const { client, adapter: a } = build();
    await a.start(() => {});
    client.emit("shardDisconnect");
    expect(a.isConnected()).toBe(false);
    client.emit("shardResume");
    expect(a.isConnected()).toBe(true);

    const bad = new FakeDiscordClient();
    bad.login = async () => {
      throw new Error("invalid token");
    };
    const { adapter: b } = build(bad);
    await expect(b.start(() => {})).rejects.toThrow(/invalid token/);
    expect(bad.destroyed).toBe(true);
    expect(b.getStats().lastError).toMatch(/invalid token/);
  });

  it("handles DMs with raw ids and ignores bot authors", async () => {
    const { client, adapter: a } = build();
    const c = collector();
    await a.start(c.handler);
    client.emit("messageCreate", dMessage());
    client.emit("messageCreate", dMessage({ id: "m2", author: { id: "bot", bot: true } }));
    await waitFor(() => c.messages.length === 1);
    expect(c.messages[0]).toMatchObject({
      id: "m1",
      channel: "discord",
      chatId: "chan-1",
      senderId: "u1",
      isGroup: false,
      text: "hello",
      mentionsBot: true,
    });
    expect(c.messages).toHaveLength(1);
  });

  it("gates guild messages on mention or pattern and strips the bot mention", async () => {
    const { client, adapter: a } = build();
    const c = collector();
    await a.start(c.handler);
    const guild = { id: "g1" };
    client.emit("messageCreate", dMessage({ id: "g-a", guild, content: "no mention here" }));
    client.emit(
      "messageCreate",
      dMessage({
        id: "g-b",
        guild,
        content: "<@!B0T> do the thing",
        mentions: { has: (u: { id: string }) => u.id === "B0T" },
        reference: { messageId: "orig-1" },
      }),
    );
    client.emit("messageCreate", dMessage({ id: "g-c", guild, content: "@antigravity status" }));
    await waitFor(() => c.messages.length === 3);
    expect(c.messages.map((m) => m.isGroup)).toEqual([true, true, true]);
    expect(c.messages.map((m) => m.mentionsBot)).toEqual([false, true, true]);
    expect(c.messages[1]!.text).toBe("do the thing");
    expect(c.messages[1]!.replyToMessageId).toBe("orig-1");
  });

  it("dedupes repeated message ids", async () => {
    const { client, adapter: a } = build();
    const c = collector();
    await a.start(c.handler);
    client.emit("messageCreate", dMessage());
    client.emit("messageCreate", dMessage());
    await new Promise((r) => setTimeout(r, 30));
    expect(c.messages).toHaveLength(1);
  });

  it("downloads and saves inbound attachments", async () => {
    const urls: string[] = [];
    const { client, adapter: a } = build(undefined, async (url) => {
      urls.push(url);
      return Buffer.from("IMGDATA");
    });
    const c = collector();
    await a.start(c.handler);
    client.emit(
      "messageCreate",
      dMessage({
        content: "",
        attachments: new Map([
          ["a1", { id: "a1", url: "https://cdn.example.test/a.png", name: "a.png", contentType: "image/png", size: 7 }],
          ["a2", { id: "a2", url: "https://cdn.example.test/b.pdf", name: "b.pdf", contentType: "application/pdf", size: 7 }],
        ]),
      }),
    );
    await waitFor(() => c.messages.length === 1);
    const m = c.messages[0]!;
    expect(urls).toEqual(["https://cdn.example.test/a.png", "https://cdn.example.test/b.pdf"]);
    expect(m.attachments.map((x) => x.type)).toEqual(["image", "file"]);
    expect((await readFile(m.attachments[0]!.localPath!)).toString()).toBe("IMGDATA");
    expect(m.attachments[0]!.localPath!.startsWith(path.join(tmp, "media", "discord"))).toBe(true);
  });

  it("chunks outbound text to <= 1950, replies on first chunk, attaches files", async () => {
    const { client, adapter: a } = build();
    await a.start(() => {});
    const long = Array.from({ length: 700 }, (_, i) => `token${i}`).join(" ");
    const res = await a.sendMessage({
      chatId: "chan-1",
      text: long,
      replyToMessageId: "orig-1",
      attachments: [
        { buffer: Buffer.from("x"), name: "a.txt" },
        { path: "some/local/b.log" },
      ],
    });
    const sent = client.channel.sent;
    expect(sent.length).toBeGreaterThan(1);
    for (const s of sent) {
      expect(String(s.content ?? "").length).toBeLessThanOrEqual(1950);
    }
    expect(sent[0]!.reply).toEqual({ messageReference: "orig-1", failIfNotExists: false });
    expect(sent[1]!.reply).toBeUndefined();
    const last = sent[sent.length - 1]!;
    expect(last.files).toEqual([
      { attachment: Buffer.from("x"), name: "a.txt" },
      { attachment: "some/local/b.log", name: "b.log" },
    ]);
    expect(res).toEqual({ messageId: `sent-${sent.length}` });
  });

  it("sends attachment-only messages and throws for unknown channels", async () => {
    const { client, adapter: a } = build();
    await a.start(() => {});
    await a.sendMessage({ chatId: "chan-1", attachments: [{ buffer: Buffer.from("z"), name: "z.bin" }] });
    expect(client.channel.sent).toHaveLength(1);
    expect(client.channel.sent[0]!.content).toBeUndefined();
    await expect(a.sendMessage({ chatId: "nope", text: "hi" })).rejects.toThrow(/not available/);
  });

  it("implements typing, reactions and edits", async () => {
    const { client, adapter: a } = build();
    await a.start(() => {});
    const msg = new FakeDiscordMessage();
    client.channel.fetched.set("m9", msg);
    await a.sendTyping("chan-1", true);
    await a.sendTyping("chan-1", false);
    await a.react("chan-1", "m9", "👀");
    await a.editMessage("chan-1", "m9", "new text");
    expect(client.channel.typing).toBe(1);
    expect(msg.reactions).toEqual(["👀"]);
    expect(msg.edits).toEqual(["new text"]);
  });
});

/* -------------------------------------------------------------------- Slack */

type Handler = (args: { event: any }) => Promise<void> | void;

function makeSlackFake(opts: { uploads?: boolean } = {}) {
  const handlers = new Map<string, Handler>();
  const posts: any[] = [];
  const updates: any[] = [];
  const reactions: any[] = [];
  const uploads: any[] = [];
  const state = { started: false, stopped: false };
  const client: any = {
    auth: { test: async () => ({ user_id: "UBOT", bot_id: "BBOT" }) },
    chat: {
      postMessage: async (args: any) => {
        posts.push(args);
        return { ts: `ts-${posts.length}` };
      },
      update: async (args: any) => void updates.push(args),
    },
    reactions: { add: async (args: any) => void reactions.push(args) },
  };
  if (opts.uploads !== false) {
    client.filesUploadV2 = async (args: any) => void uploads.push(args);
  }
  const app: SlackAppLike = {
    event: (name: string, handler: Handler) => void handlers.set(name, handler),
    start: async () => void (state.started = true),
    stop: async () => void (state.stopped = true),
    client,
  };
  return { app, handlers, posts, updates, reactions, uploads, state, client };
}

function sEvent(overrides: Record<string, unknown> = {}) {
  return {
    type: "message",
    channel: "D111",
    channel_type: "im",
    user: "U1",
    text: "hello",
    ts: "1700000000.100000",
    ...overrides,
  };
}

describe("SlackChannelAdapter", () => {
  let adapter: SlackChannelAdapter | undefined;

  afterEach(async () => {
    await adapter?.stop();
    adapter = undefined;
  });

  function build(fake = makeSlackFake(), download?: (url: string, o?: any) => Promise<Buffer>) {
    const calls: Array<{ url: string; options?: any }> = [];
    adapter = new SlackChannelAdapter(makeConfig(), {
      appFactory: () => fake.app,
      download:
        download ??
        (async (url, options) => {
          calls.push({ url, options });
          return Buffer.from("slack-bytes");
        }),
      mediaDir: path.join(tmp, "media"),
    });
    return { fake, adapter, calls };
  }

  it("exposes name and requires config", () => {
    expect(createSlack(makeConfig()).name).toBe("slack");
    expect(() => createSlack(makeConfig({ slack: undefined }))).toThrow(/not configured/);
  });

  it("starts the app, learns the bot id, and stops cleanly", async () => {
    const { fake, adapter: a } = build();
    await a.start(() => {});
    expect(fake.state.started).toBe(true);
    expect(a.isConnected()).toBe(true);
    expect([...fake.handlers.keys()].sort()).toEqual(["app_mention", "message"]);
    await a.stop();
    expect(fake.state.stopped).toBe(true);
    expect(a.isConnected()).toBe(false);
  });

  it("handles DMs, ignoring bots, bot subtypes, edits, and duplicates", async () => {
    const { fake, adapter: a } = build();
    const c = collector();
    await a.start(c.handler);
    const onMessage = fake.handlers.get("message")!;
    await onMessage({ event: sEvent() });
    await onMessage({ event: sEvent() }); // duplicate
    await onMessage({ event: sEvent({ ts: "2", bot_id: "BX" }) });
    await onMessage({ event: sEvent({ ts: "3", subtype: "bot_message" }) });
    await onMessage({ event: sEvent({ ts: "4", subtype: "message_changed" }) });
    await onMessage({ event: sEvent({ ts: "5", user: "UBOT" }) });
    expect(c.messages).toHaveLength(1);
    expect(c.messages[0]).toMatchObject({
      id: "1700000000.100000",
      channel: "slack",
      chatId: "D111",
      senderId: "U1",
      isGroup: false,
      text: "hello",
      mentionsBot: true,
      timestamp: 1_700_000_000_100,
    });
  });

  it("gates channel messages on mention / pattern and strips <@BOT>", async () => {
    const { fake, adapter: a } = build();
    const c = collector();
    await a.start(c.handler);
    const onMessage = fake.handlers.get("message")!;
    const onMention = fake.handlers.get("app_mention")!;
    const ch = { channel: "C222", channel_type: "channel" };
    await onMessage({ event: sEvent({ ...ch, ts: "10", text: "just talking" }) });
    await onMessage({ event: sEvent({ ...ch, ts: "11", text: "<@UBOT> what &amp; why? <https://example.com|link>" }) });
    await onMessage({ event: sEvent({ ...ch, ts: "12", text: "@agy ping" }) });
    await onMention({ event: sEvent({ ...ch, type: "app_mention", ts: "13", text: "<@UBOT>: hi" }) });
    // app_mention duplicate of the already-seen message event is deduped
    await onMention({ event: sEvent({ ...ch, type: "app_mention", ts: "11", text: "<@UBOT> dup" }) });
    expect(c.messages.map((m) => m.isGroup)).toEqual([true, true, true, true]);
    expect(c.messages.map((m) => m.mentionsBot)).toEqual([false, true, true, true]);
    expect(c.messages[1]!.text).toBe("what & why? https://example.com");
    expect(c.messages[3]!.text).toBe("hi");
    expect(c.messages[0]!.chatId).toBe("C222");
  });

  it("downloads files with bearer auth and saves them", async () => {
    const { fake, adapter: a, calls } = build();
    const c = collector();
    await a.start(c.handler);
    await fake.handlers.get("message")!({
      event: sEvent({
        text: "",
        subtype: "file_share",
        files: [
          { id: "F1", name: "shot.png", mimetype: "image/png", size: 11, url_private_download: "https://files.example.test/dl/shot.png" },
          { id: "F2", name: "doc.pdf", mimetype: "application/pdf", url_private: "https://files.example.test/doc.pdf" },
        ],
      }),
    });
    expect(c.messages).toHaveLength(1);
    const m = c.messages[0]!;
    expect(calls.map((x) => x.url)).toEqual([
      "https://files.example.test/dl/shot.png",
      "https://files.example.test/doc.pdf",
    ]);
    expect(calls[0]!.options.headers.Authorization).toBe(`Bearer ${BOT_TOKEN}`);
    expect(m.attachments.map((x) => x.type)).toEqual(["image", "file"]);
    expect((await readFile(m.attachments[0]!.localPath!)).toString()).toBe("slack-bytes");
    expect(m.attachments[0]!.localPath!.startsWith(path.join(tmp, "media", "slack"))).toBe(true);
  });

  it("keeps replies in-thread and honours explicit replyToMessageId in channels", async () => {
    const { fake, adapter: a } = build();
    const c = collector();
    await a.start(c.handler);
    const onMessage = fake.handlers.get("message")!;
    await onMessage({
      event: sEvent({ channel: "C222", channel_type: "channel", ts: "20.2", thread_ts: "20.1", text: "@agy in thread" }),
    });
    expect(c.messages[0]!.replyToMessageId).toBe("20.1");

    await a.sendMessage({ chatId: "C222", text: "tracked thread reply" });
    expect(fake.posts[0]).toMatchObject({ token: BOT_TOKEN, channel: "C222", text: "tracked thread reply", thread_ts: "20.1" });

    await a.sendMessage({ chatId: "C333", text: "explicit", replyToMessageId: "30.1" });
    expect(fake.posts[1]).toMatchObject({ channel: "C333", thread_ts: "30.1" });

    // a later top-level message clears the tracked thread
    await onMessage({ event: sEvent({ channel: "C222", channel_type: "channel", ts: "21.1", text: "@agy top-level" }) });
    await a.sendMessage({ chatId: "C222", text: "top-level reply" });
    expect(fake.posts[2]!.thread_ts).toBeUndefined();
  });

  it("does not start threads in DMs unless continuing one", async () => {
    const { fake, adapter: a } = build();
    await a.start(() => {});
    await a.sendMessage({ chatId: "D111", text: "plain", replyToMessageId: "40.1" });
    expect(fake.posts[0]!.thread_ts).toBeUndefined();
    await fake.handlers.get("message")!({ event: sEvent({ ts: "41.2", thread_ts: "41.1" }) });
    await a.sendMessage({ chatId: "D111", text: "threaded", replyToMessageId: "41.1" });
    expect(fake.posts[1]!.thread_ts).toBe("41.1");
  });

  it("chunks outbound text to <= 3900 and returns the last ts", async () => {
    const { fake, adapter: a } = build();
    await a.start(() => {});
    const long = Array.from({ length: 1800 }, (_, i) => `w${i}`).join(" ");
    const res = await a.sendMessage({ chatId: "C222", text: long });
    expect(fake.posts.length).toBeGreaterThan(1);
    for (const p of fake.posts) {
      expect(p.text.length).toBeLessThanOrEqual(3900);
    }
    expect(res).toEqual({ messageId: `ts-${fake.posts.length}` });
  });

  it("uploads attachments via filesUploadV2 and falls back gracefully", async () => {
    const withUpload = build();
    await withUpload.adapter.start(() => {});
    await withUpload.adapter.sendMessage({
      chatId: "C222",
      replyToMessageId: "50.1",
      attachments: [{ buffer: Buffer.from("DATA"), name: "out.txt" }],
    });
    expect(withUpload.fake.uploads[0]).toMatchObject({
      token: BOT_TOKEN,
      channel_id: "C222",
      filename: "out.txt",
      thread_ts: "50.1",
    });
    expect(withUpload.fake.uploads[0].file.toString()).toBe("DATA");
    await withUpload.adapter.stop();

    const noUpload = build(makeSlackFake({ uploads: false }));
    await noUpload.adapter.start(() => {});
    await noUpload.adapter.sendMessage({
      chatId: "C222",
      attachments: [{ buffer: Buffer.from("DATA"), name: "out.txt" }],
    });
    expect(noUpload.fake.posts[0]!.text).toContain("out.txt");
  });

  it("implements reactions with emoji mapping and edits via chat.update", async () => {
    const { fake, adapter: a } = build();
    await a.start(() => {});
    await a.react("C222", "1.1", "👀");
    await a.react("C222", "1.1", "👍");
    await a.react("C222", "1.1", "👎");
    await a.react("C222", "1.1", ":tada:");
    await a.react("C222", "1.1", "🦄🦄"); // unmappable -> ignored
    expect(fake.reactions.map((r) => r.name)).toEqual(["eyes", "+1", "-1", "tada"]);
    expect(fake.reactions[0]).toMatchObject({ token: BOT_TOKEN, channel: "C222", timestamp: "1.1" });
    await a.editMessage("C222", "1.1", "edited");
    expect(fake.updates).toEqual([{ token: BOT_TOKEN, channel: "C222", ts: "1.1", text: "edited" }]);
  });

  it("swallows already_reacted errors", async () => {
    const { fake, adapter: a } = build();
    await a.start(() => {});
    fake.client.reactions.add = async () => {
      throw new Error("An API error occurred: already_reacted");
    };
    await expect(a.react("C1", "1.1", "👀")).resolves.toBeUndefined();
    expect(a.getStats().lastError).toBeUndefined();
  });

  it("toSlackReactionName maps common emoji", () => {
    expect(toSlackReactionName("👀")).toBe("eyes");
    expect(toSlackReactionName("❤️")).toBe("heart");
    expect(toSlackReactionName("thumbsup")).toBe("thumbsup");
    expect(toSlackReactionName("")).toBeUndefined();
  });
});
