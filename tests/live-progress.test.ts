import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LiveProgressTracker,
  sanitizeToolTitle,
  type LiveProgressChannel,
  type LiveProgressTrackerOptions,
} from "../src/gateway/progress.js";
import type { OutboundMessage, ToolCallEvent } from "../src/types.js";

const START = 1_700_000_000_000;

class FakeChannel implements LiveProgressChannel {
  sends: OutboundMessage[] = [];
  edits: Array<{ chatId: string; messageId: string; text: string; markdown?: boolean }> = [];
  deletes: Array<{ chatId: string; messageId: string }> = [];
  sendAttempts = 0;
  failSend = false;
  failDelete = false;
  failEdit = false;
  noMessageId = false;

  editMessage?: (
    chatId: string,
    messageId: string,
    text: string,
    options?: { markdown?: boolean },
  ) => Promise<void>;

  deleteMessage?: (chatId: string, messageId: string) => Promise<void>;

  private seq = 0;

  constructor(options: { edit?: boolean; del?: boolean } = {}) {
    if (options.edit !== false) {
      this.editMessage = async (chatId, messageId, text, opts) => {
        if (this.failEdit) {
          throw new Error("edit failed");
        }
        this.edits.push({ chatId, messageId, text, markdown: opts?.markdown });
      };
    }
    if (options.del !== false) {
      this.deleteMessage = async (chatId, messageId) => {
        if (this.failDelete) {
          throw new Error("delete failed");
        }
        this.deletes.push({ chatId, messageId });
      };
    }
  }

  async sendMessage(msg: OutboundMessage): Promise<{ messageId?: string } | void> {
    this.sendAttempts += 1;
    if (this.failSend) {
      throw new Error("send failed");
    }
    this.sends.push(msg);
    if (this.noMessageId) {
      return;
    }
    this.seq += 1;
    return { messageId: `msg-${this.seq}` };
  }
}

function makeTracker(
  overrides: Partial<LiveProgressTrackerOptions> & { channel: FakeChannel },
): LiveProgressTracker {
  return new LiveProgressTracker({
    chatId: "chat-1",
    modelLabel: "Gemini 4 Neon",
    keepOnComplete: false,
    editIntervalMs: 1500,
    nowFn: () => Date.now(),
    ...overrides,
  });
}

function tool(id: string, title: string, status = "in_progress"): ToolCallEvent {
  return { toolCallId: id, title, status };
}

