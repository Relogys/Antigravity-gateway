import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayConfig } from "../src/config.js";
import type { InboundMessage } from "../src/types.js";

const holder = vi.hoisted(() => ({
  lastSpectrumOptions: undefined as any,
  lastImessageConfig: undefined as any,
}));

vi.mock("spectrum-ts", () => ({
  Spectrum: vi.fn((opts: any) => {
    holder.lastSpectrumOptions = opts;
    return new Promise((_resolve, reject) => {
      const onAbort = () => reject(new Error("spectrum init aborted"));
      if (opts?.signal?.aborted) {
        onAbort();
        return;
      }
      opts?.signal?.addEventListener?.("abort", onAbort, { once: true });
    });
  }),
  attachment: vi.fn((input: any, options?: any) => ({ __kind: "attachment", input, options })),
  markdown: vi.fn((content: string) => ({ __kind: "markdown", content })),
  richlink: vi.fn((content: string) => ({ __kind: "richlink", content })),
  text: vi.fn((content: string) => ({ __kind: "text", content })),
  voice: vi.fn((input: any, options?: any) => ({ __kind: "voice", input, options })),
  poll: vi.fn((title: string, options: string[]) => ({ __kind: "poll", title, options })),
}));

vi.mock("spectrum-ts/providers/imessage", () => ({
  effect: vi.fn((content: any, effectId: string) => ({ __kind: "effect", content, effectId })),
  background: vi.fn((input: any) => ({ __kind: "background", input })),
  nativeContactCard: vi.fn(() => ({ __kind: "contactCard" })),
  imessage: Object.assign(vi.fn(() => ({ type: "dm", sender: { service: "iMessage" } })), {
    config: vi.fn((cfg: any) => {
      holder.lastImessageConfig = cfg;
      return { __provider: "imessage", cfg };
    }),
    effect: { message: { slam: "com.apple.MobileSMS.expressivesend.impact" } },
  }),
}));

const { PhotonChannelAdapter, PHOTON_BACKGROUND_PRESETS } = await import(
  "../src/photon/adapter.js"
);
const { StreamStalenessWatchdog } = await import("../src/photon/staleness.js");
const spectrum = await import("spectrum-ts");
const imessageProvider = await import("spectrum-ts/providers/imessage");

const CHAT_ID = "+15550001234";
const SPACE_ID = "any;-;+15550001234";

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.PHOTON_HEARTBEAT_TIMEOUT_MS;
  delete process.env.PHOTON_PROBE_SPACE_ID;
});

function makeConfig(photonOverrides: Partial<GatewayConfig["photon"]> = {}): GatewayConfig {
  return {
    allowedSenders: new Set([CHAT_ID]),
    allowGroups: false,
    groupMentionPatterns: ["@agy"],
    agyBin: "agy",
    defaultCwd: os.tmpdir(),
    approvalMode: "interactive",
    defaultModel: "test-model",
    defaultEffort: "high",
    healthEnabled: false,
    healthHost: "127.0.0.1",
    healthPort: 0,
    quotaWarnThreshold: 0,
    dataDir: path.join(os.tmpdir(), "agw-photon-v12-test"),
    logLevel: "info",
    photon: {
      projectId: "test-project-id",
      projectSecret: "test-project-secret",
      readReceipts: true,
      reactions: true,
      ...photonOverrides,
    },
  };
}

function makeAdapter(
  options: {
    startupTimeoutMs?: number;
    connectTimeoutMs?: number;
    heartbeatTimeoutMs?: number;
    photon?: Partial<GatewayConfig["photon"]>;
  } = {},
): InstanceType<typeof PhotonChannelAdapter> {
  return new PhotonChannelAdapter(makeConfig(options.photon), {
    startupTimeoutMs: options.startupTimeoutMs,
    connectTimeoutMs: options.connectTimeoutMs,
    heartbeatTimeoutMs: options.heartbeatTimeoutMs,
  });
}

function fakeSpace(overrides: Record<string, unknown> = {}) {
  return {
    id: SPACE_ID,
    send: vi.fn(async () => ({ id: "sent-1", direction: "outbound" })),
    getMessage: vi.fn(),
    startTyping: vi.fn(),
    stopTyping: vi.fn(),
    ...overrides,
  } as any;
}

