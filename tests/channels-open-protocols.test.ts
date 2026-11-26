import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GatewayConfig } from "../src/config.js";
import { MatrixChannelAdapter, createAdapter as createMatrixAdapter } from "../src/channels/matrix.js";
import {
  MattermostChannelAdapter,
  createAdapter as createMattermostAdapter,
  type MattermostWebSocketCtor,
} from "../src/channels/mattermost.js";
import type { InboundMessage } from "../src/types.js";

const HOMESERVER = "https://matrix.example.org";
const MM_BASE = "http://localhost:8065";

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

function binary(data: Buffer | string, headers: Record<string, string> = {}): Response {
  return new Response(typeof data === "string" ? data : new Uint8Array(data), {
    status: 200,
    headers,
  });
}

function pendingSync(init?: RequestInit): Promise<Response> {
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

function bearer(init?: RequestInit): string | undefined {
  const headers = init?.headers as Record<string, string> | undefined;
  return headers?.Authorization ?? headers?.authorization;
}

function bodyJson(init?: RequestInit): Record<string, unknown> {
  return JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
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
    logLevel: "info",
    ...overrides,
  };
}

function matrixConfig(userId?: string): GatewayConfig {
  return makeConfig({
    matrix: {
      homeserverUrl: HOMESERVER,
      accessToken: "test-access-token",
      userId,
      allowedUsers: new Set<string>(),
    },
  });
}

function mattermostConfig(): GatewayConfig {
  return makeConfig({
    mattermost: {
      baseUrl: MM_BASE,
      botToken: "test-bot-token",
      allowedUsers: new Set<string>(),
    },
  });
}

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "channels-open-"));
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

describe("adapter factories", () => {
  it("exposes createAdapter factories with stable channel names", () => {
    expect(createMatrixAdapter(matrixConfig("@bot:example.org")).name).toBe("matrix");
    expect(createMattermostAdapter(mattermostConfig()).name).toBe("mattermost");
  });
});

