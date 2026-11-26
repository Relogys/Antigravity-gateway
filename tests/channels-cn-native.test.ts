import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  decryptWeComMessage,
  encryptWeComMessage,
  verifyWeComSignature,
  WeComChannelAdapter,
} from "../src/channels/wecom.js";
import {
  QQBotChannelAdapter,
  type QQBotSocketLike,
} from "../src/channels/qqbot.js";
import { loadConfig, type GatewayConfig } from "../src/config.js";
import type { InboundMessage } from "../src/types.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-gw-cn-native-"));
  tempDirs.push(dir);
  return dir;
}

function makeConfig(dataDir: string, overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return { ...loadConfig({ DATA_DIR: dataDir }, { loadDotenv: false }), ...overrides };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

// ============================================================================
// WeCom (WXBizMsgCrypt)
// ============================================================================

const WECOM_TOKEN = "wecom-test-token";
const WECOM_CORP_ID = "wwcorp-test-0001";
const WECOM_AGENT_ID = 1_000_002;
const WECOM_SECRET = "wecom-test-secret";
// 32 bytes -> 43 Base64 characters, matching a real WeCom EncodingAESKey.
const WECOM_AES_KEY = Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1))
  .toString("base64")
  .replace(/=+$/, "");

function wecomSignature(token: string, timestamp: string, nonce: string, encrypt: string): string {
  return createHash("sha1").update([token, timestamp, nonce, encrypt].sort().join("")).digest("hex");
}

function encryptedEnvelope(
  innerXml: string,
  corpId = WECOM_CORP_ID,
): { encrypt: string; body: string } {
  const encrypt = encryptWeComMessage(WECOM_AES_KEY, innerXml, corpId);
  return { encrypt, body: `<xml><Encrypt><![CDATA[${encrypt}]]></Encrypt></xml>` };
}

function wecomTextXml(
  msgId: string,
  sender: string,
  content: string,
  createTime = 1_700_000_000,
): string {
  return [
    "<xml>",
    `<ToUserName><![CDATA[${WECOM_CORP_ID}]]></ToUserName>`,
    `<FromUserName><![CDATA[${sender}]]></FromUserName>`,
    `<CreateTime>${createTime}</CreateTime>`,
    "<MsgType><![CDATA[text]]></MsgType>",
    `<Content><![CDATA[${content}]]></Content>`,
    `<MsgId>${msgId}</MsgId>`,
    `<AgentID>${WECOM_AGENT_ID}</AgentID>`,
    "</xml>",
  ].join("");
}