function withSpace(adapter: InstanceType<typeof PhotonChannelAdapter>, space: any) {
  (adapter as any).spacesByChatId.set(CHAT_ID, space);
  return adapter;
}

describe("Spectrum({ signal }) transport hardening", () => {
  it("passes an AbortSignal into Spectrum and aborts it on connect timeout", async () => {
    holder.lastSpectrumOptions = undefined;
    const adapter = makeAdapter({ connectTimeoutMs: 30 });

    const pending = (adapter as any).createSpectrumApp();
    await expect(pending).rejects.toThrow();
    expect(holder.lastSpectrumOptions).toBeDefined();
    expect(holder.lastSpectrumOptions.signal).toBeInstanceOf(AbortSignal);
    await vi.waitFor(() => expect(holder.lastSpectrumOptions.signal.aborted).toBe(true));
  });

  it("aborts initialization promptly when the parent signal aborts", async () => {
    holder.lastSpectrumOptions = undefined;
    const adapter = makeAdapter({ connectTimeoutMs: 10_000 });
    const parent = new AbortController();

    const pending = (adapter as any).createSpectrumApp(parent.signal);
    await vi.waitFor(() => expect(holder.lastSpectrumOptions).toBeDefined());
    const signal: AbortSignal = holder.lastSpectrumOptions.signal;

    parent.abort();
    await expect(pending).rejects.toThrow();
    expect(signal.aborted).toBe(true);
  });

  it("stop() aborts the in-flight connect signal", async () => {
    holder.lastSpectrumOptions = undefined;
    const adapter = makeAdapter({ startupTimeoutMs: 20, connectTimeoutMs: 10_000 });

    await adapter.start(() => {});
    await vi.waitFor(() => expect(holder.lastSpectrumOptions).toBeDefined());
    const signal: AbortSignal = holder.lastSpectrumOptions.signal;

    await adapter.stop();
    await vi.waitFor(() => expect(signal.aborted).toBe(true));
  });
});

describe("Heartbeat metadata", () => {
  it("onHeartbeat stores stream/lineId/receivedAt on adapter stats and watchdog state", async () => {
    holder.lastImessageConfig = undefined;
    const adapter = makeAdapter({ connectTimeoutMs: 25 });
    const watchdog = new StreamStalenessWatchdog({
      heartbeatTimeoutMs: 0,
      probeFn: vi.fn(),
      onZombieDetected: vi.fn(),
      nowFn: () => 1_000,
    });
    (adapter as any).watchdog = watchdog;

    await expect((adapter as any).createSpectrumApp()).rejects.toThrow();
    const onHeartbeat = holder.lastImessageConfig?.onHeartbeat;
    expect(typeof onHeartbeat).toBe("function");

    onHeartbeat({
      lineId: "line-42",
      phone: "+15550001111",
      projectId: "proj-1",
      stream: "messages",
      subscriptionId: "sub-9",
      receivedAt: 1_234_567,
    });

    expect(adapter.getStats()).toMatchObject({
      lastHeartbeatAt: 1_234_567,
      heartbeatStream: "messages",
      heartbeatLineId: "line-42",
    });
    expect(watchdog.getState()).toMatchObject({
      lastHeartbeatAt: 1_234_567,
      lastHeartbeatStream: "messages",
      lastHeartbeatLineId: "line-42",
    });
  });

  it("recordHeartbeat(at) stays backward compatible and omits unknown stream/line", async () => {
    let now = 5_000;
    const onHeartbeatTimeout = vi.fn();
    const watchdog = new StreamStalenessWatchdog({
      heartbeatTimeoutMs: 10_000,
      probeFn: vi.fn(),
      onZombieDetected: vi.fn(),
      onHeartbeatTimeout,
      nowFn: () => now,
    });

    watchdog.recordHeartbeat(now);
    now += 10_000;
    expect(await watchdog.checkOnce()).toBe("heartbeat_timeout");
    expect(onHeartbeatTimeout).toHaveBeenCalledWith({ silentHeartbeatMs: 10_000 });
  });

  it("includes lastStream/lastLineId in the timeout payload when known", async () => {
    let now = 5_000;
    const onHeartbeatTimeout = vi.fn();
    const watchdog = new StreamStalenessWatchdog({
      heartbeatTimeoutMs: 10_000,
      probeFn: vi.fn(),
      onZombieDetected: vi.fn(),
      onHeartbeatTimeout,
      nowFn: () => now,
    });

    watchdog.recordHeartbeat(now, { stream: "polls", lineId: "line-7" });
    now += 10_000;
    expect(await watchdog.checkOnce()).toBe("heartbeat_timeout");
    expect(onHeartbeatTimeout).toHaveBeenCalledWith({
      silentHeartbeatMs: 10_000,
      lastStream: "polls",
      lastLineId: "line-7",
    });
  });
});

