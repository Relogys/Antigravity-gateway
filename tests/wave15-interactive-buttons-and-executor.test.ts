import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PermissionManager } from "../src/acp/permissions.js";
import { DiscordChannelAdapter, type DiscordClientLike } from "../src/channels/discord.js";
import { TelegramChannelAdapter } from "../src/channels/telegram.js";
import { actionCallbackToCommand } from "../src/channels/utils.js";
import { loadConfig } from "../src/config.js";
import { GatewayRouter, type ExtendedAgentBackend } from "../src/gateway/router.js";
import { LoopScheduler } from "../src/gateway/scheduler.js";
import { GatewayStore } from "../src/gateway/store.js";
import type {
  AgentTurnResult,
  ChannelAdapter,
  InboundMessage,
  OutboundMessage,
  PendingPermission,
} from "../src/types.js";

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-w15-btn-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("Wave 15 native interactive approval buttons (Telegram & Discord)", () => {
  it("maps permission callback IDs cleanly and rejects unknown actions", () => {
    expect(actionCallbackToCommand("perm:once")).toBe("/approve once");
    expect(actionCallbackToCommand("perm:session")).toBe("/approve session");
    expect(actionCallbackToCommand("perm:always")).toBe("/approve always");
    expect(actionCallbackToCommand("perm:deny")).toBe("/deny");
    expect(actionCallbackToCommand("  PERM:ONCE ")).toBe("/approve once");
    expect(actionCallbackToCommand("evil:command")).toBeUndefined();
    expect(actionCallbackToCommand("")).toBeUndefined();
  });

  it("Telegram sends 2-column inline_keyboard and routes callback_query taps with deduplication", async () => {
    const dir = createTempDir();
    const cfg = loadConfig(
      {
        TELEGRAM_BOT_TOKEN: "123456:test-telegram-token",
        TELEGRAM_POLL_TIMEOUT_SEC: "0",
        DATA_DIR: dir,
      },
      { loadDotenv: false },
    );

    const apiCalls: Array<{ method: string; body: Record<string, unknown> }> = [];
    let pollCount = 0;

    const adapter = new TelegramChannelAdapter(cfg, {
      backoffMs: () => 5,
      fetchImpl: async (url, init) => {
        const method = url.split("/").pop() ?? "";
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        apiCalls.push({ method, body });

        if (method === "getMe") {
          return new Response(JSON.stringify({ ok: true, result: { id: 99, username: "agy_bot" } }));
        }
        if (method === "sendMessage") {
          return new Response(JSON.stringify({ ok: true, result: { message_id: 501 } }));
        }
        if (method === "answerCallbackQuery") {
          return new Response(JSON.stringify({ ok: true, result: true }));
        }
        if (method === "getUpdates") {
          pollCount += 1;
          if (pollCount === 1) {
            return new Response(
              JSON.stringify({
                ok: true,
                result: [
                  {
                    update_id: 1001,
                    callback_query: {
                      id: "cb-77",
                      from: { id: 42, is_bot: false },
                      data: "perm:once",
                      message: {
                        message_id: 501,
                        chat: { id: -100999, type: "supergroup" },
                      },
                    },
                  },
                  // Duplicate callback id must be ignored
                  {
                    update_id: 1002,
                    callback_query: {
                      id: "cb-77",
                      from: { id: 42, is_bot: false },
                      data: "perm:once",
                      message: {
                        message_id: 501,
                        chat: { id: -100999, type: "supergroup" },
                      },
                    },
                  },
                ],
              }),
            );
          }
          await new Promise((r) => setTimeout(r, 40));
          return new Response(JSON.stringify({ ok: true, result: [] }));
        }
        return new Response(JSON.stringify({ ok: true, result: true }));
      },
    });

    const received: InboundMessage[] = [];
    await adapter.start((msg) => {
      received.push(msg);
    });

    await adapter.sendMessage({
      chatId: "-100999",
      text: "Approve tool?",
      markdown: true,
      actions: [
        { id: "perm:once", label: "✅ Allow Once", style: "primary" },
        { id: "perm:session", label: "🔓 Allow Session", style: "secondary" },
        { id: "perm:always", label: "⭐ Always", style: "secondary" },
        { id: "perm:deny", label: "🛑 Deny", style: "danger" },
      ],
    });

    await vi.waitFor(() => expect(received.length).toBe(1), { timeout: 2000 });
    await adapter.stop();

    const sendCall = apiCalls.find((c) => c.method === "sendMessage");
    const markup = sendCall?.body.reply_markup as {
      inline_keyboard?: Array<Array<{ text: string; callback_data: string }>>;
    };
    expect(markup?.inline_keyboard).toHaveLength(2);
    expect(markup?.inline_keyboard?.[0]).toEqual([
      { text: "✅ Allow Once", callback_data: "perm:once" },
      { text: "🔓 Allow Session", callback_data: "perm:session" },
    ]);
    expect(markup?.inline_keyboard?.[1]).toEqual([
      { text: "⭐ Always", callback_data: "perm:always" },
      { text: "🛑 Deny", callback_data: "perm:deny" },
    ]);

    const getUpdatesCall = apiCalls.find((c) => c.method === "getUpdates");
    expect(getUpdatesCall?.body.allowed_updates).toEqual(["message", "callback_query"]);

    const answerCall = apiCalls.find((c) => c.method === "answerCallbackQuery");
    expect(answerCall?.body.callback_query_id).toBe("cb-77");

    expect(received[0]).toMatchObject({
      channel: "telegram",
      chatId: "-100999",
      senderId: "42",
      isGroup: true,
      mentionsBot: true,
      text: "/approve once",
    });
  });

  it("Discord sends ActionRow button components and routes interactionCreate clicks cleanly", async () => {
    const dir = createTempDir();
    const cfg = loadConfig(
      {
        DISCORD_BOT_TOKEN: "discord-test-token",
        DATA_DIR: dir,
      },
      { loadDotenv: false },
    );

    const emitter = new EventEmitter();
    const sentPayloads: Array<Record<string, unknown>> = [];
    const fakeClient: DiscordClientLike = {
      user: { id: "bot-1" },
      channels: {
        fetch: async () => ({
          send: async (payload: Record<string, unknown>) => {
            sentPayloads.push(payload);
            return { id: "msg-99" };
          },
        }),
      },
      on: (ev, fn) => emitter.on(ev, fn),
      once: (ev, fn) => emitter.once(ev, fn),
      login: async () => "ok",
      destroy: async () => {},
      isReady: () => true,
    };

    const adapter = new DiscordChannelAdapter(cfg, {
      clientFactory: () => fakeClient,
    });

    const received: InboundMessage[] = [];
    await adapter.start((msg) => {
      received.push(msg);
    });

    await adapter.sendMessage({
      chatId: "chan-1",
      text: "Approve tool?",
      actions: [
        { id: "perm:once", label: "✅ Allow Once", style: "primary" },
        { id: "perm:deny", label: "🛑 Deny", style: "danger" },
      ],
    });

    const deferred = vi.fn(async () => {});
    emitter.emit("interactionCreate", {
      id: "int-100",
      isButton: () => true,
      customId: "perm:deny",
      channelId: "chan-1",
      guildId: "guild-1",
      user: { id: "user-55", bot: false },
      message: { id: "msg-99" },
      deferUpdate: deferred,
    });
    // Duplicate interaction id must be ignored
    emitter.emit("interactionCreate", {
      id: "int-100",
      isButton: () => true,
      customId: "perm:deny",
      channelId: "chan-1",
      guildId: "guild-1",
      user: { id: "user-55", bot: false },
      deferUpdate: deferred,
    });

    await vi.waitFor(() => expect(received.length).toBe(1), { timeout: 2000 });
    await adapter.stop();

    expect(sentPayloads[0]?.components).toEqual([
      {
        type: 1,
        components: [
          { type: 2, custom_id: "perm:once", label: "✅ Allow Once", style: 1 },
          { type: 2, custom_id: "perm:deny", label: "🛑 Deny", style: 4 },
        ],
      },
    ]);
    expect(deferred).toHaveBeenCalledTimes(1);
    expect(received[0]).toMatchObject({
      channel: "discord",
      chatId: "chan-1",
      senderId: "user-55",
      isGroup: true,
      mentionsBot: true,
      text: "/deny",
    });
  });

  it("enforces requester-bound group approval when permission buttons are clicked", async () => {
    const dir = createTempDir();
    const sent: OutboundMessage[] = [];
    const channel: ChannelAdapter = {
      name: "telegram",
      start: async () => {},
      stop: async () => {},
      isConnected: () => true,
      sendMessage: async (m) => {
        sent.push(m);
        return { messageId: `m-${sent.length}` };
      },
    };

    const broker = new PermissionManager();
    const backend: ExtendedAgentBackend = {
      stop: async () => {},
      sendTurn: async (): Promise<AgentTurnResult> => ({
        sessionId: "s-1",
        text: "done",
        stopReason: "end_turn",
      }),
      cancelTurn: async () => false,
      resetSession: async () => {},
      listSessions: async () => [],
      getPendingPermission: (chatId) => broker.getPending(chatId),
      resolvePermissionWithResult: (chatId, decision, actor) =>
        broker.resolveWithResult(chatId, decision, actor),
    };

    const config = loadConfig(
      {
        TELEGRAM_BOT_TOKEN: "123456:test-token",
        TELEGRAM_ALLOWED_USERS: "alice,bob",
        ALLOW_GROUPS: "true",
        DEFAULT_CWD: dir,
        DATA_DIR: path.join(dir, "data"),
      },
      { loadDotenv: false },
    );

    const store = new GatewayStore(config.dataDir);
    await store.load();
    const scheduler = new LoopScheduler({ store, channel });
    const router = new GatewayRouter({
      config,
      channel,
      backend,
      store,
      scheduler,
      quotaFetcher: async () => ({ available: false, fetchedAt: Date.now(), groups: [] }),
    });

    const permPromise = broker.handlePermissionRequest(
      "telegram::-100",
      "interactive",
      {
        sessionId: "s-1",
        toolCallId: "tc-1",
        title: "Run deploy script",
        kind: "execute",
        requesterSenderId: "telegram:alice",
        options: [
          { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
          { optionId: "deny", name: "Reject", kind: "reject_once" },
        ],
      },
      (perm: PendingPermission) => router.notifyPermission("telegram::-100", perm),
    );

    await vi.waitFor(() => expect(sent.length).toBe(1), { timeout: 2000 });
    expect(sent[0]?.actions?.map((a) => a.id)).toEqual([
      "perm:once",
      "perm:session",
      "perm:always",
      "perm:deny",
    ]);

    // Bystander Bob clicks the Allow Once button in the group -> MUST BE REJECTED
    await router.handleInbound({
      id: "cb:bob-1",
      channel: "telegram",
      chatId: "telegram::-100",
      senderId: "bob",
      isGroup: true,
      mentionsBot: true,
      text: "/approve once",
      attachments: [],
      timestamp: Date.now(),
    });
    expect(broker.getPending("telegram::-100")).toBeDefined();
    expect(sent.at(-1)?.text).toMatch(/requester|admin/i);

    // Original requester Alice clicks Allow Once -> RESOLVED!
    await router.handleInbound({
      id: "cb:alice-1",
      channel: "telegram",
      chatId: "telegram::-100",
      senderId: "alice",
      isGroup: true,
      mentionsBot: true,
      text: "/approve once",
      attachments: [],
      timestamp: Date.now(),
    });
    expect(await permPromise).toBe("allow-once");
    router.stop();
  });
});