function withQuery(base: string, params: Record<string, string>): string {
  const url = new URL(base);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

async function makeWeComAdapter(options: { withCredentials?: boolean } = {}) {
  const dir = await makeTempDir();
  const withCredentials = options.withCredentials ?? true;
  const cfg = makeConfig(dir, {
    wecom: {
      corpId: WECOM_CORP_ID,
      agentId: WECOM_AGENT_ID,
      secret: WECOM_SECRET,
      token: withCredentials ? WECOM_TOKEN : undefined,
      encodingAesKey: withCredentials ? WECOM_AES_KEY : undefined,
      host: "127.0.0.1",
      port: 0,
      allowedUsers: new Set(),
    },
  });
  return new WeComChannelAdapter(cfg, { mediaDir: path.join(dir, "media") });
}

describe("WeCom WXBizMsgCrypt", () => {
  it("round-trips AES-256-CBC payloads with random prefix/length/CorpID framing", () => {
    const plaintext = "<xml><Content>你好 WeCom & <b>markup</b></Content></xml>";
    const first = encryptWeComMessage(WECOM_AES_KEY, plaintext, WECOM_CORP_ID);
    const second = encryptWeComMessage(WECOM_AES_KEY, plaintext, WECOM_CORP_ID);

    expect(first).not.toBe(second); // random 16-byte prefix per message
    expect(decryptWeComMessage(WECOM_AES_KEY, first, WECOM_CORP_ID)).toBe(plaintext);
    expect(decryptWeComMessage(WECOM_AES_KEY, second, WECOM_CORP_ID)).toBe(plaintext);
    // CorpID is optional at decrypt time when unknown.
    expect(decryptWeComMessage(WECOM_AES_KEY, first)).toBe(plaintext);

    expect(() => decryptWeComMessage(WECOM_AES_KEY, first, "ww-foreign-corp")).toThrow(/CorpID/i);

    const otherKey = Buffer.from(Array.from({ length: 32 }, (_, i) => 255 - i))
      .toString("base64")
      .replace(/=+$/, "");
    expect(() => decryptWeComMessage(otherKey, first)).toThrow();

    const tampered = Buffer.from(first, "base64");
    tampered[tampered.byteLength - 1] ^= 0xff;
    expect(() => decryptWeComMessage(WECOM_AES_KEY, tampered.toString("base64"))).toThrow();

    expect(() => decryptWeComMessage("too-short", first)).toThrow(/EncodingAESKey/);
  });

  it("verifies SHA1 callback signatures over sorted token/timestamp/nonce/Encrypt", () => {
    const timestamp = "1700000123";
    const nonce = "nonce-42";
    const encrypt = encryptWeComMessage(WECOM_AES_KEY, "payload", WECOM_CORP_ID);
    const signature = wecomSignature(WECOM_TOKEN, timestamp, nonce, encrypt);

    expect(verifyWeComSignature(WECOM_TOKEN, timestamp, nonce, encrypt, signature)).toBe(true);
    expect(verifyWeComSignature(WECOM_TOKEN, timestamp, nonce, encrypt, ` ${signature.toUpperCase()} `)).toBe(true);
    expect(verifyWeComSignature(WECOM_TOKEN, timestamp, nonce, encrypt, "0".repeat(40))).toBe(false);
    expect(verifyWeComSignature("wrong-token", timestamp, nonce, encrypt, signature)).toBe(false);
    expect(verifyWeComSignature(WECOM_TOKEN, "1700000124", nonce, encrypt, signature)).toBe(false);
    expect(verifyWeComSignature(WECOM_TOKEN, timestamp, nonce, encrypt, "not-a-signature")).toBe(false);

    // Plaintext-mode callbacks sign the empty Encrypt slot.
    const plaintextSignature = wecomSignature(WECOM_TOKEN, timestamp, nonce, "");
    expect(verifyWeComSignature(WECOM_TOKEN, timestamp, nonce, "", plaintextSignature)).toBe(true);
  });
});

describe("WeComChannelAdapter HTTP callbacks", () => {
  it("answers encrypted echostr verification and rejects bad signatures", async () => {
    const adapter = await makeWeComAdapter();
    await adapter.start(() => {});
    expect(adapter.isConnected()).toBe(true);
    expect(adapter.getPort()).toBeTypeOf("number");

    const base = `http://127.0.0.1:${adapter.getPort()}/`;
    try {
      const timestamp = "1700000123";
      const nonce = "nonce-echo";
      const echo = "verified-echo-97531";
      const encryptedEcho = encryptWeComMessage(WECOM_AES_KEY, echo, WECOM_CORP_ID);
      const signature = wecomSignature(WECOM_TOKEN, timestamp, nonce, encryptedEcho);

      const okRes = await fetch(
        withQuery(base, { msg_signature: signature, timestamp, nonce, echostr: encryptedEcho }),
      );
      expect(okRes.status).toBe(200);
      expect(await okRes.text()).toBe(echo);

      const badRes = await fetch(
        withQuery(base, {
          msg_signature: wecomSignature("wrong-token", timestamp, nonce, encryptedEcho),
          timestamp,
          nonce,
          echostr: encryptedEcho,
        }),
      );
      expect(badRes.status).toBe(401);

      // Plaintext echostr (non-Base64) is signed with an empty Encrypt slot.
      const plainEcho = "plain-echo-12345";
      const plainSig = wecomSignature(WECOM_TOKEN, timestamp, nonce, "");
      const plainRes = await fetch(
        withQuery(base, { signature: plainSig, timestamp, nonce, echostr: plainEcho }),
      );
      expect(plainRes.status).toBe(200);
      expect(await plainRes.text()).toBe(plainEcho);

      const missingRes = await fetch(base);
      expect(missingRes.status).toBe(404);
    } finally {
      await adapter.stop();
    }
    expect(adapter.isConnected()).toBe(false);
  });

  it("echoes a plaintext echostr when no token/key is configured", async () => {
    const adapter = await makeWeComAdapter({ withCredentials: false });
    await adapter.start(() => {});
    try {
      const res = await fetch(
        withQuery(`http://127.0.0.1:${adapter.getPort()}/`, { echostr: "plain-mode-echo" }),
      );
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("plain-mode-echo");
    } finally {
      await adapter.stop();
    }
  });

  it("accepts a signed encrypted inbound XML once, dedupes retries, and rejects bad auth", async () => {
    const received: InboundMessage[] = [];
    const adapter = await makeWeComAdapter();
    await adapter.start((msg) => {
      received.push(msg);
    });
    const base = `http://127.0.0.1:${adapter.getPort()}/`;
    const timestamp = "1700000999";
    const nonce = "nonce-post-7";

    try {
      const inner = wecomTextXml("1000000000000001", "zhangsan", " hello <b>world</b> &amp; friends ", 1_700_000_500);
      const { encrypt, body } = encryptedEnvelope(inner);
      const signature = wecomSignature(WECOM_TOKEN, timestamp, nonce, encrypt);
      const postUrl = withQuery(base, { msg_signature: signature, timestamp, nonce });

      const first = await fetch(postUrl, { method: "POST", headers: { "content-type": "text/xml" }, body });
      expect(first.status).toBe(200);
      expect(await first.text()).toBe("success");
      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({
        id: "1000000000000001",
        channel: "wecom",
        chatId: "zhangsan",
        senderId: "zhangsan",
        isGroup: false,
        text: "hello <b>world</b> & friends",
        mentionsBot: true,
        timestamp: 1_700_000_500_000,
      });
      expect(received[0].raw).toMatchObject({
        msgtype: "text",
        msgid: "1000000000000001",
        fromusername: "zhangsan",
      });

      // WeCom retries the identical callback on timeout; dedupe must swallow it.
      const duplicate = await fetch(postUrl, { method: "POST", headers: { "content-type": "text/xml" }, body });
      expect(duplicate.status).toBe(200);
      expect(await duplicate.text()).toBe("success");
      expect(received).toHaveLength(1);

      const secondInner = wecomTextXml("1000000000000002", "lisi", "second message", 1_700_000_600);
      const secondEnvelope = encryptedEnvelope(secondInner);
      const secondUrl = withQuery(base, {
        msg_signature: wecomSignature(WECOM_TOKEN, timestamp, nonce, secondEnvelope.encrypt),
        timestamp,
        nonce,
      });
      const second = await fetch(secondUrl, {
        method: "POST",
        headers: { "content-type": "text/xml" },
        body: secondEnvelope.body,
      });
      expect(second.status).toBe(200);
      expect(received).toHaveLength(2);
      expect(received[1]).toMatchObject({ id: "1000000000000002", senderId: "lisi", text: "second message" });

      // Invalid signature -> 401 and no delivery.
      const badUrl = withQuery(base, {
        msg_signature: wecomSignature("wrong-token", timestamp, nonce, encrypt),
        timestamp,
        nonce,
      });
      const bad = await fetch(badUrl, { method: "POST", headers: { "content-type": "text/xml" }, body });
      expect(bad.status).toBe(401);
      expect(received).toHaveLength(2);

      // Valid signature but a foreign CorpID inside the ciphertext -> 400.
      const foreign = encryptedEnvelope(wecomTextXml("1000000000000003", "wangwu", "nope"), "ww-foreign-corp");
      const foreignUrl = withQuery(base, {
        msg_signature: wecomSignature(WECOM_TOKEN, timestamp, nonce, foreign.encrypt),
        timestamp,
        nonce,
      });
      const foreignRes = await fetch(foreignUrl, {
        method: "POST",
        headers: { "content-type": "text/xml" },
        body: foreign.body,
      });
      expect(foreignRes.status).toBe(400);
      expect(await foreignRes.text()).toMatch(/CorpID/i);
      expect(received).toHaveLength(2);

      // Event callbacks are acknowledged without being delivered as messages.
      const eventInner = [
        "<xml>",
        `<ToUserName><![CDATA[${WECOM_CORP_ID}]]></ToUserName>`,
        "<FromUserName><![CDATA[zhangsan]]></FromUserName>",
        "<CreateTime>1700000700</CreateTime>",
        "<MsgType><![CDATA[event]]></MsgType>",
        "<Event><![CDATA[enter_agent]]></Event>",
        "</xml>",
      ].join("");
      const eventEnvelope = encryptedEnvelope(eventInner);
      const eventUrl = withQuery(base, {
        msg_signature: wecomSignature(WECOM_TOKEN, timestamp, nonce, eventEnvelope.encrypt),
        timestamp,
        nonce,
      });
      const eventRes = await fetch(eventUrl, {
        method: "POST",
        headers: { "content-type": "text/xml" },
        body: eventEnvelope.body,
      });
      expect(eventRes.status).toBe(200);
      expect(received).toHaveLength(2);

      const putRes = await fetch(base, { method: "PUT" });
      expect(putRes.status).toBe(405);
    } finally {
      await adapter.stop();
    }
  });
});

describe("WeComChannelAdapter outbound", () => {
  it("sends chunked text/markdown and uploaded media with a cached access token", async () => {
    const dir = await makeTempDir();
    const cfg = makeConfig(dir, {
      wecom: {
        corpId: WECOM_CORP_ID,
        agentId: WECOM_AGENT_ID,
        secret: WECOM_SECRET,
        token: WECOM_TOKEN,
        encodingAesKey: WECOM_AES_KEY,
        host: "127.0.0.1",
        port: 0,
        allowedUsers: new Set(),
      },
    });

    const tokenRequests: string[] = [];
    const uploads: string[] = [];
    const sends: Array<Record<string, unknown>> = [];
    let messageSeq = 0;

    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === "/cgi-bin/gettoken") {
        tokenRequests.push(url.toString());
        return jsonResponse({ errcode: 0, errmsg: "ok", access_token: "wecom-access-1", expires_in: 7200 });
      }
      if (url.pathname === "/cgi-bin/media/upload") {
        uploads.push(url.toString());
        return jsonResponse({ errcode: 0, errmsg: "ok", media_id: "media-upload-1" });
      }
      if (url.pathname === "/cgi-bin/message/send") {
        sends.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        messageSeq += 1;
        return jsonResponse({ errcode: 0, errmsg: "ok", msgid: `wecom-msg-${messageSeq}` });
      }
      return jsonResponse({ errcode: 404, errmsg: "unexpected request" }, 404);
    }) as unknown as typeof fetch;

    const adapter = new WeComChannelAdapter(cfg, { fetchImpl, mediaDir: path.join(dir, "media") });

    const textRes = await adapter.sendMessage({ chatId: "zhangsan", text: "a".repeat(2500) });
    expect(textRes?.messageId).toBe("wecom-msg-2");
    expect(sends).toHaveLength(2);
    expect(sends[0]).toMatchObject({
      touser: "zhangsan",
      msgtype: "text",
      agentid: WECOM_AGENT_ID,
      text: { content: "a".repeat(2000) },
    });
    expect(sends[1]).toMatchObject({ touser: "zhangsan", msgtype: "text", text: { content: "a".repeat(500) } });

    await adapter.sendMessage({ chatId: "zhangsan", text: "# title", markdown: true });
    expect(sends[2]).toMatchObject({
      touser: "zhangsan",
      msgtype: "markdown",
      agentid: WECOM_AGENT_ID,
      markdown: { content: "# title" },
    });

    const mediaRes = await adapter.sendMessage({
      chatId: "zhangsan",
      attachments: [{ name: "chart.png", mimeType: "image/png", buffer: Buffer.from("png-bytes") }],
    });
    expect(mediaRes?.messageId).toBe("wecom-msg-4");
    expect(uploads).toHaveLength(1);
    const uploadUrl = new URL(uploads[0]);
    expect(uploadUrl.searchParams.get("type")).toBe("image");
    expect(uploadUrl.searchParams.get("access_token")).toBe("wecom-access-1");
    expect(sends[3]).toMatchObject({
      touser: "zhangsan",
      msgtype: "image",
      agentid: WECOM_AGENT_ID,
      image: { media_id: "media-upload-1" },
    });

    // One Corp token served every call; credentials were sent to gettoken.
    expect(tokenRequests).toHaveLength(1);
    const tokenUrl = new URL(tokenRequests[0]);
    expect(tokenUrl.searchParams.get("corpid")).toBe(WECOM_CORP_ID);
    expect(tokenUrl.searchParams.get("corpsecret")).toBe(WECOM_SECRET);
    for (const call of uploads) {
      expect(new URL(call).searchParams.get("access_token")).toBe("wecom-access-1");
    }
  });
});