describe("senderDeviceId propagation", () => {
  it("attaches senderDeviceId onto the InboundMessage", async () => {
    const adapter = makeAdapter();
    const received: InboundMessage[] = [];
    (adapter as any).onMessageHandler = async (message: InboundMessage) => {
      received.push(message);
    };

    await (adapter as any).handleRawMessage(
      { id: SPACE_ID },
      {
        id: "in-1",
        direction: "inbound",
        platform: "test",
        content: { type: "text", text: "hello world" },
        sender: { id: "any;-;+15550009999" },
        timestamp: new Date(1_700_000_000_000),
        senderDeviceId: "dev-abc",
      },
    );

    expect(received).toHaveLength(1);
    expect(received[0]!.senderDeviceId).toBe("dev-abc");
    expect(received[0]!.chatId).toBe(CHAT_ID);
    expect(received[0]!.text).toBe("hello world");
  });
});

describe("Inbound event parsing", () => {
  async function parse(content: any, rawMessage?: any) {
    const adapter = makeAdapter();
    return (adapter as any).extractInboundContent(
      CHAT_ID,
      content,
      Date.now(),
      rawMessage,
    ) as Promise<{ textParts: string[]; ignored: boolean }>;
  }

  it("parses polls", async () => {
    const result = await parse({
      type: "poll",
      title: "Lunch?",
      options: [{ title: "Pizza" }, { title: "Sushi" }],
      change: "created",
    });
    expect(result.ignored).toBe(false);
    expect(result.textParts[0]).toBe(
      '[iMessage Poll (created): "Lunch?" | options: Pizza, Sushi]',
    );
  });

  it("parses poll votes (voted and unvoted)", async () => {
    const base = {
      type: "poll_option",
      option: { title: "Pizza" },
      poll: { type: "poll", title: "Lunch?", options: [{ title: "Pizza" }] },
      title: "Pizza",
    };
    const voted = await parse({ ...base, selected: true });
    expect(voted.textParts[0]).toBe(
      '[iMessage Poll Vote (voted): "Pizza" on "Lunch?"]',
    );

    const unvoted = await parse({ ...base, selected: false });
    expect(unvoted.textParts[0]).toBe(
      '[iMessage Poll Vote (unvoted): "Pizza" on "Lunch?"]',
    );
  });

  it("parses mini-app cards using layout and miniApp metadata", async () => {
    const result = await parse(
      {
        type: "app",
        layout: async () => ({ caption: "Game", summary: "Move 3" }),
        url: async () => new URL("https://example.com/chess"),
        live: true,
      },
      { miniApp: { appName: "Chess", url: "https://example.com/chess" } },
    );
    expect(result.ignored).toBe(false);
    expect(result.textParts[0]).toBe(
      "[iMessage Mini App (Chess): Game — Move 3 — https://example.com/chess]",
    );
  });

  it("parses mini-app cards defensively when fields are missing", async () => {
    const result = await parse({ type: "app" });
    expect(result.ignored).toBe(false);
    expect(result.textParts[0]).toBe("[iMessage Mini App: card]");
  });

  it("parses group events", async () => {
    const added = await parse({ type: "addMember", members: ["+15550001111", "+15550002222"] });
    expect(added.textParts[0]).toBe(
      "[Group event: added +15550001111, +15550002222]",
    );

    const removed = await parse({ type: "removeMember", members: ["+15550003333"] });
    expect(removed.textParts[0]).toBe("[Group event: removed +15550003333]");

    const renamed = await parse({ type: "rename", displayName: "Team Chat" });
    expect(renamed.textParts[0]).toBe('[Group event: renamed group to "Team Chat"]');

    const avatar = await parse({ type: "avatar", action: { kind: "clear" } });
    expect(avatar.textParts[0]).toBe("[Group event: updated group avatar]");

    const left = await parse({ type: "leaveSpace" });
    expect(left.textParts[0]).toBe("[Group event: member left the group]");
  });

  it("does not throw on malformed event payloads", async () => {
    const malformedPoll = await parse({ type: "poll" });
    expect(malformedPoll.ignored).toBe(false);
    expect(malformedPoll.textParts[0]).toContain("Untitled poll");

    const malformedVote = await parse({ type: "poll_option" });
    expect(malformedVote.ignored).toBe(false);

    const malformedMembers = await parse({ type: "addMember" });
    expect(malformedMembers.textParts[0]).toBe("[Group event: added members]");
  });

  it("still ignores read/reaction/typing/effect/custom", async () => {
    for (const type of ["read", "reaction", "typing", "effect", "custom"]) {
      const result = await parse({ type });
      expect(result.ignored).toBe(true);
    }
  });
});

