import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgyAgentBackend, type AgyAcpClientLike } from "../src/acp/sessions.js";
import { loadConfig, parseWorkspaceAliases, type GatewayConfig } from "../src/config.js";
import { GatewayRouter } from "../src/gateway/router.js";
import {
  LoopScheduler,
  computeNextCronTimestamp,
  parseScheduleSpec,
} from "../src/gateway/scheduler.js";
import { GatewayStore } from "../src/gateway/store.js";
import type {
  AgentBackend,
  AgentTurnInput,
  AgentTurnResult,
  ChannelAdapter,
  InboundMessage,
  OutboundMessage,
} from "../src/types.js";

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-w13-cron-"));
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

describe("Wave 13 full 5-field cron scheduler", () => {
  it("computes next timestamps for daily HH:MM, stepped intervals, weekday ranges, lists, and Sunday 0/7", () => {
    // 2026-11-26 is Thursday; use local time constructor to match Date.getHours/getDay
    const thuMorning = new Date(2026, 10, 26, 8, 50, 0, 0).getTime();

    // Daily HH:MM
    const daily = computeNextCronTimestamp("09:00", thuMorning);
    expect(daily).toBe(new Date(2026, 10, 26, 9, 0, 0, 0).getTime());

    // Stepped minutes (*/15)
    const stepped = computeNextCronTimestamp("*/15 * * * *", thuMorning);
    expect(stepped).toBe(new Date(2026, 10, 26, 9, 0, 0, 0).getTime());

    // Weekday range (1-5) starting Friday evening skips Saturday & Sunday to Monday 09:00
    const friEvening = new Date(2026, 10, 27, 18, 0, 0, 0).getTime();
    const nextWeekday = computeNextCronTimestamp("0 9 * * 1-5", friEvening);
    expect(nextWeekday).toBe(new Date(2026, 10, 30, 9, 0, 0, 0).getTime());

    // Sunday accepts both 0 and 7
    const sun0 = computeNextCronTimestamp("30 10 * * 0", friEvening);
    const sun7 = computeNextCronTimestamp("30 10 * * 7", friEvening);
    expect(sun0).toBe(new Date(2026, 10, 29, 10, 30, 0, 0).getTime());
    expect(sun7).toBe(sun0);

    // Comma list of hours
    const listHours = computeNextCronTimestamp("0 9,18 * * *", thuMorning);
    expect(listHours).toBe(new Date(2026, 10, 26, 9, 0, 0, 0).getTime());

    // Invalid cron expressions return null
    expect(computeNextCronTimestamp("60 9 * * *", thuMorning)).toBeNull();
    expect(computeNextCronTimestamp("0 25 * * *", thuMorning)).toBeNull();
    expect(computeNextCronTimestamp("0 9 * *", thuMorning)).toBeNull();
    expect(computeNextCronTimestamp("*/0 * * * *", thuMorning)).toBeNull();
  });

  it("parses daily and 5-field cron schedule specs (quoted and unquoted)", () => {
    const daily = parseScheduleSpec("daily 09:00 morning digest");
    expect(daily).toEqual({
      kind: "loop",
      cron: "09:00",
      prompt: "morning digest",
      oneShot: false,
    });

    const quoted = parseScheduleSpec('cron "0 9 * * 1-5" weekday standup');
    expect(quoted).toEqual({
      kind: "loop",
      cron: "0 9 * * 1-5",
      prompt: "weekday standup",
      oneShot: false,
    });

    const unquoted = parseScheduleSpec("cron */30 * * * * check build queue");
    expect(unquoted).toEqual({
      kind: "loop",
      cron: "*/30 * * * *",
      prompt: "check build queue",
      oneShot: false,
    });

    expect(parseScheduleSpec('cron "99 9 * * *" bad')).toBeNull();
  });
});

