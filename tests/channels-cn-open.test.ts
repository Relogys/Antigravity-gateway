import { createHmac } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DingTalkChannelAdapter,
  DINGTALK_TOPIC_ROBOT,
  type DingTalkClientLike,
  type DingTalkDownStream,
} from "../src/channels/dingtalk.js";
import {
  FeishuChannelAdapter,
  type FeishuClientLike,
  type FeishuEventDispatcherLike,
  type FeishuWsClientLike,
  parseFeishuPost,
  toFeishuEmojiType,
} from "../src/channels/feishu.js";
import {
  decodeOneBotChatId,
  encodeOneBotChatId,
  OneBotChannelAdapter,
  type OneBotSocketLike,
  parseCqMessage,
} from "../src/channels/onebot.js";
import {
  isLoopbackHost,
  signWebhookBody,
  WebhookChannelAdapter,
} from "../src/channels/webhook.js";
import { loadConfig, type GatewayConfig } from "../src/config.js";
import type { InboundMessage } from "../src/types.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-gw-test-"));
  tempDirs.push(dir);
  return dir;
}

function makeConfig(
  dataDir: string,
  overrides: Partial<GatewayConfig> = {},
): GatewayConfig {
  const base = loadConfig({ DATA_DIR: dataDir }, { loadDotenv: false });
  return { ...base, ...overrides };
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

// ============================================================================
// Feishu
// ============================================================================

describe("FeishuChannelAdapter", () => {
  function makeFakeFeishu(mediaBytes = Buffer.from("img-bytes")) {
    const calls = {
      reply: [] as unknown[],
      create: [] as unknown[],
      imageCreate: [] as unknown[],
      fileCreate: [] as unknown[],
      react: [] as unknown[],
      resourceGet: [] as unknown[],
      wsClose: 0,
    };
    const handlers: Record<string, (data: unknown) => unknown> = {};

    const client: FeishuClientLike = {
      request: vi.fn(async () => ({ bot: { open_id: "ou_bot_1" } })),
      im: {
        message: {
          reply: vi.fn(async (arg) => {
            calls.reply.push(arg);
            return { code: 0, data: { message_id: `om_reply_${calls.reply.length}` } };
          }),
          create: vi.fn(async (arg) => {
            calls.create.push(arg);
            return { code: 0, data: { message_id: `om_msg_${calls.create.length}` } };
          }),
        },
        messageResource: {
          get: vi.fn(async (arg) => {
            calls.resourceGet.push(arg);
            return {
              headers: { "content-type": "image/png" },
              getReadableStream: () =>
                (async function* () {
                  yield mediaBytes;
                })(),
            };
          }),
        },
        image: {
          create: vi.fn(async (arg) => {
            calls.imageCreate.push(arg);
            return { image_key: "img_uploaded_1" };
          }),
        },
        file: {
          create: vi.fn(async (arg) => {
            calls.fileCreate.push(arg);
            return { file_key: "file_uploaded_1" };
          }),
        },
        messageReaction: {
          create: vi.fn(async (arg) => {
            calls.react.push(arg);
            return { code: 0 };
          }),
        },
      },
    };

    const dispatcher: FeishuEventDispatcherLike = {
      register(map) {
        Object.assign(handlers, map);
        return this;
      },
    };

    const ws: FeishuWsClientLike = {
      start: vi.fn(async () => {}),
      close: vi.fn(() => {
        calls.wsClose += 1;
      }),
    };

    return { client, dispatcher, ws, handlers, calls };
  }

  it("parses DM/group text, strips bot @mention placeholder, deduplicates, and downloads media", async () => {
    const dir = await makeTempDir();
    const cfg = makeConfig(dir, {
      feishu: {
        appId: "cli_test_app",
        appSecret: "sec_test",
        domain: "feishu",
        allowedUsers: new Set(),
      },
    });
    const fake = makeFakeFeishu(Buffer.from("png-data"));
    const adapter = new FeishuChannelAdapter(cfg, {
      createClient: () => fake.client,
      createWsClient: () => fake.ws,
      createEventDispatcher: () => fake.dispatcher,
    });

    const received: InboundMessage[] = [];
    await adapter.start((m) => {
      received.push(m);
    });
    expect(adapter.isConnected()).toBe(true);

    // Group message mentioning the bot (via botOpenId resolved from /open-apis/bot/v3/info)
    await fake.handlers["im.message.receive_v1"]({
      sender: { sender_type: "user", sender_id: { open_id: "ou_user_42" } },
      message: {
        message_id: "om_1",
        chat_id: "oc_group_99",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "@_user_1   hello @_user_2  " }),
        mentions: [
          { key: "@_user_1", id: { open_id: "ou_bot_1" }, name: "AgyBot" },
          { key: "@_user_2", id: { open_id: "ou_other" }, name: "Alice" },
        ],
        create_time: "1700000000000",
      },
    });
    // Duplicate message_id should be ignored
    await fake.handlers["im.message.receive_v1"]({
      sender: { sender_type: "user", sender_id: { open_id: "ou_user_42" } },
      message: {
        message_id: "om_1",
        chat_id: "oc_group_99",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "duplicate" }),
      },
    });

    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(received[0]).toMatchObject({
      id: "om_1",
      channel: "feishu",
      chatId: "oc_group_99",
      senderId: "ou_user_42",
      isGroup: true,
      mentionsBot: true,
      text: "hello @Alice",
    });

    // DM post with inline image
    await fake.handlers["im.message.receive_v1"]({
      sender: { sender_type: "user", sender_id: { user_id: "uid_7" } },
      message: {
        message_id: "om_2",
        chat_id: "oc_dm_7",
        chat_type: "p2p",
        message_type: "post",
        content: JSON.stringify({
          zh_cn: {
            title: "Note",
            content: [
              [{ tag: "text", text: "see " }, { tag: "a", text: "doc", href: "https://example.com" }],
              [{ tag: "img", image_key: "img_k1" }],
            ],
          },
        }),
      },
    });
    await vi.waitFor(() => expect(received).toHaveLength(2));
    expect(received[1]).toMatchObject({
      id: "om_2",
      chatId: "oc_dm_7",
      senderId: "uid_7",
      isGroup: false,
      text: "Note\nsee doc (https://example.com)",
    });
    expect(received[1].attachments).toHaveLength(1);
    expect(received[1].attachments[0].type).toBe("image");
    expect(received[1].attachments[0].localPath).toBeTruthy();
    const saved = await fs.readFile(received[1].attachments[0].localPath!);
    expect(saved.toString()).toBe("png-data");

    await adapter.stop();
    expect(fake.calls.wsClose).toBe(1);
    expect(adapter.isConnected()).toBe(false);
  });

  it("chunks outbound text <= 4000 chars, uploads attachments, and sends reactions", async () => {
    const dir = await makeTempDir();
    const cfg = makeConfig(dir, {
      feishu: {
        appId: "cli_test_app",
        appSecret: "sec_test",
        domain: "lark",
        allowedUsers: new Set(),
      },
    });
    const fake = makeFakeFeishu();
    const adapter = new FeishuChannelAdapter(cfg, {
      createClient: () => fake.client,
      createWsClient: () => fake.ws,
      createEventDispatcher: () => fake.dispatcher,
      botOpenId: "ou_bot_1",
    });
    await adapter.start(() => {});

    const longText = "a".repeat(4500);
    const res = await adapter.sendMessage({
      chatId: "oc_chat_1",
      text: longText,
      replyToMessageId: "om_orig",
      attachments: [
        { name: "pic.png", mimeType: "image/png", buffer: Buffer.from("img") },
        { name: "doc.txt", mimeType: "text/plain", buffer: Buffer.from("txt") },
      ],
    });
    expect(res?.messageId).toBeTruthy();
    // First text chunk uses reply; second chunk + 2 attachments use create
    expect(fake.calls.reply).toHaveLength(1);
    expect(fake.calls.create).toHaveLength(3);
    for (const c of [...fake.calls.reply, ...fake.calls.create] as Array<{
      data: { msg_type: string; content: string };
    }>) {
      if (c.data.msg_type === "text") {
        const parsed = JSON.parse(c.data.content) as { text: string };
        expect(parsed.text.length).toBeLessThanOrEqual(4000);
      }
    }
    expect(fake.calls.imageCreate).toHaveLength(1);
    expect(fake.calls.fileCreate).toHaveLength(1);

    await adapter.react("oc_chat_1", "om_orig", "👍");
    await adapter.react("oc_chat_1", "om_orig", "EYES");
    expect(fake.calls.react).toEqual([
      { path: { message_id: "om_orig" }, data: { reaction_type: { emoji_type: "THUMBSUP" } } },
      { path: { message_id: "om_orig" }, data: { reaction_type: { emoji_type: "EYES" } } },
    ]);

    expect(toFeishuEmojiType("👎")).toBe("THUMBSDOWN");
    expect(parseFeishuPost({ content: [[{ tag: "text", text: "hi" }]] }).text).toBe("hi");
    await adapter.stop();
  });
});

