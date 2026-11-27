import { describe, expect, it, vi } from "vitest";
import type { GatewayConfig } from "../src/config.js";
import type { ChannelAdapter, InboundMessage, OutboundMessage } from "../src/types.js";
import { MultiChannelHub } from "../src/channels/hub.js";
import { SentMessageIndex } from "../src/channels/sent-index.js";
import { TelegramChannelAdapter } from "../src/channels/telegram.js";
import { chunkText } from "../src/channels/utils.js";

vi.mock("spectrum-ts", () => ({
  Spectrum: vi.fn(),
  attachment: vi.fn(),
  markdown: vi.fn(),
  richlink: vi.fn(),
  text: vi.fn(),
  voice: vi.fn(),
}));
vi.mock("spectrum-ts/providers/imessage", () => ({
  effect: vi.fn(),
  imessage: Object.assign(vi.fn(), { config: vi.fn(() => ({})), effect: { message: {} } }),
}));

const { PhotonChannelAdapter } = await import("../src/photon/adapter.js");

function baseConfig(): GatewayConfig {
  return {
    allowedSenders: new Set(),
    allowGroups: true,
    groupMentionPatterns: [],
    agyBin: "agy",
    defaultCwd: "/tmp/agyw",
    approvalMode: "auto",
    healthEnabled: false,
    healthHost: "127.0.0.1",
    healthPort: 0,
    quotaWarnThreshold: 0,
    progressSilenceMs: 120_000,
    sessionStallTimeoutMs: 300_000,
    turnMaxRetries: 2,
    autoBootstrapChannelSession: true,
    dataDir: "/tmp/agyw-data",
    logLevel: "error",
  };
}