async function flushAsync(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

function visibleToolLines(text: string): string[] {
  return text.split("\n").filter((line) => line.startsWith("• "));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("sanitizeToolTitle", () => {
  it("rewrites IDE file links with line ranges", () => {
    expect(sanitizeToolTitle("[main.ts](file:///home/dev/repo/src/main.ts#L10-L24)")).toBe(
      "main.ts:10-24",
    );
    expect(sanitizeToolTitle("Edit [main.ts](file:///home/dev/repo/src/main.ts#L7)")).toBe(
      "Edit main.ts:7",
    );
    expect(sanitizeToolTitle("[main.ts](file:///home/dev/repo/src/main.ts)")).toBe("main.ts");
  });

  it("collapses multiline output into a single line", () => {
    expect(sanitizeToolTitle("  Read\n\tpackage.json\r\n  now  ")).toBe("Read package.json now");
  });

  it("extracts a readable prefix from a noisy multi-statement script", () => {
    const raw =
      '$token = "abc"; Invoke-RestMethod -Uri https://api.example.com/v1/items -Method POST -Headers @{ Authorization = "Bearer $token" }';
    const title = sanitizeToolTitle(raw);
    expect(title.startsWith("Invoke-RestMethod")).toBe(true);
    expect(Array.from(title).length).toBeLessThanOrEqual(48);
    expect(title.endsWith("…")).toBe(true);
    expect(title).not.toContain(";");
  });

  it("summarizes piped and chained shell commands", () => {
    expect(sanitizeToolTitle("npm test | tee output.log")).toBe("npm test");
    expect(sanitizeToolTitle("pnpm build && pnpm test")).toBe("pnpm build");
    expect(sanitizeToolTitle("$ git status || echo clean")).toBe("git status");
  });

  it("truncates long titles with an ellipsis", () => {
    const title = sanitizeToolTitle("a".repeat(120));
    expect(Array.from(title).length).toBe(48);
    expect(title.endsWith("…")).toBe(true);
    expect(sanitizeToolTitle("abcdefghij", 5)).toBe("abcd…");
  });

  it("falls back to tool for empty or whitespace-only input", () => {
    expect(sanitizeToolTitle("")).toBe("tool");
    expect(sanitizeToolTitle(" \n\t\r ")).toBe("tool");
  });

  it("truncates surrogate pairs without splitting them", () => {
    const title = sanitizeToolTitle("🔧".repeat(40), 10);
    expect(Array.from(title).length).toBe(10);
    expect(title.endsWith("…")).toBe(true);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(title)).toBe(false);
    expect(title.slice(0, -1)).toBe("🔧".repeat(9));
  });
});

describe("LiveProgressTracker", () => {
  it("sends exactly one progress message on the first tool call", async () => {
    const channel = new FakeChannel();
    const tracker = makeTracker({ channel, replyToMessageId: "user-42" });

    tracker.onToolCall(tool("t1", "Read package.json"));
    await flushAsync();

    expect(channel.sends).toHaveLength(1);
    expect(channel.sendAttempts).toBe(1);
    expect(channel.sends[0]).toMatchObject({
      chatId: "chat-1",
      markdown: true,
      replyToMessageId: "user-42",
    });
    expect(channel.sends[0]!.text).toBe(
      "⚙️ **[Gemini 4 Neon]** 处理中 (0s · 1 次工具调用)\n• 🔄 Read package.json",
    );
    expect(tracker.getMessageId()).toBe("msg-1");
    expect(tracker.getToolCount()).toBe(1);
    expect(tracker.isActive()).toBe(true);

    await vi.advanceTimersByTimeAsync(5000);
    expect(channel.edits).toHaveLength(0);
    await tracker.finish("completed");
  });

  it("coalesces a rapid burst into one message and one throttled edit", async () => {
    const channel = new FakeChannel();
    const tracker = makeTracker({ channel, editIntervalMs: 1500 });

    for (let i = 1; i <= 10; i += 1) {
      tracker.onToolCall(tool(`t${i}`, `Step ${i}`));
    }
    await flushAsync();

    expect(channel.sends).toHaveLength(1);
    expect(channel.edits).toHaveLength(0);
    expect(tracker.getToolCount()).toBe(10);

    await vi.advanceTimersByTimeAsync(1499);
    expect(channel.edits).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    expect(channel.edits).toHaveLength(1);
    expect(channel.sends).toHaveLength(1);

    const text = channel.edits[0]!.text;
    expect(text).toContain("10 次工具调用");
    expect(text).toContain("… 另有 5 项更早调用");
    expect(visibleToolLines(text)).toHaveLength(5);
    expect(text).toContain("• 🔄 Step 10");
    expect(text).not.toContain("• 🔄 Step 5\n");
    await tracker.finish("completed");
  });

  it("updates a repeated toolCallId in place without double counting", async () => {
    const channel = new FakeChannel();
    const tracker = makeTracker({ channel });

    tracker.onToolCall(tool("t1", "Run pnpm test"));
    await flushAsync();
    expect(channel.sends).toHaveLength(1);

    tracker.onToolCall(tool("t1", "Run pnpm test --watch", "completed"));
    await vi.advanceTimersByTimeAsync(1500);

    expect(tracker.getToolCount()).toBe(1);
    expect(channel.sends).toHaveLength(1);
    expect(channel.edits).toHaveLength(1);
    const text = channel.edits[0]!.text;
    expect(text).toContain("1 次工具调用");
    expect(text).toContain("✅ Run pnpm test --watch");
    expect(text).not.toContain("🔄");

    tracker.onPhaseChange("tool");
    await vi.advanceTimersByTimeAsync(1500);
    expect(channel.edits).toHaveLength(1);
    await tracker.finish("completed");
  });

  it("shows phase context and up to 8 tools in full verbosity", async () => {
    const channel = new FakeChannel();
    const tracker = makeTracker({ channel, verbosity: "full", editIntervalMs: 1000 });

    for (let i = 1; i <= 9; i += 1) {
      tracker.onToolCall(tool(`t${i}`, `Step ${i}`));
    }
    await flushAsync();

    tracker.onPhaseChange("retrying", "Connection reset");
    await vi.advanceTimersByTimeAsync(1000);

    expect(channel.edits).toHaveLength(1);
    const text = channel.edits[0]!.text;
    expect(text).toContain("阶段 重试: Connection reset");
    expect(visibleToolLines(text)).toHaveLength(8);
    expect(text).toContain("… 另有 1 项更早调用");
    await tracker.finish("cancelled");
  });

  it("deletes the progress card when keepOnComplete is false", async () => {
    const channel = new FakeChannel();
    const tracker = makeTracker({ channel, keepOnComplete: false });

    tracker.onToolCall(tool("t1", "Read package.json", "completed"));
    await flushAsync();
    expect(tracker.getMessageId()).toBe("msg-1");

    await tracker.finish("completed");

    expect(channel.deletes).toEqual([{ chatId: "chat-1", messageId: "msg-1" }]);
    expect(channel.edits).toHaveLength(0);
    expect(tracker.isActive()).toBe(false);
  });

  it("falls back to a compact edit when deleteMessage is missing", async () => {
    const channel = new FakeChannel({ del: false });
    const tracker = makeTracker({ channel, keepOnComplete: false });

    tracker.onToolCall(tool("t1", "Read package.json", "completed"));
    await flushAsync();
    await tracker.finish("completed");

    expect(channel.deletes).toHaveLength(0);
    expect(channel.edits).toHaveLength(1);
    const text = channel.edits[0]!.text;
    expect(text.split("\n")).toHaveLength(1);
    expect(text).toContain("✅");
    expect(text).toContain("已完成");
  });

  it("falls back to a compact edit when deleteMessage rejects", async () => {
    const channel = new FakeChannel();
    channel.failDelete = true;
    const tracker = makeTracker({ channel, keepOnComplete: false });

    tracker.onToolCall(tool("t1", "Read package.json", "completed"));
    await flushAsync();
    await tracker.finish("completed");

    expect(channel.deletes).toHaveLength(0);
    expect(channel.edits).toHaveLength(1);
    expect(channel.edits[0]!.text).toContain("✅");
  });

  it("stays silent when neither delete nor edit is supported", async () => {
    const channel = new FakeChannel({ edit: false, del: false });
    const tracker = makeTracker({ channel, keepOnComplete: false });

    tracker.onToolCall(tool("t1", "Read package.json", "completed"));
    await flushAsync();
    await expect(tracker.finish("completed")).resolves.toBeUndefined();
    expect(channel.deletes).toHaveLength(0);
    expect(channel.edits).toHaveLength(0);
  });

  it("keeps a final summary when keepOnComplete is true", async () => {
    const channel = new FakeChannel();
    const tracker = makeTracker({ channel, keepOnComplete: true });

    tracker.onToolCall(tool("t1", "Read package.json", "completed"));
    tracker.onToolCall(tool("t2", "Run pnpm test", "completed"));
    await flushAsync();
    await tracker.finish("completed");

    expect(channel.deletes).toHaveLength(0);
    expect(channel.edits).toHaveLength(1);
    const text = channel.edits[0]!.text;
    expect(text).toContain("✅ **[Gemini 4 Neon]** 已完成");
    expect(text).toContain("共 2 次工具调用");
    expect(text).toContain("• ✅ Run pnpm test");
    expect(channel.edits[0]!.markdown).toBe(true);
  });

  it("renders cancelled outcomes for both keep modes", async () => {
    const kept = new FakeChannel();
    const keptTracker = makeTracker({ channel: kept, keepOnComplete: true });
    keptTracker.onToolCall(tool("t1", "Search docs"));
    await flushAsync();
    await keptTracker.finish("cancelled");

    expect(kept.deletes).toHaveLength(0);
    expect(kept.edits).toHaveLength(1);
    expect(kept.edits[0]!.text).toContain("🛑 **[Gemini 4 Neon]** 已取消");
    expect(kept.edits[0]!.text).toContain("1 次工具调用");

    const deleted = new FakeChannel();
    const deletedTracker = makeTracker({ channel: deleted, keepOnComplete: false });
    deletedTracker.onToolCall(tool("t1", "Search docs"));
    await flushAsync();
    await deletedTracker.finish("cancelled");

    expect(deleted.deletes).toHaveLength(1);
    expect(deleted.edits).toHaveLength(0);
  });

  it("truncates the summary note for failed outcomes", async () => {
    const channel = new FakeChannel();
    const tracker = makeTracker({ channel, keepOnComplete: true });

    tracker.onToolCall(tool("t1", "Run tests", "failed"));
    await flushAsync();
    await tracker.finish("failed", "Timeout while running tests. ".repeat(30));

    expect(channel.edits).toHaveLength(1);
    const lines = channel.edits[0]!.text.split("\n");
    expect(lines[0]).toContain("❌ **[Gemini 4 Neon]** 执行失败");
    expect(lines[1]).toBeDefined();
    expect(Array.from(lines[1]!).length).toBeLessThanOrEqual(200);
    expect(lines[1]!.endsWith("…")).toBe(true);
  });

  it("deletes on failure and falls back to a compact edit without delete support", async () => {
    const deleted = new FakeChannel();
    const deletedTracker = makeTracker({ channel: deleted, keepOnComplete: false });
    deletedTracker.onToolCall(tool("t1", "Run tests", "failed"));
    await flushAsync();
    await deletedTracker.finish("failed", "boom");
    expect(deleted.deletes).toHaveLength(1);
    expect(deleted.edits).toHaveLength(0);

    const fallback = new FakeChannel({ del: false });
    const fallbackTracker = makeTracker({ channel: fallback, keepOnComplete: false });
    fallbackTracker.onToolCall(tool("t1", "Run tests", "failed"));
    await flushAsync();
    await fallbackTracker.finish("failed", "boom");
    expect(fallback.deletes).toHaveLength(0);
    expect(fallback.edits).toHaveLength(1);
    expect(fallback.edits[0]!.text).toContain("❌");
  });

  it("sends nothing when verbosity is off", async () => {
    const channel = new FakeChannel();
    const tracker = makeTracker({ channel, verbosity: "off" });

    tracker.onToolCall(tool("t1", "A"));
    tracker.onToolCall(tool("t2", "B"));
    tracker.onPhaseChange("thinking");
    await flushAsync();
    await tracker.finish("completed");

    expect(channel.sends).toHaveLength(0);
    expect(channel.edits).toHaveLength(0);
    expect(channel.deletes).toHaveLength(0);
    expect(tracker.getToolCount()).toBe(0);
    expect(tracker.getMessageId()).toBeUndefined();
  });

  it("does nothing when finishing a tracker with no tool calls", async () => {
    const channel = new FakeChannel();
    const tracker = makeTracker({ channel });

    await tracker.finish("completed");
    await tracker.finish("failed", "again");

    expect(channel.sends).toHaveLength(0);
    expect(channel.edits).toHaveLength(0);
    expect(channel.deletes).toHaveLength(0);
    expect(channel.sendAttempts).toBe(0);
    expect(tracker.getMessageId()).toBeUndefined();
    expect(tracker.isActive()).toBe(false);
  });

  it("degrades silently when the initial send fails", async () => {
    const channel = new FakeChannel();
    channel.failSend = true;
    const tracker = makeTracker({ channel });

    expect(() => tracker.onToolCall(tool("t1", "Boom"))).not.toThrow();
    await flushAsync();
    expect(channel.sendAttempts).toBe(1);

    tracker.onToolCall(tool("t2", "Later"));
    await vi.advanceTimersByTimeAsync(2000);
    expect(channel.sendAttempts).toBe(1);

    await expect(tracker.finish("failed")).resolves.toBeUndefined();
    expect(channel.edits).toHaveLength(0);
    expect(channel.deletes).toHaveLength(0);
    expect(tracker.getMessageId()).toBeUndefined();
  });

  it("degrades silently when the channel returns no messageId", async () => {
    const channel = new FakeChannel();
    channel.noMessageId = true;
    const tracker = makeTracker({ channel, keepOnComplete: true });

    tracker.onToolCall(tool("t1", "Read package.json", "completed"));
    await flushAsync();
    expect(channel.sends).toHaveLength(1);
    expect(tracker.getMessageId()).toBeUndefined();

    await tracker.finish("completed");
    expect(channel.edits).toHaveLength(0);
    expect(channel.deletes).toHaveLength(0);
  });

  it("renders a compact completed summary with recent tools", async () => {
    let now = START;
    const channel = new FakeChannel();
    const tracker = makeTracker({ channel, nowFn: () => now });

    for (let i = 0; i < 6; i += 1) {
      tracker.onToolCall(tool(`t${i}`, `Step ${i}`, "completed"));
    }
    now += 42_000;

    const lines = tracker.renderFinal("completed").split("\n");
    expect(lines[0]).toBe("✅ **[Gemini 4 Neon]** 已完成 (42s · 共 6 次工具调用)");
    expect(lines[1]).toBe("… 另有 1 项更早调用");
    expect(lines.filter((line) => line.startsWith("• "))).toHaveLength(5);
    await tracker.finish("cancelled");
  });

  it("is idempotent on repeated finish calls", async () => {
    const channel = new FakeChannel();
    const tracker = makeTracker({ channel, keepOnComplete: true });
    tracker.onToolCall(tool("t1", "Read package.json", "completed"));
    await flushAsync();

    await tracker.finish("completed");
    await tracker.finish("failed", "second call");

    expect(channel.edits).toHaveLength(1);
    expect(channel.deletes).toHaveLength(0);
  });
});