// ============================================================================
// DingTalk
// ============================================================================

describe("DingTalkChannelAdapter", () => {
  it("handles Stream callbacks, dedupe, richText/media, and webhook + proactive fallback", async () => {
    const dir = await makeTempDir();
    let nowMs = 1_700_000_000_000;
    const cfg = makeConfig(dir, {
      dingtalk: {
        clientId: "ding_app_1",
        clientSecret: "ding_sec_1",
        allowedUsers: new Set(),
      },
    });

    let listener: ((msg: DingTalkDownStream) => unknown) | undefined;
    const acks: unknown[] = [];
    const fakeClient: DingTalkClientLike = {
      registerCallbackListener(topic, cb) {
        expect(topic).toBe(DINGTALK_TOPIC_ROBOT);
        listener = cb;
      },
      connect: vi.fn(async () => {}),
      disconnect: vi.fn(() => {}),
      socketCallBackResponse(id, result) {
        acks.push({ id, result });
      },
    };

    const fetchCalls: Array<{ url: string; body?: string }> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      fetchCalls.push({ url, body: typeof init?.body === "string" ? init.body : undefined });
      if (url.includes("/v1.0/oauth2/accessToken")) {
        return new Response(JSON.stringify({ accessToken: "tok_123", expireIn: 7200 }), {
          status: 200,
        });
      }
      if (url.includes("/v1.0/robot/messageFiles/download")) {
        return new Response(
          JSON.stringify({ downloadUrl: "https://dl.example.test/file.png" }),
          { status: 200 },
        );
      }
      if (url === "https://dl.example.test/file.png") {
        return new Response(Buffer.from("ding-pic"), { status: 200 });
      }
      if (url.startsWith("https://oapi.dingtalk.com/robot/sendBySession")) {
        return new Response(JSON.stringify({ errcode: 0 }), { status: 200 });
      }
      if (url.includes("/v1.0/robot/oToMessages/batchSend")) {
        return new Response(JSON.stringify({ processQueryKey: "pq_1" }), { status: 200 });
      }
      return new Response("{}", { status: 404 });
    }) as unknown as typeof fetch;

    const adapter = new DingTalkChannelAdapter(cfg, {
      createClient: () => fakeClient,
      fetchImpl,
      now: () => nowMs,
    });

    const received: InboundMessage[] = [];
    await adapter.start((m) => {
      received.push(m);
    });
    expect(adapter.isConnected()).toBe(true);

    // 1) Group text message via Stream callback
    listener!({
      headers: { messageId: "stream_1" },
      data: JSON.stringify({
        msgId: "dt_msg_1",
        conversationId: "cid_group_1",
        conversationType: "2",
        senderStaffId: "staff_42",
        senderId: "raw_42",
        isInAtList: true,
        msgtype: "text",
        text: { content: " hello team " },
        sessionWebhook: "https://oapi.dingtalk.com/robot/sendBySession?session=abc",
        sessionWebhookExpiredTime: nowMs + 60_000,
        robotCode: "ding_app_1",
        createAt: nowMs,
      }),
    });
    // Duplicate msgId ignored
    listener!({
      headers: { messageId: "stream_2" },
      data: JSON.stringify({
        msgId: "dt_msg_1",
        conversationId: "cid_group_1",
        conversationType: "2",
        senderStaffId: "staff_42",
        msgtype: "text",
        text: { content: "dup" },
      }),
    });

    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(acks).toHaveLength(2);
    expect(received[0]).toMatchObject({
      id: "dt_msg_1",
      channel: "dingtalk",
      chatId: "cid_group_1",
      senderId: "staff_42",
      isGroup: true,
      mentionsBot: true,
      text: "hello team",
    });

    // 2) DM richText with picture download
    await adapter.handleCallback({
      msgId: "dt_msg_2",
      conversationId: "cid_dm_1",
      conversationType: "1",
      senderId: "sender_only_1",
      msgtype: "richText",
      content: {
        richText: [{ text: "look: " }, { type: "picture", downloadCode: "dl_code_1" }],
      },
      sessionWebhook: "https://oapi.dingtalk.com/robot/sendBySession?session=dm",
      sessionWebhookExpiredTime: nowMs + 10_000,
    });
    expect(received).toHaveLength(2);
    expect(received[1]).toMatchObject({
      chatId: "cid_dm_1",
      senderId: "sender_only_1",
      isGroup: false,
      text: "look:",
    });
    expect(received[1].attachments).toHaveLength(1);
    expect((await fs.readFile(received[1].attachments[0].localPath!)).toString()).toBe("ding-pic");

    // 3) Outbound reply via fresh sessionWebhook (chunked <= 4000)
    await adapter.sendMessage({
      chatId: "cid_group_1",
      text: "x".repeat(4500),
      markdown: true,
    });
    const webhookPosts = fetchCalls.filter((c) => c.url.includes("sendBySession?session=abc"));
    expect(webhookPosts).toHaveLength(2);
    for (const p of webhookPosts) {
      const parsed = JSON.parse(p.body!) as { msgtype: string; markdown: { text: string } };
      expect(parsed.msgtype).toBe("markdown");
      expect(parsed.markdown.text.length).toBeLessThanOrEqual(4000);
    }

    // 4) Expired sessionWebhook falls back to OpenAPI proactive send (when staffId is known)
    nowMs += 120_000;
    await adapter.handleCallback({
      msgId: "dt_msg_3",
      conversationId: "cid_dm_staff",
      conversationType: "1",
      senderStaffId: "staff_99",
      msgtype: "text",
      text: { content: "ping" },
      sessionWebhook: "https://oapi.dingtalk.com/robot/sendBySession?session=expired",
      sessionWebhookExpiredTime: nowMs - 5000,
    });
    const proactiveRes = await adapter.sendMessage({ chatId: "cid_dm_staff", text: "pong" });
    expect(proactiveRes?.messageId).toBe("pq_1");
    expect(fetchCalls.some((c) => c.url.includes("/v1.0/robot/oToMessages/batchSend"))).toBe(true);

    // 5) Expired sessionWebhook on DM without staffId throws descriptive error
    await expect(adapter.sendMessage({ chatId: "cid_dm_1", text: "fail" })).rejects.toThrow(
      /sessionWebhook expired/i,
    );

    await adapter.stop();
  });
});