function fenceLineCount(chunk: string): number {
  return chunk.split("\n").filter((line) => /^\s*```/.test(line)).length;
}

describe("chunkText fence awareness", () => {
  it("keeps a TypeScript code block balanced across chunks and preserves the language tag", () => {
    const code = Array.from({ length: 80 }, (_, i) => `const value${i} = ${i};`).join("\n");
    const text = `Before the code.\n\n\`\`\`ts\n${code}\n\`\`\`\n\nAfter the code.`;
    const chunks = chunkText(text, 120);

    expect(chunks.length).toBeGreaterThan(2);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(120);
      expect(fenceLineCount(chunk) % 2).toBe(0);
    }

    const continuations = chunks.filter((chunk) => chunk.startsWith("```ts\n"));
    expect(continuations.length).toBeGreaterThan(0);
    for (let i = 1; i < chunks.length; i += 1) {
      if (chunks[i]!.startsWith("```ts\n")) {
        expect(chunks[i - 1]!.endsWith("```")).toBe(true);
      }
    }
  });

  it("reopens Python fenced blocks with the python tag and stays within maxLen", () => {
    const code = Array.from({ length: 60 }, (_, i) => `print("line ${i} of output")`).join("\n");
    const text = `Run this:\n\n\`\`\`python\n${code}\n\`\`\`\n\nDone.`;
    const chunks = chunkText(text, 100);

    expect(chunks.length).toBeGreaterThan(2);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(100);
      expect(fenceLineCount(chunk) % 2).toBe(0);
    }
    expect(chunks.some((chunk) => chunk.startsWith("```python\n"))).toBe(true);
  });

  it("leaves a short balanced code block untouched", () => {
    const text = "Here:\n\n```ts\nconst a = 1;\n```\n\ndone";
    expect(chunkText(text, 200)).toEqual([text]);
  });

  it("never exceeds maxLen and avoids splitting short inline code spans", () => {
    const text = `intro ${"a".repeat(30)} use \`inline_code_here\` ${"b".repeat(30)} outro`;
    const chunks = chunkText(text, 40);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(40);
    }
    for (const chunk of chunks) {
      const ticks = (chunk.match(/`/g) ?? []).length;
      expect(ticks % 2).toBe(0);
    }
  });
});

describe("SentMessageIndex", () => {
  it("truncates stored text cleanly and isolates lookups by channel and chat", () => {
    const index = new SentMessageIndex({ maxEntries: 10, maxTextChars: 5 });
    index.record("telegram", "1", "m1", "hello world", true);
    index.record("telegram", "2", "m1", "other chat", false);
    index.record("discord", "1", "m1", "other channel", false);

    expect(index.lookup("telegram", "1", "m1")).toMatchObject({
      text: "hello",
      isOwnMessage: true,
    });
    expect(index.lookup("telegram", "2", "m1")?.text).toBe("other");
    expect(index.lookup("discord", "1", "m1")?.text).toBe("other");
    expect(index.lookup("telegram", "1", "missing")).toBeUndefined();
  });

  it("does not split surrogate pairs when truncating", () => {
    const index = new SentMessageIndex({ maxTextChars: 2 });
    index.record("telegram", "1", "m1", "a\u{1F600}b", false);
    expect(index.lookup("telegram", "1", "m1")?.text).toBe("a");
  });

  it("evicts the least-recently-used entry and refreshes hits", () => {
    const index = new SentMessageIndex({ maxEntries: 2 });
    index.record("telegram", "1", "a", "A", true);
    index.record("telegram", "1", "b", "B", false);
    expect(index.size).toBe(2);

    // Touch "a" so "b" becomes the oldest.
    expect(index.lookup("telegram", "1", "a")?.text).toBe("A");
    index.record("telegram", "1", "c", "C", false);

    expect(index.size).toBe(2);
    expect(index.lookup("telegram", "1", "b")).toBeUndefined();
    expect(index.lookup("telegram", "1", "a")?.text).toBe("A");
    expect(index.lookup("telegram", "1", "c")?.text).toBe("C");

    index.clear();
    expect(index.size).toBe(0);
  });
});

class HubFakeAdapter implements ChannelAdapter {
  readonly name: string;
  connected = false;
  sent: OutboundMessage[] = [];
  handler?: (msg: InboundMessage) => Promise<void> | void;

  constructor(name: string) {
    this.name = name;
  }

  async start(onMessage: (msg: InboundMessage) => Promise<void> | void): Promise<void> {
    this.handler = onMessage;
    this.connected = true;
  }
  async stop(): Promise<void> {
    this.connected = false;
  }
  isConnected(): boolean {
    return this.connected;
  }
  async sendMessage(msg: OutboundMessage): Promise<{ messageId?: string }> {
    this.sent.push(msg);
    return { messageId: `${this.name}-${this.sent.length}` };
  }
}

function inbound(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    id: "in-0",
    channel: "telegram",
    chatId: "42",
    senderId: "user-1",
    isGroup: false,
    text: "hello",
    attachments: [],
    timestamp: Date.now(),
    mentionsBot: true,
    ...overrides,
  };
}

describe("MultiChannelHub reply-quote enrichment", () => {
  it("quotes previously sent outbound text and previously received inbound text", async () => {
    const adapter = new HubFakeAdapter("telegram");
    const hub = new MultiChannelHub([adapter], { log: () => {} });
    const received: InboundMessage[] = [];
    await hub.start((msg) => {
      received.push(msg);
    });

    await hub.sendMessage({ chatId: "telegram::42", text: "the bot answer" });
    expect(adapter.sent[0]).toEqual({ chatId: "42", text: "the bot answer" });

    adapter.handler?.(inbound({ id: "in-1", text: "user question" }));
    await vi.waitFor(() => expect(received).toHaveLength(1));

    adapter.handler?.(inbound({ id: "in-2", replyToMessageId: "telegram-1" }));
    await vi.waitFor(() => expect(received).toHaveLength(2));
    expect(received[1]).toMatchObject({
      chatId: "telegram::42",
      replyToText: "the bot answer",
      replyToIsOwnMessage: true,
    });

    adapter.handler?.(inbound({ id: "in-3", replyToMessageId: "in-1" }));
    await vi.waitFor(() => expect(received).toHaveLength(3));
    expect(received[2]).toMatchObject({
      replyToText: "user question",
      replyToIsOwnMessage: false,
    });

    await hub.stop();
  });
});

describe("Photon content hardening", () => {
  it("drops lone \\ufffc placeholder bubbles and strips them from real text", async () => {
    const adapter = new PhotonChannelAdapter({
      ...baseConfig(),
      photon: {
        projectId: "test-pid",
        projectSecret: "test-secret",
        readReceipts: false,
        reactions: false,
      },
    });
    const extract = (adapter as any).extractInboundContent.bind(adapter);

    const lone = await extract("chat-1", { type: "text", text: "\ufffc" }, Date.now());
    expect(lone.ignored).toBe(true);
    expect(lone.textParts).toEqual([]);

    const mixed = await extract(
      "chat-1",
      { type: "text", text: "hello\ufffc world" },
      Date.now(),
    );
    expect(mixed.ignored).toBe(false);
    expect(mixed.textParts).toEqual(["hello world"]);
  });

  it("extracts quoted text from reply targets", async () => {
    const adapter = new PhotonChannelAdapter({
      ...baseConfig(),
      photon: {
        projectId: "test-pid",
        projectSecret: "test-secret",
        readReceipts: false,
        reactions: false,
      },
    });
    const extract = (adapter as any).extractInboundContent.bind(adapter);

    const inboundReply = await extract(
      "chat-1",
      {
        type: "reply",
        content: { type: "text", text: "my answer" },
        target: { id: "orig-9", direction: "inbound", content: { type: "text", text: "original inbound text" } },
      },
      Date.now(),
    );
    expect(inboundReply.replyToMessageId).toBe("orig-9");
    expect(inboundReply.textParts).toEqual(["my answer"]);
    expect(inboundReply.replyToText).toBe("original inbound text");
    expect(inboundReply.replyToIsOwnMessage).toBeUndefined();

    const outboundReply = await extract(
      "chat-1",
      {
        type: "reply",
        content: { type: "text", text: "follow up" },
        target: { id: "orig-10", direction: "outbound", content: { type: "text", text: "prior bot text" } },
      },
      Date.now(),
    );
    expect(outboundReply.replyToText).toBe("prior bot text");
    expect(outboundReply.replyToIsOwnMessage).toBe(true);
  });
});

describe("Telegram reply-quote extraction", () => {
  function toInbound(): (msg: unknown) => Promise<InboundMessage | undefined> {
    const adapter = new TelegramChannelAdapter({
      ...baseConfig(),
      telegram: { botToken: "test-token", allowedUsers: new Set(), pollTimeoutSec: 1 },
    });
    return (adapter as any).toInbound.bind(adapter);
  }

  it("prefers native quote.text over reply_to_message.text", async () => {
    const msg = await toInbound()({
      message_id: 100,
      date: 1_700_000_000,
      chat: { id: 4242, type: "private" },
      from: { id: 99, is_bot: false },
      text: "my reply",
      quote: { text: "quoted native text" },
      reply_to_message: {
        message_id: 90,
        from: { id: 777, is_bot: true },
        text: "older bot text",
      },
    });
    expect(msg).toMatchObject({
      replyToMessageId: "90",
      replyToText: "quoted native text",
      replyToIsOwnMessage: true,
    });
  });

  it("falls back to reply_to_message.text and caption", async () => {
    const extract = toInbound();
    const fromText = await extract({
      message_id: 101,
      chat: { id: 4242, type: "private" },
      from: { id: 99, is_bot: false },
      text: "second",
      reply_to_message: { message_id: 91, from: { id: 5, is_bot: false }, text: "older user text" },
    });
    expect(fromText).toMatchObject({
      replyToMessageId: "91",
      replyToText: "older user text",
      replyToIsOwnMessage: false,
    });

    const fromCaption = await extract({
      message_id: 102,
      chat: { id: 4242, type: "private" },
      from: { id: 99, is_bot: false },
      text: "third",
      reply_to_message: { message_id: 92, caption: "photo caption" },
    });
    expect(fromCaption?.replyToText).toBe("photo caption");
    expect(fromCaption?.replyToIsOwnMessage).toBeUndefined();
  });
});