// ============================================================================
// QQBot (Official Bot API v2 + Gateway WebSocket)
// ============================================================================

function makeQQHarness() {
  const sockets: FakeQQSocket[] = [];

  class FakeQQSocket implements QQBotSocketLike {
    readyState = 0;
    readonly sent: string[] = [];
    readonly closes: Array<{ code?: number; reason?: string }> = [];
    private readonly listeners = new Map<string, Array<(event: unknown) => void>>();

    constructor(readonly url: string) {
      sockets.push(this);
      queueMicrotask(() => {
        this.readyState = 1;
        this.emit("open", {});
      });
    }

    addEventListener(type: string, listener: (event: unknown) => void): void {
      const list = this.listeners.get(type) ?? [];
      list.push(listener);
      this.listeners.set(type, list);
    }

    send(data: string): void {
      this.sent.push(data);
    }

    close(code?: number, reason?: string): void {
      this.closes.push({ code, reason });
      this.readyState = 3;
      this.emit("close", { code, reason });
    }

    emit(type: string, event: unknown): void {
      for (const listener of this.listeners.get(type) ?? []) {
        listener(event);
      }
    }
  }

  return { sockets, FakeQQSocket };
}

const QQ_INTENTS = (1 << 30) | (1 << 25) | (1 << 12);