// ============================================================================
// OneBot v11
// ============================================================================

describe("OneBotChannelAdapter & CQ parsing", () => {
  it("parses both string CQ codes and array segments", () => {
    const fromString = parseCqMessage(
      "[CQ:reply,id=55] [CQ:at,qq=10001] hi [CQ:at,qq=20002] &#91;ok&#93; [CQ:image,file=a.png,url=https://img.example.test/a.png]",
      "10001",
    );
    expect(fromString).toEqual({
      text: "hi @20002 [ok]",
      mentionsBot: true,
      mentionsAll: false,
      replyToMessageId: "55",
      attachments: [{ type: "image", name: "a.png", file: "a.png", url: "https://img.example.test/a.png" }],
    });

    const fromArray = parseCqMessage(
      [
        { type: "reply", data: { id: 88 } },
        { type: "at", data: { qq: "all" } },
        { type: "at", data: { qq: "10001" } },
        { type: "text", data: { text: " check this " } },
        { type: "file", data: { name: "report.pdf", url: "https://img.example.test/r.pdf" } },
      ],
      10001,
    );
    expect(fromArray).toEqual({
      text: "check this",
      mentionsBot: true,
      mentionsAll: true,
      replyToMessageId: "88",
      attachments: [{ type: "file", name: "report.pdf", file: undefined, url: "https://img.example.test/r.pdf" }],
    });

    expect(encodeOneBotChatId("group", 12345)).toBe("group:12345");
    expect(decodeOneBotChatId("group:12345")).toEqual({ kind: "group", id: "12345" });
    expect(decodeOneBotChatId("private:999")).toEqual({ kind: "private", id: "999" });
  });

  it("connects with access_token, receives events, sends echo-tracked frames, and reconnects", async () => {
    const dir = await makeTempDir();
    const cfg = makeConfig(dir, {
      onebot: {
        wsUrl: "ws://127.0.0.1:3001",
        accessToken: "ob_tok",
        selfId: "10001",
        allowedUsers: new Set(),
      },
    });

    const sockets: MockSocket[] = [];
    class MockSocket implements OneBotSocketLike {
      readyState = 1;
      sent: string[] = [];
      private readonly listeners = new Map<string, Array<(ev: unknown) => void>>();

      constructor(readonly url: string) {
        sockets.push(this);
        queueMicrotask(() => this.emit("open", {}));
      }
      addEventListener(type: string, cb: (ev: unknown) => void): void {
        const list = this.listeners.get(type) ?? [];
        list.push(cb);
        this.listeners.set(type, list);
      }
      send(data: string): void {
        this.sent.push(data);
        const frame = JSON.parse(data) as { action: string; echo: string };
        queueMicrotask(() => {
          this.emit("message", {
            data: JSON.stringify({
              status: "ok",
              retcode: 0,
              echo: frame.echo,
              data: { message_id: 777 },
            }),
          });
        });
      }
      close(): void {
        this.readyState = 3;
        this.emit("close", {});
      }
      emit(type: string, ev: unknown): void {
        for (const cb of this.listeners.get(type) ?? []) {
          cb(ev);
        }
      }
    }

    const adapter = new OneBotChannelAdapter(cfg, {
      WebSocketCtor: MockSocket,
      reconnectDelay: () => 10,
      download: async () => Buffer.from("img-bytes"),
    });
    expect(adapter.buildUrl()).toBe("ws://127.0.0.1:3001/?access_token=ob_tok");

    const received: InboundMessage[] = [];
    await adapter.start((m) => {
      received.push(m);
    });
    expect(adapter.isConnected()).toBe(true);
    expect(sockets).toHaveLength(1);

    // Self message ignored
    sockets[0].emit("message", {
      data: JSON.stringify({
        post_type: "message",
        message_type: "private",
        message_id: 10,
        user_id: 10001,
        raw_message: "self",
      }),
    });
    // Private message
    sockets[0].emit("message", {
      data: JSON.stringify({
        post_type: "message",
        message_type: "private",
        message_id: 11,
        user_id: 555,
        raw_message: "hello bot",
        time: 1700000000,
      }),
    });
    // Group message with string CQ @mention + reply
    sockets[0].emit("message", {
      data: JSON.stringify({
        post_type: "message",
        message_type: "group",
        group_id: 888,
        user_id: 666,
        message_id: 12,
        message: "[CQ:reply,id=9][CQ:at,qq=10001] status?",
      }),
    });
    // Duplicate message_id ignored
    sockets[0].emit("message", {
      data: JSON.stringify({
        post_type: "message",
        message_type: "group",
        group_id: 888,
        user_id: 666,
        message_id: 12,
        message: "dup",
      }),
    });

    await vi.waitFor(() => expect(received).toHaveLength(2));
    expect(received[0]).toMatchObject({
      id: "11",
      chatId: "private:555",
      senderId: "555",
      isGroup: false,
      text: "hello bot",
    });
    expect(received[1]).toMatchObject({
      id: "12",
      chatId: "group:888",
      senderId: "666",
      isGroup: true,
      mentionsBot: true,
      replyToMessageId: "9",
      text: "status?",
    });

    // Outbound group message with reply + chunking + base64 image
    const outRes = await adapter.sendMessage({
      chatId: "group:888",
      text: "z".repeat(4000),
      replyToMessageId: "12",
      attachments: [{ name: "shot.png", mimeType: "image/png", buffer: Buffer.from("PNG") }],
    });
    expect(outRes?.messageId).toBe("777");
    const frames = sockets[0].sent.map((s) => JSON.parse(s) as { action: string; params: Record<string, unknown> });
    expect(frames).toHaveLength(3);
    expect(frames[0].action).toBe("send_group_msg");
    expect(frames[0].params.group_id).toBe(888);
    expect(frames[0].params.message).toEqual([
      { type: "reply", data: { id: "12" } },
      { type: "text", data: { text: "z".repeat(3500) } },
    ]);
    expect(frames[2].params.message).toEqual([
      { type: "image", data: { file: `base64://${Buffer.from("PNG").toString("base64")}` } },
    ]);

    // Unexpected close triggers reconnect
    sockets[0].close();
    await vi.waitFor(() => expect(sockets.length).toBeGreaterThanOrEqual(2));

    await adapter.stop();
    expect(adapter.isConnected()).toBe(false);
  });
});