describe("MatrixChannelAdapter", () => {
  it("resolves the identity via whoami only when userId is not configured", async () => {
    const { impl, calls } = createFetch((url, init) => {
      if (url === `${HOMESERVER}/_matrix/client/v3/account/whoami`) {
        return json({ user_id: "@bot:example.org" });
      }
      if (url.includes("/account_data/m.direct")) {
        return json({ "@alice:example.org": ["!dm:example.org"] });
      }
      if (url.includes("/_matrix/client/v3/sync")) {
        return pendingSync(init);
      }
      throw new Error(`Unexpected request ${url}`);
    });

    const adapter = new MatrixChannelAdapter(matrixConfig(), { fetchImpl: impl });
    running.push(adapter);
    await adapter.start(() => undefined);

    expect(calls[0]?.url).toBe(`${HOMESERVER}/_matrix/client/v3/account/whoami`);
    expect(bearer(calls[0]?.init)).toBe("Bearer test-access-token");
    expect(calls[1]?.url).toBe(
      `${HOMESERVER}/_matrix/client/v3/user/%40bot%3Aexample.org/account_data/m.direct`,
    );
    await waitFor(() => expect(calls.some((call) => call.url.includes("/sync"))).toBe(true));
  });

  it("skips the initial backlog and emits live events with dedupe, self-filter, and mentions", async () => {
    const backlog = {
      type: "m.room.message",
      event_id: "$old",
      sender: "@alice:example.org",
      origin_server_ts: 1,
      content: { msgtype: "m.text", body: "old backlog" },
    };
    const mentioned = {
      type: "m.room.message",
      event_id: "$live1",
      sender: "@alice:example.org",
      origin_server_ts: 100,
      content: { msgtype: "m.text", body: "@bot status?" },
    };
    const plain = {
      type: "m.room.message",
      event_id: "$live2",
      sender: "@carol:example.org",
      origin_server_ts: 101,
      content: { msgtype: "m.text", body: "no mention here" },
    };
    const own = {
      type: "m.room.message",
      event_id: "$own",
      sender: "@bot:example.org",
      origin_server_ts: 102,
      content: { msgtype: "m.text", body: "own echo" },
    };

    let syncCount = 0;
    const { impl, calls } = createFetch((url, init) => {
      if (url.includes("/account_data/m.direct")) {
        return json({});
      }
      if (url.includes("/_matrix/client/v3/sync")) {
        syncCount += 1;
        const parsed = new URL(url);
        if (!parsed.searchParams.get("since")) {
          return json({
            next_batch: "s1",
            rooms: {
              join: {
                "!room:example.org": {
                  summary: { "m.joined_member_count": 4 },
                  timeline: { events: [backlog] },
                },
              },
            },
          });
        }
        if (parsed.searchParams.get("since") === "s1" && syncCount === 2) {
          return json({
            next_batch: "s2",
            rooms: {
              join: {
                "!room:example.org": {
                  summary: { "m.joined_member_count": 4 },
                  timeline: { events: [mentioned, plain, mentioned, own] },
                },
              },
            },
          });
        }
        return pendingSync(init);
      }
      throw new Error(`Unexpected request ${url}`);
    });

    const adapter = new MatrixChannelAdapter(matrixConfig("@bot:example.org"), { fetchImpl: impl });
    running.push(adapter);
    const messages: InboundMessage[] = [];
    await adapter.start((msg) => {
      messages.push(msg);
    });

    await waitFor(() => expect(messages).toHaveLength(2));
    expect(messages[0]).toMatchObject({
      id: "$live1",
      channel: "matrix",
      chatId: "!room:example.org",
      senderId: "@alice:example.org",
      rawSenderId: "@alice:example.org",
      isGroup: true,
      text: "@bot status?",
      mentionsBot: true,
      timestamp: 100,
    });
    expect(messages[1]).toMatchObject({ id: "$live2", isGroup: true, mentionsBot: false });

    await delay(30);
    expect(messages).toHaveLength(2);

    const syncUrls = calls.filter((call) => call.url.includes("/sync")).map((call) => new URL(call.url));
    expect(syncUrls[0]?.searchParams.get("timeout")).toBe("30000");
    expect(syncUrls[0]?.searchParams.get("since")).toBeNull();
    expect(syncUrls[1]?.searchParams.get("since")).toBe("s1");
  });

  it("classifies DMs from m.direct rooms and joined member counts", async () => {
    const event = (id: string, body: string) => ({
      type: "m.room.message",
      event_id: id,
      sender: "@alice:example.org",
      origin_server_ts: 200,
      content: { msgtype: "m.text", body },
    });

    let syncCount = 0;
    const { impl } = createFetch((url, init) => {
      if (url.includes("/account_data/m.direct")) {
        return json({ "@bot:example.org": ["!dm:example.org"] });
      }
      if (url.includes("/_matrix/client/v3/sync")) {
        syncCount += 1;
        if (!new URL(url).searchParams.get("since")) {
          return json({ next_batch: "a" });
        }
        if (syncCount === 2) {
          return json({
            next_batch: "b",
            rooms: {
              join: {
                "!dm:example.org": {
                  summary: { "m.joined_member_count": 9 },
                  timeline: { events: [event("$dm", "hello dm")] },
                },
                "!pair:example.org": {
                  summary: { "m.joined_member_count": 2 },
                  timeline: { events: [event("$pair", "hello pair")] },
                },
                "!group:example.org": {
                  summary: { "m.joined_member_count": 3 },
                  timeline: { events: [event("$group", "hello group")] },
                },
              },
            },
          });
        }
        return pendingSync(init);
      }
      throw new Error(`Unexpected request ${url}`);
    });

    const adapter = new MatrixChannelAdapter(matrixConfig("@bot:example.org"), { fetchImpl: impl });
    running.push(adapter);
    const messages: InboundMessage[] = [];
    await adapter.start((msg) => {
      messages.push(msg);
    });

    await waitFor(() => expect(messages).toHaveLength(3));
    const byChat = new Map(messages.map((msg) => [msg.chatId, msg]));
    expect(byChat.get("!dm:example.org")?.isGroup).toBe(false);
    expect(byChat.get("!pair:example.org")?.isGroup).toBe(false);
    expect(byChat.get("!group:example.org")?.isGroup).toBe(true);
  });

  it("downloads mxc media through the v1 endpoint with a v3 fallback", async () => {
    const mediaEvent = {
      type: "m.room.message",
      event_id: "$media",
      sender: "@alice:example.org",
      origin_server_ts: 300,
      content: {
        msgtype: "m.image",
        body: "cat.png",
        filename: "cat.png",
        url: "mxc://example.org/media123",
        info: { mimetype: "image/png", size: 9 },
      },
    };
    const fileBytes = Buffer.from("png-bytes");

    let syncCount = 0;
    const { impl, calls } = createFetch((url, init) => {
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
                  summary: { "m.joined_member_count": 4 },
                  timeline: { events: [mediaEvent] },
                },
              },
            },
          });
        }
        return pendingSync(init);
      }
      if (url.includes("/_matrix/client/v1/media/download/example.org/media123")) {
        return json({ errcode: "M_NOT_FOUND" }, 404);
      }
      if (url.includes("/_matrix/media/v3/download/example.org/media123")) {
        return binary(fileBytes, { "content-type": "image/png" });
      }
      throw new Error(`Unexpected request ${url}`);
    });

    const adapter = new MatrixChannelAdapter(matrixConfig("@bot:example.org"), { fetchImpl: impl });
    running.push(adapter);
    const messages: InboundMessage[] = [];
    await adapter.start((msg) => {
      messages.push(msg);
    });

    await waitFor(() => expect(messages).toHaveLength(1));
    const attachment = messages[0]?.attachments[0];
    expect(attachment).toMatchObject({
      type: "image",
      mimeType: "image/png",
      name: "cat.png",
      sizeBytes: 9,
      url: "mxc://example.org/media123",
    });
    expect(attachment?.localPath).toBeDefined();
    expect(await readFile(attachment?.localPath ?? "", "utf8")).toBe("png-bytes");

    const mediaUrls = calls
      .map((call) => call.url)
      .filter((url) => url.includes("download/example.org/media123"));
    expect(mediaUrls).toHaveLength(2);
    expect(mediaUrls[0]).toContain("/_matrix/client/v1/media/download/example.org/media123");
    expect(mediaUrls[1]).toContain("/_matrix/media/v3/download/example.org/media123");
    expect(bearer(calls.find((call) => call.url.includes("/media/download/"))?.init)).toBe(
      "Bearer test-access-token",
    );
  });

  it("chunks outbound text, sends typing state, and reacts", async () => {
    const sentEvents: { url: string; body: Record<string, unknown> }[] = [];
    const { impl, calls } = createFetch((url, init) => {
      if (url.includes("/account_data/m.direct")) {
        return json({});
      }
      if (url.includes("/_matrix/client/v3/sync")) {
        return pendingSync(init);
      }
      if (url.includes("/send/")) {
        sentEvents.push({ url, body: bodyJson(init) });
        return json({ event_id: `$evt${sentEvents.length}` });
      }
      if (url.includes("/typing/")) {
        return json({});
      }
      throw new Error(`Unexpected request ${url}`);
    });

    const adapter = new MatrixChannelAdapter(matrixConfig("@bot:example.org"), { fetchImpl: impl });
    running.push(adapter);
    await adapter.start(() => undefined);

    const result = await adapter.sendMessage({
      chatId: "!room:example.org",
      text: "A".repeat(5000),
      replyToMessageId: "$parent",
    });
    expect(result).toEqual({ messageId: "$evt2" });
    expect(sentEvents).toHaveLength(2);
    expect(sentEvents[0]?.body).toMatchObject({ msgtype: "m.text", body: "A".repeat(4000) });
    expect(sentEvents[1]?.body).toMatchObject({ msgtype: "m.text", body: "A".repeat(1000) });
    expect(sentEvents[0]?.body["m.relates_to"]).toEqual({
      "m.in_reply_to": { event_id: "$parent" },
    });
    expect(decodeURIComponent(sentEvents[0]?.url ?? "")).toContain(
      "/rooms/!room:example.org/send/m.room.message/",
    );

    await adapter.sendTyping("!room:example.org", true);
    const typingCall = calls.find((call) => call.url.includes("/typing/"));
    expect(typingCall).toBeDefined();
    expect(decodeURIComponent(typingCall?.url ?? "")).toContain(
      "/rooms/!room:example.org/typing/@bot:example.org",
    );
    expect(bodyJson(typingCall?.init)).toEqual({ typing: true, timeout: 30_000 });

    await adapter.react("!room:example.org", "$live1", "👍");
    const reaction = sentEvents.at(-1);
    expect(decodeURIComponent(reaction?.url ?? "")).toContain("/send/m.reaction/");
    expect(reaction?.body).toEqual({
      "m.relates_to": { rel_type: "m.annotation", event_id: "$live1", key: "👍" },
    });
  });

  it("uploads attachments before referencing them in a message event", async () => {
    const sentEvents: Record<string, unknown>[] = [];
    let uploaded: Buffer | undefined;
    const { impl } = createFetch((url, init) => {
      if (url.includes("/account_data/m.direct")) {
        return json({});
      }
      if (url.includes("/_matrix/client/v3/sync")) {
        return pendingSync(init);
      }
      if (url.includes("/_matrix/media/v3/upload")) {
        uploaded = Buffer.from(init?.body as Uint8Array);
        return json({ content_uri: "mxc://example.org/uploaded" });
      }
      if (url.includes("/send/")) {
        sentEvents.push(bodyJson(init));
        return json({ event_id: `$up${sentEvents.length}` });
      }
      throw new Error(`Unexpected request ${url}`);
    });

    const adapter = new MatrixChannelAdapter(matrixConfig("@bot:example.org"), { fetchImpl: impl });
    running.push(adapter);
    await adapter.start(() => undefined);

    const result = await adapter.sendMessage({
      chatId: "!room:example.org",
      attachments: [
        { buffer: Buffer.from("image-bytes"), name: "pic.png", mimeType: "image/png" },
      ],
    });

    expect(result).toEqual({ messageId: "$up1" });
    expect(uploaded?.toString()).toBe("image-bytes");
    expect(sentEvents[0]).toMatchObject({
      msgtype: "m.image",
      body: "pic.png",
      url: "mxc://example.org/uploaded",
      info: { mimetype: "image/png", size: 11 },
    });
  });
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