describe("QQBotChannelAdapter", () => {
  it("fetches an app token, identifies over the Gateway, dispatches C2C/group messages, and replies passively", async () => {
    const dir = await makeTempDir();
    const cfg = makeConfig(dir, {
      qqbot: {
        appId: "102030405",
        clientSecret: "qqbot-test-client-secret",
        sandbox: false,
        allowedUsers: new Set(),
      },
    });
    const { sockets, FakeQQSocket } = makeQQHarness();

    const calls: Array<{ url: string; method: string; headers: Headers; body: unknown }> = [];
    let replySeq = 0;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? "GET", headers: new Headers(init?.headers), body: init?.body });
      if (url === "https://bots.qq.com/app/getAppAccessToken") {
        return jsonResponse({ access_token: "qq-access-token-1", expires_in: "7200" });
      }
      if (url === "https://api.sgroup.qq.com/gateway") {
        return jsonResponse({ url: "wss://gateway.qq.example/ws" });
      }
      if (url === "https://api.sgroup.qq.com/v2/users/u_openid_1/messages") {
        replySeq += 1;
        return jsonResponse({ id: `qq-reply-${replySeq}`, timestamp: "2023-11-16T14:00:02+08:00" });
      }
      if (url === "https://api.sgroup.qq.com/v2/groups/g_openid_1/messages") {
        replySeq += 1;
        return jsonResponse({ id: `qq-reply-${replySeq}` });
      }
      return jsonResponse({ message: "unexpected request" }, 404);
    }) as unknown as typeof fetch;

    const heartbeats: Array<{ intervalMs: number; heartbeat: () => void }> = [];
    const adapter = new QQBotChannelAdapter(cfg, {
      fetchImpl,
      WebSocketCtor: FakeQQSocket,
      reconnectDelay: () => 5,
      startupTimeoutMs: 2_000,
      onHeartbeatInterval: (intervalMs, heartbeat) => {
        heartbeats.push({ intervalMs, heartbeat });
      },
    });

    const received: InboundMessage[] = [];
    const startPromise = adapter.start((msg) => {
      received.push(msg);
    });

    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    expect(sockets[0].url).toBe("wss://gateway.qq.example/ws");

    // op 10 Hello -> op 2 Identify
    sockets[0].emit("message", { data: JSON.stringify({ op: 10, s: 1, d: { heartbeat_interval: 30_000 } }) });
    await startPromise;
    await vi.waitFor(() => expect(sockets[0].sent).toHaveLength(1));

    const identify = JSON.parse(sockets[0].sent[0]) as {
      op: number;
      d: { token: string; intents: number; shard: number[]; properties: Record<string, string> };
    };
    expect(identify.op).toBe(2);
    expect(identify.d.token).toBe("QQBot qq-access-token-1");
    expect(identify.d.intents).toBe(QQ_INTENTS);
    expect(identify.d.shard).toEqual([0, 1]);
    expect(adapter.isConnected()).toBe(true);

    // Heartbeat uses the Hello interval and carries the latest sequence.
    expect(heartbeats).toHaveLength(1);
    expect(heartbeats[0].intervalMs).toBe(30_000);
    heartbeats[0].heartbeat();
    expect(JSON.parse(sockets[0].sent.at(-1)!)).toEqual({ op: 1, d: 1 });

    // op 0 C2C dispatch
    sockets[0].emit("message", {
      data: JSON.stringify({
        op: 0,
        s: 2,
        t: "C2C_MESSAGE_CREATE",
        d: {
          id: "qq-msg-c2c-1",
          content: " hello c2c ",
          timestamp: "2023-11-16T13:59:57+08:00",
          author: { user_openid: "u_openid_1" },
          attachments: [],
        },
      }),
    });
    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(received[0]).toMatchObject({
      id: "qq-msg-c2c-1",
      channel: "qqbot",
      chatId: "c2c:u_openid_1",
      senderId: "u_openid_1",
      isGroup: false,
      text: "hello c2c",
      mentionsBot: true,
      timestamp: Date.parse("2023-11-16T13:59:57+08:00"),
    });

    // op 0 group @ dispatch with a protocol-relative attachment URL
    sockets[0].emit("message", {
      data: JSON.stringify({
        op: 0,
        s: 3,
        t: "GROUP_AT_MESSAGE_CREATE",
        d: {
          id: "qq-msg-group-1",
          content: "@bot hi",
          timestamp: 1_700_000_000,
          group_openid: "g_openid_1",
          author: { member_openid: "m_openid_9" },
          attachments: [
            {
              url: "//multimedia.qq.example/img.png",
              content_type: "image/png",
              filename: "img.png",
              size: 1234,
            },
          ],
        },
      }),
    });
    await vi.waitFor(() => expect(received).toHaveLength(2));
    expect(received[1]).toMatchObject({
      id: "qq-msg-group-1",
      chatId: "group:g_openid_1",
      senderId: "m_openid_9",
      isGroup: true,
      text: "@bot hi",
      timestamp: 1_700_000_000_000,
    });
    expect(received[1].attachments).toEqual([
      {
        type: "image",
        url: "https://multimedia.qq.example/img.png",
        name: "img.png",
        mimeType: "image/png",
        sizeBytes: 1234,
      },
    ]);

    // Duplicate dispatch id is ignored.
    sockets[0].emit("message", {
      data: JSON.stringify({
        op: 0,
        s: 4,
        t: "C2C_MESSAGE_CREATE",
        d: { id: "qq-msg-c2c-1", content: "dup", author: { user_openid: "u_openid_1" } },
      }),
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(received).toHaveLength(2);

    // Passive C2C replies reuse the latest msg_id with an increasing msg_seq.
    const firstReply = await adapter.sendMessage({ chatId: "c2c:u_openid_1", text: "reply one" });
    expect(firstReply?.messageId).toBe("qq-reply-1");
    const secondReply = await adapter.sendMessage({ chatId: "c2c:u_openid_1", text: "reply two" });
    expect(secondReply?.messageId).toBe("qq-reply-2");

    const c2cPosts = calls.filter(
      (call) => call.url === "https://api.sgroup.qq.com/v2/users/u_openid_1/messages",
    );
    expect(c2cPosts).toHaveLength(2);
    expect(c2cPosts[0].method).toBe("POST");
    expect(c2cPosts[0].headers.get("authorization")).toBe("QQBot qq-access-token-1");
    expect(c2cPosts[0].headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(String(c2cPosts[0].body))).toEqual({
      content: "reply one",
      msg_type: 0,
      msg_seq: 1,
      msg_id: "qq-msg-c2c-1",
    });
    expect(JSON.parse(String(c2cPosts[1].body))).toEqual({
      content: "reply two",
      msg_type: 0,
      msg_seq: 2,
      msg_id: "qq-msg-c2c-1",
    });

    // Group reply honors an explicit replyToMessageId and its own msg_seq counter.
    const groupReply = await adapter.sendMessage({
      chatId: "group:g_openid_1",
      text: "group reply",
      replyToMessageId: "qq-msg-group-1",
    });
    expect(groupReply?.messageId).toBe("qq-reply-3");
    const groupPosts = calls.filter(
      (call) => call.url === "https://api.sgroup.qq.com/v2/groups/g_openid_1/messages",
    );
    expect(groupPosts).toHaveLength(1);
    expect(JSON.parse(String(groupPosts[0].body))).toEqual({
      content: "group reply",
      msg_type: 0,
      msg_seq: 1,
      msg_id: "qq-msg-group-1",
    });

    // Markdown uses msg_type 2 and continues the C2C sequence.
    await adapter.sendMessage({ chatId: "c2c:u_openid_1", text: "**bold**", markdown: true });
    const allC2cPosts = calls.filter(
      (call) => call.url === "https://api.sgroup.qq.com/v2/users/u_openid_1/messages",
    );
    expect(allC2cPosts).toHaveLength(3);
    expect(JSON.parse(String(allC2cPosts[2].body))).toMatchObject({
      msg_type: 2,
      msg_seq: 3,
      msg_id: "qq-msg-c2c-1",
      markdown: { content: "**bold**" },
    });

    // OAuth2 exchange happened exactly once and Gateway used its Bearer-style header.
    const tokenCalls = calls.filter((call) => call.url === "https://bots.qq.com/app/getAppAccessToken");
    expect(tokenCalls).toHaveLength(1);
    expect(tokenCalls[0].method).toBe("POST");
    expect(tokenCalls[0].headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(String(tokenCalls[0].body))).toEqual({
      appId: "102030405",
      clientSecret: "qqbot-test-client-secret",
    });
    const gatewayCall = calls.find((call) => call.url === "https://api.sgroup.qq.com/gateway");
    expect(gatewayCall?.headers.get("authorization")).toBe("QQBot qq-access-token-1");

    await adapter.stop();
    expect(adapter.isConnected()).toBe(false);
    expect(sockets[0].closes[0]).toEqual({ code: 1000, reason: "shutdown" });
  });

  it("uses the sandbox Gateway host when QQBOT_SANDBOX is enabled", async () => {
    const dir = await makeTempDir();
    const cfg = makeConfig(dir, {
      qqbot: {
        appId: "102030405",
        clientSecret: "qqbot-test-client-secret",
        sandbox: true,
        allowedUsers: new Set(),
      },
    });
    const { sockets, FakeQQSocket } = makeQQHarness();
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url === "https://bots.qq.com/app/getAppAccessToken") {
        return jsonResponse({ access_token: "qq-access-token-sandbox", expires_in: 7200 });
      }
      if (url === "https://sandbox.api.sgroup.qq.com/gateway") {
        return jsonResponse({ url: "wss://sandbox-gateway.qq.example/ws" });
      }
      return jsonResponse({ message: "unexpected request" }, 404);
    }) as unknown as typeof fetch;

    const adapter = new QQBotChannelAdapter(cfg, {
      fetchImpl,
      WebSocketCtor: FakeQQSocket,
      reconnectDelay: () => 1_000_000,
      startupTimeoutMs: 2_000,
      onHeartbeatInterval: () => {},
    });

    const startPromise = adapter.start(() => {});
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    // Hello without heartbeat_interval falls back to the default interval.
    sockets[0].emit("message", { data: JSON.stringify({ op: 10, d: {} }) });
    await startPromise;

    expect(calls).toContain("https://sandbox.api.sgroup.qq.com/gateway");
    expect(sockets[0].url).toBe("wss://sandbox-gateway.qq.example/ws");
    await adapter.stop();
  });

  it("rejects passive sends without a prior msg_id and unsupported outbound attachments", async () => {
    const dir = await makeTempDir();
    const cfg = makeConfig(dir, {
      qqbot: {
        appId: "102030405",
        clientSecret: "qqbot-test-client-secret",
        sandbox: false,
        allowedUsers: new Set(),
      },
    });
    const fetchImpl = vi.fn(async () => jsonResponse({ access_token: "unused", expires_in: 7200 }));
    const adapter = new QQBotChannelAdapter(cfg, { fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(
      adapter.sendMessage({ chatId: "c2c:never-seen", text: "proactive is not supported" }),
    ).rejects.toThrow(/passive reply requires/i);
    await expect(
      adapter.sendMessage({
        chatId: "c2c:u_openid_1",
        text: "with media",
        attachments: [{ buffer: Buffer.from("x"), name: "x.png", mimeType: "image/png" }],
      }),
    ).rejects.toThrow(/attachments/i);
    await expect(adapter.sendMessage({ chatId: "unknown:1234", text: "bad prefix" })).rejects.toThrow(
      /must start with c2c:, group:, or channel:/i,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});