describe("Wave 13 workspace bookmarks & isolated cron sessions", () => {
  function makeRouterEnv(baseDir: string, extraEnv: Record<string, string> = {}) {
    const sent: OutboundMessage[] = [];
    let typingCalls = 0;
    let typingOffCalls = 0;
    const channel: ChannelAdapter = {
      name: "telegram",
      start: async () => {},
      stop: async () => {},
      isConnected: () => true,
      sendMessage: async (m) => {
        sent.push(m);
        return { messageId: `m-${sent.length}` };
      },
      sendTyping: async (_chatId, active) => {
        if (active) typingCalls += 1;
        else typingOffCalls += 1;
      },
    };

    const turns: AgentTurnInput[] = [];
    const resetChats: string[] = [];
    const backend: AgentBackend = {
      stop: async () => {},
      sendTurn: async (input): Promise<AgentTurnResult> => {
        turns.push(input);
        return {
          sessionId: `sess-${turns.length}`,
          text: `reply:${input.text}`,
          stopReason: "end_turn",
        };
      },
      cancelTurn: async () => false,
      resetSession: async (c) => {
        resetChats.push(c);
      },
      listSessions: async () => [],
    };

    const config: GatewayConfig = loadConfig(
      {
        TELEGRAM_BOT_TOKEN: "123456:test-token",
        TELEGRAM_ALLOWED_USERS: "u1",
        ALLOWED_SENDERS: "telegram:u1",
        DEFAULT_CWD: baseDir,
        DATA_DIR: path.join(baseDir, "data"),
        ...extraEnv,
      },
      { loadDotenv: false },
    );

    const store = new GatewayStore(config.dataDir);
    const scheduler = new LoopScheduler({ store, channel });
    const router = new GatewayRouter({
      config,
      channel,
      backend,
      store,
      scheduler,
      quotaFetcher: async () => ({ available: false, fetchedAt: Date.now(), groups: [] }),
    });

    const msg = (text: string): InboundMessage => ({
      id: `in-${Date.now()}-${Math.random()}`,
      channel: "telegram",
      chatId: "telegram::chat-1",
      senderId: "u1",
      isGroup: false,
      text,
      attachments: [],
      timestamp: Date.now(),
    });

    return {
      sent,
      turns,
      resetChats,
      store,
      scheduler,
      router,
      msg,
      getTypingStats: () => ({ typingCalls, typingOffCalls }),
    };
  }

  it("supports /cwd save, list, @alias switching, rm, and WORKSPACE_ALIASES env", async () => {
    const root = createTempDir();
    const apiDir = path.join(root, "api");
    const webDir = path.join(root, "web");
    fs.mkdirSync(apiDir);
    fs.mkdirSync(webDir);

    expect(parseWorkspaceAliases(`web=${webDir}; bad-entry`)).toEqual({
      web: path.resolve(webDir),
    });

    const { sent, store, router, msg } = makeRouterEnv(root, {
      WORKSPACE_ALIASES: `web=${webDir}`,
    });
    await store.load();

    await router.handleInbound(msg(`/cwd save api ${apiDir}`));
    expect(sent.at(-1)?.text).toContain("Saved workspace @api");

    await router.handleInbound(msg("/cwd list"));
    expect(sent.at(-1)?.text).toContain("@api");
    expect(sent.at(-1)?.text).toContain("@web");

    await router.handleInbound(msg("/cwd @api"));
    expect(sent.at(-1)?.text).toContain(apiDir);
    expect(store.getSession("telegram::chat-1")?.cwd).toBe(apiDir);

    await router.handleInbound(msg("/cwd @web"));
    expect(sent.at(-1)?.text).toContain(webDir);
    expect(store.getSession("telegram::chat-1")?.cwd).toBe(webDir);

    await router.handleInbound(msg("/cwd rm api"));
    expect(sent.at(-1)?.text).toContain("Removed saved workspace @api");
    expect(store.getWorkspace("api")).toBeUndefined();
  });

  it("supports /loop daily & /loop cron and isolates loop turns from interactive user sessions", async () => {
    const root = createTempDir();
    const otherDir = path.join(root, "other");
    fs.mkdirSync(otherDir);

    const { sent, turns, resetChats, store, scheduler, router, msg } = makeRouterEnv(root);
    await store.load();

    // Establish an interactive user session in `root`
    await router.handleInbound(msg("hello interactive"));
    expect(store.getSession("telegram::chat-1")?.sessionId).toBe("sess-1");
    expect(store.getSession("telegram::chat-1")?.cwd).toBe(root);

    // Schedule daily and 5-field cron jobs via slash command
    await router.handleInbound(msg("/loop daily 09:00 morning report"));
    expect(sent.at(-1)?.text).toContain("daily 09:00");

    await router.handleInbound(msg('/loop cron "0 9 * * 1-5" weekday standup'));
    expect(sent.at(-1)?.text).toContain("cron 0 9 * * 1-5");

    const jobs = scheduler.listJobs("telegram::chat-1");
    expect(jobs).toHaveLength(2);

    // Fire a loop job with a DIFFERENT cwd (`otherDir`): must NOT clobber interactive session/cwd!
    await router.runLoopPrompt({
      ...jobs[1],
      cwd: otherDir,
    });

    const loopTurn = turns.at(-1);
    expect(loopTurn?.chatId).toBe(`telegram::chat-1::loop:${jobs[1].id}`);
    expect(loopTurn?.sessionId).toBeUndefined();
    expect(loopTurn?.cwd).toBe(otherDir);

    // Interactive session remains completely untouched
    expect(store.getSession("telegram::chat-1")?.sessionId).toBe("sess-1");
    expect(store.getSession("telegram::chat-1")?.cwd).toBe(root);
    // Ephemeral loop backend session was released after completion
    expect(resetChats).toContain(`telegram::chat-1::loop:${jobs[1].id}`);
    // Reply was still delivered to the user's chat
    expect(sent.at(-1)?.chatId).toBe("telegram::chat-1");
    expect(sent.at(-1)?.text).toContain("reply:weekday standup");
  });

  it("self-heals stale ACP sessions during loadSession and pre-stream prompt failures", async () => {
    const root = createTempDir();
    const config = loadConfig(
      {
        TELEGRAM_BOT_TOKEN: "123456:test-token",
        DEFAULT_CWD: root,
        DATA_DIR: path.join(root, "data"),
      },
      { loadDotenv: false },
    );

    let newSessionCount = 0;
    let promptAttempts = 0;
    const fakeClient: AgyAcpClientLike = {
      ensureStarted: async () => {},
      stop: async () => {},
      newSession: async (cwd) => {
        newSessionCount += 1;
        return { sessionId: `fresh-${newSessionCount}`, cwd, configOptions: [] };
      },
      loadSession: async () => {
        throw new Error("RPC error -32002: Session not found");
      },
      listSessions: async () => [],
      setConfigOption: async () => {},
      setMode: async () => {},
      prompt: async (sessionId, opts) => {
        promptAttempts += 1;
        if (promptAttempts === 2) {
          throw new Error("unknown session: evicted after idle");
        }
        return { sessionId, text: `ok:${sessionId}:${opts.text}`, stopReason: "end_turn" };
      },
      cancel: async () => {},
      getAvailableModels: () => [],
      getAvailableBaseModels: () => [],
      getAvailableEfforts: () => [],
      getAvailableModes: () => [],
      getModelCatalog: () => [],
    };

    const backend = new AgyAgentBackend(config, { client: fakeClient });
    // 1. Saved sessionId fails loadSession with -32002 -> auto-recovers into fresh-1
    const first = await backend.sendTurn({
      chatId: "chat-recover",
      sessionId: "dead-old-session-id",
      cwd: root,
      text: "hi after restart",
    });
    expect(first.sessionId).toBe("fresh-1");
    expect(first.text).toContain("ok:fresh-1");

    // 2. Active session gets evicted before any output streams -> recreates fresh-2 and retries seamlessly
    const second = await backend.sendTurn({
      chatId: "chat-recover",
      cwd: root,
      text: "hi after eviction",
    });
    expect(second.sessionId).toBe("fresh-2");
    expect(second.text).toContain("ok:fresh-2");
    expect(newSessionCount).toBe(2);
  });
});