async function startMattermost(
  impl: typeof fetch,
  messages: InboundMessage[],
): Promise<{ adapter: MattermostChannelAdapter; socket: FakeWebSocket }> {
  const adapter = new MattermostChannelAdapter(mattermostConfig(), {
    fetchImpl: impl,
    WebSocketCtor: FakeWebSocket as unknown as MattermostWebSocketCtor,
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
  await waitFor(() => expect(socket.sent.length).toBe(1));
  return { adapter, socket };
}

describe("MattermostChannelAdapter", () => {
  it("authenticates the websocket after the users/me lookup", async () => {
    const { impl, calls } = createFetch((url) => {
      if (url === `${MM_BASE}/api/v4/users/me`) {
        return json({ id: "bot123", username: "gateway-bot" });
      }
      throw new Error(`Unexpected request ${url}`);
    });

    const messages: InboundMessage[] = [];
    const { adapter, socket } = await startMattermost(impl, messages);

    expect(calls.filter((call) => call.url === `${MM_BASE}/api/v4/users/me`)).toHaveLength(1);
    expect(bearer(calls[0]?.init)).toBe("Bearer test-bot-token");
    expect(socket.url).toBe("ws://localhost:8065/api/v4/websocket");
    expect(socket.sent[0]).toBe(
      JSON.stringify({
        seq: 1,
        action: "authentication_challenge",
        data: { token: "test-bot-token" },
      }),
    );
    expect(adapter.isConnected()).toBe(true);
  });

  it("emits direct messages once, ignoring duplicates and self posts", async () => {
    const { impl } = createFetch((url) => {
      if (url === `${MM_BASE}/api/v4/users/me`) {
        return json({ id: "bot123", username: "gateway-bot" });
      }
      throw new Error(`Unexpected request ${url}`);
    });

    const messages: InboundMessage[] = [];
    const { socket } = await startMattermost(impl, messages);

    const post = {
      id: "post1",
      channel_id: "chan1",
      user_id: "user1",
      message: "hello there",
      create_at: 1000,
    };
    socket.deliver({ event: "posted", data: { channel_type: "D", post: JSON.stringify(post) } });
    await waitFor(() => expect(messages).toHaveLength(1));
    expect(messages[0]).toMatchObject({
      id: "post1",
      channel: "mattermost",
      chatId: "chan1",
      senderId: "user1",
      rawSenderId: "user1",
      isGroup: false,
      text: "hello there",
      mentionsBot: false,
      timestamp: 1000,
    });

    socket.deliver({ event: "posted", data: { channel_type: "D", post: JSON.stringify(post) } });
    socket.deliver({
      event: "posted",
      data: {
        channel_type: "D",
        post: JSON.stringify({
          id: "post2",
          channel_id: "chan1",
          user_id: "bot123",
          message: "self echo",
        }),
      },
    });
    await delay(30);
    expect(messages).toHaveLength(1);
  });

  it("flags group mentions by bot username and configured patterns", async () => {
    const { impl } = createFetch((url) => {
      if (url === `${MM_BASE}/api/v4/users/me`) {
        return json({ id: "bot123", username: "gateway-bot" });
      }
      throw new Error(`Unexpected request ${url}`);
    });

    const messages: InboundMessage[] = [];
    const { socket } = await startMattermost(impl, messages);
    const post = (id: string, message: string) => ({
      id,
      channel_id: "town",
      user_id: "user2",
      message,
      create_at: 2000,
    });

    socket.deliver({
      event: "posted",
      data: { channel_type: "O", post: JSON.stringify(post("post3", "@gateway-bot status")) },
    });
    await waitFor(() => expect(messages).toHaveLength(1));
    expect(messages[0]).toMatchObject({ isGroup: true, mentionsBot: true });

    socket.deliver({
      event: "posted",
      data: { channel_type: "O", post: JSON.stringify(post("post4", "ping @agy")) },
    });
    await waitFor(() => expect(messages).toHaveLength(2));
    expect(messages[1]).toMatchObject({ isGroup: true, mentionsBot: true });

    socket.deliver({
      event: "posted",
      data: { channel_type: "O", post: JSON.stringify(post("post5", "just chatting")) },
    });
    await waitFor(() => expect(messages).toHaveLength(3));
    expect(messages[2]).toMatchObject({ isGroup: true, mentionsBot: false });
  });

  it("downloads attachments and preserves thread roots", async () => {
    const fileBytes = Buffer.from("file-content");
    const { impl, calls } = createFetch((url) => {
      if (url === `${MM_BASE}/api/v4/users/me`) {
        return json({ id: "bot123", username: "gateway-bot" });
      }
      if (url === `${MM_BASE}/api/v4/files/file1`) {
        return binary(fileBytes, {
          "content-type": "text/plain",
          "content-disposition": 'attachment; filename="notes.txt"',
        });
      }
      throw new Error(`Unexpected request ${url}`);
    });

    const messages: InboundMessage[] = [];
    const { socket } = await startMattermost(impl, messages);

    socket.deliver({
      event: "posted",
      data: {
        channel_type: "O",
        post: JSON.stringify({
          id: "post6",
          channel_id: "chan2",
          user_id: "user3",
          message: "see attached",
          root_id: "root1",
          file_ids: ["file1"],
          create_at: 3000,
        }),
      },
    });

    await waitFor(() => expect(messages).toHaveLength(1));
    const msg = messages[0];
    expect(msg?.replyToMessageId).toBe("root1");
    expect(msg?.attachments).toHaveLength(1);
    const attachment = msg?.attachments[0];
    expect(attachment).toMatchObject({
      type: "file",
      name: "notes.txt",
      sizeBytes: fileBytes.byteLength,
    });
    expect(attachment?.mimeType).toContain("text/plain");
    expect(attachment?.localPath).toBeDefined();
    expect(await readFile(attachment?.localPath ?? "", "utf8")).toBe("file-content");

    const fileCall = calls.find((call) => call.url === `${MM_BASE}/api/v4/files/file1`);
    expect(bearer(fileCall?.init)).toBe("Bearer test-bot-token");
  });

  it("posts chunked messages, uploads files, types, and reacts", async () => {
    const postBodies: Record<string, unknown>[] = [];
    const typingBodies: Record<string, unknown>[] = [];
    const reactionBodies: Record<string, unknown>[] = [];
    let uploadForm: FormData | undefined;

    const { impl } = createFetch((url, init) => {
      if (url === `${MM_BASE}/api/v4/users/me`) {
        return json({ id: "bot123", username: "gateway-bot" });
      }
      if (url === `${MM_BASE}/api/v4/posts` && init?.method === "POST") {
        postBodies.push(bodyJson(init));
        return json({ id: `created-${postBodies.length}` });
      }
      if (url === `${MM_BASE}/api/v4/users/me/typing`) {
        typingBodies.push(bodyJson(init));
        return json({});
      }
      if (url === `${MM_BASE}/api/v4/reactions`) {
        reactionBodies.push(bodyJson(init));
        return json({});
      }
      if (url === `${MM_BASE}/api/v4/files` && init?.method === "POST") {
        uploadForm = init.body as FormData;
        return json({ file_infos: [{ id: "uploaded-file" }] });
      }
      throw new Error(`Unexpected request ${url}`);
    });

    const messages: InboundMessage[] = [];
    const { adapter } = await startMattermost(impl, messages);

    const result = await adapter.sendMessage({
      chatId: "chan3",
      text: "B".repeat(16_000),
      replyToMessageId: "root9",
    });
    expect(result).toEqual({ messageId: "created-2" });
    expect(postBodies).toHaveLength(2);
    expect(postBodies[0]).toMatchObject({
      channel_id: "chan3",
      message: "B".repeat(15_000),
      root_id: "root9",
    });
    expect(postBodies[1]).toMatchObject({
      channel_id: "chan3",
      message: "B".repeat(1_000),
      root_id: "root9",
    });

    await adapter.sendTyping("chan3", true);
    expect(typingBodies).toEqual([{ channel_id: "chan3" }]);
    await adapter.sendTyping("chan3", false);
    expect(typingBodies).toHaveLength(1);

    await adapter.react("chan3", "post9", ":thumbsup:");
    expect(reactionBodies).toEqual([
      { user_id: "bot123", post_id: "post9", emoji_name: "thumbsup" },
    ]);

    const uploadResult = await adapter.sendMessage({
      chatId: "chan3",
      attachments: [{ buffer: Buffer.from("hello-file"), name: "hello.txt", mimeType: "text/plain" }],
    });
    expect(uploadResult).toEqual({ messageId: "created-3" });
    expect(uploadForm?.get("channel_id")).toBe("chan3");
    expect(postBodies.at(-1)).toMatchObject({
      channel_id: "chan3",
      message: "",
      file_ids: ["uploaded-file"],
    });
  });
});