describe("Native iMessage capabilities", () => {
  it("exposes the 24 documented background presets", () => {
    expect(PHOTON_BACKGROUND_PRESETS).toHaveLength(24);
    expect(PHOTON_BACKGROUND_PRESETS).toContain("skyDusk");
    expect(PHOTON_BACKGROUND_PRESETS).toContain("colorStone");
  });

  it("sendPoll validates input and sends a native poll", async () => {
    const send = vi.fn(async () => ({ id: "poll-msg-1", direction: "outbound" }));
    const adapter = withSpace(makeAdapter(), fakeSpace({ send }));

    const result = await adapter.sendPoll(CHAT_ID, "  Lunch?  ", ["Pizza", " Sushi "]);

    expect(result).toEqual({ messageId: "poll-msg-1" });
    expect(vi.mocked(spectrum.poll)).toHaveBeenCalledWith("Lunch?", ["Pizza", "Sushi"]);
    expect(send).toHaveBeenCalledTimes(1);
    expect((adapter as any).lastOutboundMessageIdByChatId.get(CHAT_ID)).toBe("poll-msg-1");
  });

  it("sendPoll rejects invalid titles and option lists", async () => {
    const adapter = withSpace(makeAdapter(), fakeSpace());

    await expect(adapter.sendPoll(CHAT_ID, "   ", ["a", "b"])).rejects.toThrow(/title/i);
    await expect(adapter.sendPoll(CHAT_ID, "Pick", ["only-one"])).rejects.toThrow(
      /two non-empty/i,
    );
    await expect(adapter.sendPoll(CHAT_ID, "Pick", ["ok", "   "])).rejects.toThrow(
      /two non-empty/i,
    );
  });

  it("setBackground matches presets case-insensitively, clears, and rejects unknown values", async () => {
    const send = vi.fn(async () => ({ id: "bg-1", direction: "outbound" }));
    const adapter = withSpace(makeAdapter(), fakeSpace({ send }));

    await adapter.setBackground(CHAT_ID, "SKYDUSK");
    expect(vi.mocked(imessageProvider.background)).toHaveBeenLastCalledWith({ preset: "skyDusk" });

    await adapter.setBackground(CHAT_ID, "clear");
    expect(vi.mocked(imessageProvider.background)).toHaveBeenLastCalledWith("clear");

    await expect(adapter.setBackground(CHAT_ID, "rainbow")).rejects.toThrow(
      /rainbow|valid presets/i,
    );
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("shareContactCard sends the native contact card", async () => {
    const send = vi.fn(async () => ({ id: "cc-1", direction: "outbound" }));
    const adapter = withSpace(makeAdapter(), fakeSpace({ send }));

    await adapter.shareContactCard(CHAT_ID);

    expect(vi.mocked(imessageProvider.nativeContactCard)).toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ __kind: "contactCard" }));
  });

  it("deleteMessage unsends an outbound message", async () => {
    const unsend = vi.fn(async () => {});
    const adapter = withSpace(makeAdapter(), fakeSpace());
    (adapter as any).messagesById.set("m-out", {
      id: "m-out",
      direction: "outbound",
      unsend,
    });

    await adapter.deleteMessage(CHAT_ID, "m-out");
    expect(unsend).toHaveBeenCalledTimes(1);
  });

  it("deleteMessage ignores inbound messages", async () => {
    const unsend = vi.fn(async () => {});
    const adapter = withSpace(makeAdapter(), fakeSpace());
    (adapter as any).messagesById.set("m-in", {
      id: "m-in",
      direction: "inbound",
      unsend,
    });

    await adapter.deleteMessage(CHAT_ID, "m-in");
    expect(unsend).not.toHaveBeenCalled();
  });

  it("unsendLastMessage unsends the tracked outbound message", async () => {
    const unsend = vi.fn(async () => {});
    const adapter = withSpace(makeAdapter(), fakeSpace());
    (adapter as any).messagesById.set("last-out", {
      id: "last-out",
      direction: "outbound",
      unsend,
    });
    (adapter as any).lastOutboundMessageIdByChatId.set(CHAT_ID, "last-out");

    const result = await adapter.unsendLastMessage(CHAT_ID);

    expect(result).toEqual({ ok: true, messageId: "last-out" });
    expect(unsend).toHaveBeenCalledTimes(1);
    expect((adapter as any).lastOutboundMessageIdByChatId.has(CHAT_ID)).toBe(false);
  });

  it("unsendLastMessage reports when there is nothing to unsend", async () => {
    const adapter = withSpace(makeAdapter(), fakeSpace());
    const result = await adapter.unsendLastMessage(CHAT_ID);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/No recent outbound/i);
  });

  it("unsendLastMessage surfaces window-expiry errors without throwing", async () => {
    const unsend = vi.fn(async () => {
      throw new Error("Unsend window expired");
    });
    const adapter = withSpace(makeAdapter(), fakeSpace());
    (adapter as any).messagesById.set("expired", {
      id: "expired",
      direction: "outbound",
      unsend,
    });
    (adapter as any).lastOutboundMessageIdByChatId.set(CHAT_ID, "expired");

    const result = await adapter.unsendLastMessage(CHAT_ID);

    expect(result.ok).toBe(false);
    expect(result.messageId).toBe("expired");
    expect(result.reason).toMatch(/expired/i);
  });
});