// ============================================================================
// Webhook HTTP
// ============================================================================

describe("WebhookChannelAdapter", () => {
  it("refuses to bind non-loopback hosts without token or secret", async () => {
    const dir = await makeTempDir();
    const cfg = makeConfig(dir, {
      webhook: {
        enabled: true,
        host: "0.0.0.0",
        port: 0,
        allowedUsers: new Set(),
      },
    });
    const adapter = new WebhookChannelAdapter(cfg);
    await expect(adapter.start(() => {})).rejects.toThrow(/non-loopback/i);
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
  });

  it("enforces Bearer + HMAC-SHA256 auth and handles sync wait:true round-trip", async () => {
    const dir = await makeTempDir();
    const token = "bearer-secret-token";
    const secret = "hmac-signing-secret";
    const cfg = makeConfig(dir, {
      webhook: {
        enabled: true,
        host: "127.0.0.1",
        port: 0,
        token,
        secret,
        allowedUsers: new Set(),
      },
    });
    const adapter = new WebhookChannelAdapter(cfg, { settleMs: 15, idleMs: 100 });
    await adapter.start(async (msg) => {
      await adapter.sendMessage({
        chatId: msg.chatId,
        text: `echo: ${msg.text}`,
        replyToMessageId: msg.id,
      });
    });

    const baseUrl = `http://127.0.0.1:${adapter.getPort()}`;
    try {
      const health = await fetch(`${baseUrl}/v1/health`);
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ ok: true, channel: "webhook" });

      const body = JSON.stringify({ chatId: "siri-1", senderId: "u1", text: "hi", wait: true });

      // Missing auth -> 401
      const noAuth = await fetch(`${baseUrl}/v1/messages`, { method: "POST", body });
      expect(noAuth.status).toBe(401);

      // Bad signature -> 401
      const badSig = await fetch(`${baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "x-webhook-signature": "sha256=deadbeef",
        },
        body,
      });
      expect(badSig.status).toBe(401);

      // Valid Bearer + HMAC-SHA256 -> 200 with buffered replies
      const sig = signWebhookBody(secret, body);
      const okRes = await fetch(`${baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
          "x-webhook-signature": sig,
        },
        body,
      });
      expect(okRes.status).toBe(200);
      const json = (await okRes.json()) as {
        ok: boolean;
        messageId: string;
        replies: Array<{ text: string; replyToMessageId?: string }>;
      };
      expect(json.ok).toBe(true);
      expect(json.replies).toHaveLength(1);
      expect(json.replies[0].text).toBe("echo: hi");
      expect(json.replies[0].replyToMessageId).toBe(json.messageId);
    } finally {
      await adapter.stop();
    }
  });

  it("returns 202 and delivers signed callbackUrl POST + SSE events for async messages", async () => {
    const dir = await makeTempDir();
    const secret = "cb-secret";
    const callbacks: Array<{ sig: string | null; body: string }> = [];
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      callbacks.push({
        sig: headers.get("x-webhook-signature"),
        body: String(init?.body ?? ""),
      });
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;

    const cfg = makeConfig(dir, {
      webhook: {
        enabled: true,
        host: "127.0.0.1",
        port: 0,
        secret,
        callbackUrl: "https://bridge.example.test/hook",
        allowedUsers: new Set(),
      },
    });

    const adapter = new WebhookChannelAdapter(cfg, { fetchImpl });
    await adapter.start(async (msg) => {
      await adapter.sendMessage({ chatId: msg.chatId, text: "async-reply" });
    });

    const baseUrl = `http://127.0.0.1:${adapter.getPort()}`;
    const sseAbort = new AbortController();
    try {
      // Connect SSE listener
      const sseRes = await fetch(`${baseUrl}/v1/events?chatId=async-1`, {
        headers: { "x-webhook-signature": signWebhookBody(secret, Buffer.alloc(0)) },
        signal: sseAbort.signal,
      });
      expect(sseRes.status).toBe(200);
      const reader = sseRes.body!.getReader();

      // Send async POST
      const payload = JSON.stringify({ chatId: "async-1", senderId: "u2", text: "trigger" });
      const postRes = await fetch(`${baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-webhook-signature": signWebhookBody(secret, payload),
        },
        body: payload,
      });
      expect(postRes.status).toBe(202);
      const accepted = (await postRes.json()) as { ok: boolean; messageId: string };
      expect(accepted.ok).toBe(true);
      expect(accepted.messageId).toBeTruthy();

      await vi.waitFor(() => expect(callbacks).toHaveLength(1));
      const expectedSig = `sha256=${createHmac("sha256", secret).update(callbacks[0].body).digest("hex")}`;
      expect(callbacks[0].sig).toBe(expectedSig);
      expect(JSON.parse(callbacks[0].body).text).toBe("async-reply");

      // Verify SSE frame arrived too
      let sseText = "";
      const decoder = new TextDecoder();
      while (!sseText.includes("async-reply")) {
        const { value, done } = await reader.read();
        if (done) break;
        sseText += decoder.decode(value, { stream: true });
      }
      expect(sseText).toContain("event: message");
      expect(sseText).toContain("async-reply");
    } finally {
      sseAbort.abort();
      await adapter.stop();
    }
  });
});