describe("deliverMessage resilience", () => {
  it("falls back to plain text when a markdown send fails", async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error("Styling not supported"))
      .mockResolvedValueOnce({ id: "fallback-1", direction: "outbound" });
    const adapter = withSpace(makeAdapter(), fakeSpace({ send }));
    vi.mocked(spectrum.text).mockClear();

    const result = await adapter.sendMessage({ chatId: CHAT_ID, text: "**Hello** world" });

    expect(send).toHaveBeenCalledTimes(2);
    expect(vi.mocked(spectrum.text)).toHaveBeenLastCalledWith("Hello world");
    expect(result).toEqual({ messageId: "fallback-1" });
  });

  it("rethrows target-not-allowed send errors instead of masking them", async () => {
    const send = vi.fn().mockRejectedValue(new Error("Target not allowed"));
    const adapter = withSpace(makeAdapter(), fakeSpace({ send }));

    await expect(
      adapter.sendMessage({ chatId: CHAT_ID, text: "**Hi**" }),
    ).rejects.toThrow(/photon plan restriction/i);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("honors the configured maxChunkChars when splitting long messages", async () => {
    const send = vi.fn(async () => ({ id: `chunk-${Math.random()}`, direction: "outbound" }));
    const adapter = withSpace(makeAdapter({ photon: { maxChunkChars: 40 } }), fakeSpace({ send }));

    const longText = Array.from({ length: 20 }, (_, i) => `Word number ${i}`).join(" ");
    await adapter.sendMessage({ chatId: CHAT_ID, text: longText });

    expect(send.mock.calls.length).toBeGreaterThan(1);
  });
});