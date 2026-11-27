import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayConfig } from "../src/config.js";
import type { SignalConfig } from "../src/channels/signal.js";
import {
  markdownToTelegramHtml,
  stripIdeFileLinks,
  stripMarkdownToReadableText,
} from "../src/channels/format.js";
import {
  DEFAULT_PHOTON_MAX_CHUNK_CHARS,
  chooseSendFormat,
  chunkMessage,
  sanitizeForIMessage,
} from "../src/photon/format.js";
import { TelegramChannelAdapter } from "../src/channels/telegram.js";
import {
  DiscordChannelAdapter,
  type DiscordClientLike,
  type DiscordMessageLike,
} from "../src/channels/discord.js";
import { SlackChannelAdapter, type SlackAppLike } from "../src/channels/slack.js";
import {
  IrcChannelAdapter,
  type IrcSocketFactory,
  type IrcSocketLike,
} from "../src/channels/irc.js";
import { LineChannelAdapter } from "../src/channels/line.js";
import { SignalChannelAdapter } from "../src/channels/signal.js";
import { OneBotChannelAdapter } from "../src/channels/onebot.js";

const stops: Array<() => Promise<unknown> | unknown> = [];

afterEach(async () => {
  for (const stop of stops.splice(0)) {
    await stop();
  }
});

function makeConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    allowedSenders: new Set(),
    allowGroups: true,
    groupMentionPatterns: ["@agy"],
    agyBin: "agy",
    defaultCwd: os.tmpdir(),
    approvalMode: "auto",
    healthEnabled: false,
    healthHost: "127.0.0.1",
    healthPort: 0,
    quotaWarnThreshold: 0.1,
    dataDir: os.tmpdir(),
    logLevel: "error",
    ...overrides,
  };
}

/* ---------------------------------------------------------------- formatting */

describe("stripIdeFileLinks", () => {
  it("converts line ranges, single lines and bare file links", () => {
    expect(
      stripIdeFileLinks(
        "See [src/app.ts](file:///workspace/src/app.ts#L10-L20) now.",
      ),
    ).toBe("See `src/app.ts:10-20` now.");

    expect(stripIdeFileLinks("[run](file:///a/b.ts#L7)")).toBe("`run:7`");
    expect(stripIdeFileLinks("[README](file:///docs/README.md)")).toBe(
      "`README`",
    );
  });

  it("avoids double backticks when the label is already inline code", () => {
    expect(stripIdeFileLinks("[`src/x.ts`](file:///src/x.ts#L3-L4)")).toBe(
      "`src/x.ts:3-4`",
    );
  });

  it("derives the basename when the label is empty", () => {
    expect(stripIdeFileLinks("[](file:///repo/src/index.ts#L1)")).toBe(
      "`index.ts:1`",
    );
  });

  it("leaves fenced code blocks untouched", () => {
    const input = [
      "```md",
      "[keep](file:///tmp/x.ts#L1-L2)",
      "```",
      "[strip](file:///tmp/y.ts#L5)",
    ].join("\n");
    const output = stripIdeFileLinks(input);
    expect(output).toContain("[keep](file:///tmp/x.ts#L1-L2)");
    expect(output).toContain("`strip:5`");
  });
});

describe("stripMarkdownToReadableText", () => {
  it("renders headings, rules, quotes, bullets and inline emphasis", () => {
    const input = [
      "# Release notes",
      "",
      "> shipped **today**",
      "",
      "- one",
      "- two",
      "",
      "---",
      "",
      "Use *care* with __bold words__ and ~~old~~ text, not foo_bar_baz.",
    ].join("\n");
    const output = stripMarkdownToReadableText(input);
    expect(output).toContain("【Release notes】");
    expect(output).toContain("│ shipped today");
    expect(output).toContain("• one");
    expect(output).toContain("• two");
    expect(output).toContain("———");
    expect(output).toContain("Use care with bold words and old text, not foo_bar_baz.");
  });

  it("unwraps emphasis without mangling snake_case identifiers", () => {
    expect(
      stripMarkdownToReadableText(
        "**bold** __also bold__ *ital* _also ital_ ~~strike~~ and foo_bar_baz stays.",
      ),
    ).toBe("bold also bold ital also ital strike and foo_bar_baz stays.");
  });

  it("keeps code fence bodies intact while dropping noisy fences", () => {
    const input = [
      "Before",
      "```ts",
      "const x = **not bold**; // # heading",
      "```",
      "After",
    ].join("\n");
    const output = stripMarkdownToReadableText(input);
    expect(output).not.toContain("```");
    expect(output).toContain("const x = **not bold**; // # heading");
  });

  it("formats 2-column compact tables on one line", () => {
    const input = ["| Name | Status |", "| --- | --- |", "| Build | Pass |"].join(
      "\n",
    );
    expect(stripMarkdownToReadableText(input)).toBe("• Name: Build | Status: Pass");
  });

  it("formats 3+ column tables as readable cards", () => {
    const input = [
      "| Model | Speed | Cost |",
      "| --- | --- | --- |",
      "| Alpha | Fast | Low |",
    ].join("\n");
    const output = stripMarkdownToReadableText(input);
    expect(output).toContain("▸ Alpha");
    expect(output).toContain("  • Speed: Fast");
    expect(output).toContain("  • Cost: Low");
  });

  it("formats wide 2-column rows as cards", () => {
    const description = "a".repeat(70);
    const input = [
      "| Service | Description |",
      "| --- | --- |",
      `| api | ${description} |`,
    ].join("\n");
    const output = stripMarkdownToReadableText(input);
    expect(output).toContain("▸ api");
    expect(output).toContain(`  • Description: ${description}`);
  });

  it("keeps links readable and unwraps inline code", () => {
    expect(
      stripMarkdownToReadableText(
        "Read [docs](https://example.com/a) and run `npm test`.",
      ),
    ).toBe("Read docs (https://example.com/a) and run npm test.");

    expect(stripMarkdownToReadableText("[https://example.com](https://example.com)")).toBe(
      "https://example.com",
    );
  });

  it("runs IDE file-link cleanup first", () => {
    expect(stripMarkdownToReadableText("[app.ts](file:///src/app.ts#L2-L4)")).toBe(
      "app.ts:2-4",
    );
  });
});

describe("markdownToTelegramHtml", () => {
  it("escapes html before emitting entities", () => {
    expect(markdownToTelegramHtml("1 < 2 & 3 > 2")).toBe(
      "1 &lt; 2 &amp; 3 &gt; 2",
    );
  });

  it("renders fenced code blocks with a sanitized language class", () => {
    const output = markdownToTelegramHtml(
      ['```ts', "const x = a < b && c;", "```"].join("\n"),
    );
    expect(output).toBe(
      '<pre><code class="language-ts">const x = a &lt; b &amp;&amp; c;</code></pre>',
    );
    expect(markdownToTelegramHtml("```\nplain\n```")).toBe("<pre>plain</pre>");
  });

  it("protects inline code from emphasis conversion", () => {
    expect(markdownToTelegramHtml("Use `**literal**` here")).toBe(
      "Use <code>**literal**</code> here",
    );
  });

  it("renders headings, emphasis, strikethrough and rules", () => {
    const output = markdownToTelegramHtml(
      ["# Title", "**bold** *italic* ~~gone~~", "", "***"].join("\n"),
    );
    expect(output).toContain("<b>Title</b>");
    expect(output).toContain("<b>bold</b>");
    expect(output).toContain("<i>italic</i>");
    expect(output).toContain("<s>gone</s>");
    expect(output).toContain("———");
  });

  it("renders safe links and escapes href attributes", () => {
    expect(
      markdownToTelegramHtml('[docs](https://example.com/a?b=1&c=2 "title")'),
    ).toContain('<a href="https://example.com/a?b=1&amp;c=2">docs</a>');
    expect(markdownToTelegramHtml('[q](https://example.com/a"b)')).toContain(
      '<a href="https://example.com/a&quot;b">q</a>',
    );
    expect(markdownToTelegramHtml("[mail](mailto:a@b.test)")).toContain(
      '<a href="mailto:a@b.test">mail</a>',
    );
    expect(markdownToTelegramHtml("[bad](javascript:alert(1))")).not.toContain(
      "<a ",
    );
  });

  it("groups consecutive blockquote lines", () => {
    const output = markdownToTelegramHtml("> first\n> second\n\nafter");
    expect(output).toContain("<blockquote>first\nsecond</blockquote>");
  });

  it("renders tables as compact rows or bold-label cards", () => {
    const compact = markdownToTelegramHtml(
      ["| Name | Status |", "| --- | --- |", "| Build | Pass |"].join("\n"),
    );
    expect(compact).toContain("• <b>Name</b>: Build | <b>Status</b>: Pass");

    const card = markdownToTelegramHtml(
      ["| Model | Speed | Cost |", "| --- | --- | --- |", "| Alpha | Fast | Low |"].join(
        "\n",
      ),
    );
    expect(card).toContain("▸ <b>Alpha</b>");
    expect(card).toContain("<b>Speed</b>: Fast");
    expect(card).toContain("<b>Cost</b>: Low");
  });

  it("converts bullet lists and strips IDE file links", () => {
    const output = markdownToTelegramHtml(
      "- [app.ts](file:///src/app.ts#L4-L6)\n- second",
    );
    expect(output).toContain("• <code>app.ts:4-6</code>");
    expect(output).toContain("• second");
    expect(output).not.toContain("file:///");
  });
});

/* ------------------------------------------------------------ Photon polish */

describe("Photon rendering polish", () => {
  it("defaults long chunking to the mobile-safe 1600 characters", () => {
    expect(DEFAULT_PHOTON_MAX_CHUNK_CHARS).toBe(1600);
    const chunks = chunkMessage("A".repeat(4000));
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(DEFAULT_PHOTON_MAX_CHUNK_CHARS);
    }
  });

  it("keeps two-column compact tables and upgrades wide tables to cards", () => {
    const compact = sanitizeForIMessage(
      ["| Name | Status |", "| --- | --- |", "| Build | Pass |"].join("\n"),
    );
    expect(compact).toContain("• Name: Build | Status: Pass");

    const wide = sanitizeForIMessage(
      ["| Service | Description |", "| --- | --- |", `| api | ${"b".repeat(70)} |`].join(
        "\n",
      ),
    );
    expect(wide).toContain("• **api**");
    expect(wide).toContain("  Description: b");
  });

  it("renders 3-column comparison tables as cards", () => {
    const output = sanitizeForIMessage(
      ["| Model | Speed | Cost |", "| --- | --- | --- |", "| Alpha | Fast | Low |"].join(
        "\n",
      ),
    );
    expect(output).toContain("• **Alpha**");
    expect(output).toContain("  Speed: Fast");
    expect(output).toContain("  Cost: Low");
  });

  it("cleans IDE links, headings, rules and preserves code", () => {
    const output = sanitizeForIMessage(
      [
        "## Summary",
        "[app.ts](file:///src/app.ts#L1-L3)",
        "---",
        "```ts",
        "| keep | pipe |",
        "```",
      ].join("\n"),
    );
    expect(output).toContain("**Summary**");
    expect(output).toContain("`app.ts:1-3`");
    expect(output).toContain("———");
    expect(output).toContain("| keep | pipe |");
  });

  it("keeps bare URLs on the rich link path and Markdown for inline URLs", () => {
    expect(chooseSendFormat("https://example.com/x")).toEqual({
      mode: "richlink",
      content: "https://example.com/x",
    });
    expect(chooseSendFormat("see https://example.com/x now")).toEqual({
      mode: "markdown",
      content: "see https://example.com/x now",
    });
    expect(chooseSendFormat("see https://example.com/x now", false)).toEqual({
      mode: "text",
      content: "see https://example.com/x now",
    });
  });
});

/* ------------------------------------------------------- Telegram rendering */

interface TgCall {
  method: string;
  body: any;
}

function makeTelegram(config = makeConfig({ telegram: { botToken: "t", allowedUsers: new Set() } })) {
  const calls: TgCall[] = [];
  let failSend: ((call: TgCall, index: number) => Response | undefined) | undefined;
  const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
    const method = input.split("/").pop()!;
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body;
    const call = { method, body };
    calls.push(call);
    const rejection = failSend?.(call, calls.length - 1);
    if (rejection) {
      return rejection;
    }
    return new Response(JSON.stringify({ ok: true, result: { message_id: 100 + calls.length } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const adapter = new TelegramChannelAdapter(config, { fetchImpl });
  return { adapter, calls, setFail: (fn: typeof failSend) => (failSend = fn) };
}

describe("Telegram HTML outbound", () => {
  it("sends markdown as parse_mode HTML", async () => {
    const { adapter, calls } = makeTelegram();
    await adapter.sendMessage({
      chatId: "1",
      text: "# Hi\n\n**bold** with `code`",
      markdown: true,
    });
    const send = calls.find((c) => c.method === "sendMessage")!;
    expect(send.body.parse_mode).toBe("HTML");
    expect(send.body.text).toContain("<b>Hi</b>");
    expect(send.body.text).toContain("<b>bold</b>");
    expect(send.body.text).toContain("<code>code</code>");
  });

  it("retries as readable plain text when Telegram rejects entities", async () => {
    const { adapter, calls, setFail } = makeTelegram();
    setFail((call, index) =>
      index === 0 && call.method === "sendMessage"
        ? new Response(
            JSON.stringify({ ok: false, description: "Bad Request: can't parse entities" }),
            { status: 400 },
          )
        : undefined,
    );
    const result = await adapter.sendMessage({
      chatId: "1",
      text: "**bold**",
      markdown: true,
    });
    const sends = calls.filter((c) => c.method === "sendMessage");
    expect(sends).toHaveLength(2);
    expect(sends[0]!.body.parse_mode).toBe("HTML");
    expect(sends[1]!.body.parse_mode).toBeUndefined();
    expect(sends[1]!.body.text).toBe("bold");
    expect(result).toEqual({ messageId: expect.any(String) });
  });

  it("keeps plain outbound messages byte-for-byte unchanged", async () => {
    const { adapter, calls } = makeTelegram();
    await adapter.sendMessage({ chatId: "1", text: "x" });
    expect(calls.find((c) => c.method === "sendMessage")!.body).toEqual({
      chat_id: "1",
      text: "x",
    });
  });

  it("edits with HTML when markdown is requested and falls back on parse errors", async () => {
    const { adapter, calls, setFail } = makeTelegram();
    await adapter.editMessage("1", "10", "**hi**", { markdown: true });
    expect(calls.at(-1)!.body).toMatchObject({
      chat_id: "1",
      message_id: 10,
      parse_mode: "HTML",
      text: "<b>hi</b>",
    });

    setFail((call, index) =>
      index === 1 && call.method === "editMessageText"
        ? new Response(
            JSON.stringify({ ok: false, description: "Bad Request: can't parse entities" }),
            { status: 400 },
          )
        : undefined,
    );
    await adapter.editMessage("1", "10", "**hi**", { markdown: true });
    const edits = calls.filter((c) => c.method === "editMessageText");
    expect(edits.at(-1)!.body).toMatchObject({ chat_id: "1", message_id: 10, text: "hi" });
    expect(edits.at(-1)!.body.parse_mode).toBeUndefined();
  });

  it("keeps the plain edit payload stable", async () => {
    const { adapter, calls } = makeTelegram();
    await adapter.editMessage("1", "10", "updated");
    expect(calls.at(-1)!.body).toEqual({ chat_id: "1", message_id: 10, text: "updated" });
  });

  it("ignores message-is-not-modified and not-found deletes", async () => {
    const { adapter, setFail } = makeTelegram();
    setFail((call) =>
      call.method === "editMessageText"
        ? new Response(
            JSON.stringify({ ok: false, description: "Bad Request: message is not modified" }),
            { status: 400 },
          )
        : call.method === "deleteMessage"
          ? new Response(
              JSON.stringify({ ok: false, description: "Bad Request: message to delete not found" }),
              { status: 400 },
            )
          : undefined,
    );
    await expect(adapter.editMessage("1", "10", "same")).resolves.toBeUndefined();
    await expect(adapter.deleteMessage("1", "10")).resolves.toBeUndefined();
  });

  it("sends deleteMessage with a numeric message id", async () => {
    const { adapter, calls } = makeTelegram();
    await adapter.deleteMessage("9", "42");
    expect(calls.at(-1)).toMatchObject({
      method: "deleteMessage",
      body: { chat_id: "9", message_id: 42 },
    });
  });
});

/* --------------------------------------------------------- Discord & Slack */

class FakeDiscordMessage implements DiscordMessageLike {
  content = "";
  createdTimestamp = Date.now();
  author = { id: "u1", bot: false };
  guild = null;
  mentions = { has: () => false };
  edits: string[] = [];
  deleted = false;
  constructor(readonly id: string, readonly channelId: string) {}
  async edit(content: string) {
    this.edits.push(content);
  }
  async delete() {
    this.deleted = true;
  }
}

class FakeDiscordClient extends EventEmitter {
  user = { id: "bot" };
  sent: Array<Record<string, unknown>> = [];
  messages = new Map<string, FakeDiscordMessage>();
  channel = {
    send: async (payload: Record<string, unknown>) => {
      this.sent.push(payload);
      return { id: `sent-${this.sent.length}` };
    },
    messages: {
      fetch: async (id: string) => this.messages.get(id)!,
    },
  };
  channels = { fetch: async () => this.channel };
  async login() {
    queueMicrotask(() => this.emit("clientReady"));
  }
  async destroy() {}
  isReady() {
    return false;
  }
}

describe("Discord outbound cleanup", () => {
  it("strips IDE file links for markdown messages, edits and deletes", async () => {
    const client = new FakeDiscordClient();
    const message = new FakeDiscordMessage("m1", "chan-1");
    client.messages.set("m1", message);
    const adapter = new DiscordChannelAdapter(
      makeConfig({ discord: { botToken: "d", allowedUsers: new Set(), allowGuilds: true } }),
      {
        clientFactory: () => client as unknown as DiscordClientLike,
        readyTimeoutMs: 100,
      },
    );
    stops.push(() => adapter.stop());
    await adapter.start(() => {});

    await adapter.sendMessage({
      chatId: "chan-1",
      text: "[app.ts](file:///src/app.ts#L2-L4)",
      markdown: true,
    });
    expect(client.sent[0]!.content).toBe("`app.ts:2-4`");

    await adapter.editMessage("chan-1", "m1", "[x](file:///x.ts#L1)", {
      markdown: true,
    });
    expect(message.edits[0]).toBe("`x:1`");

    await adapter.deleteMessage("chan-1", "m1");
    expect(message.deleted).toBe(true);
  });
});

function makeSlackApp() {
  const posts: any[] = [];
  const updates: any[] = [];
  const deletes: any[] = [];
  const app: SlackAppLike = {
    event() {},
    async start() {},
    async stop() {},
    client: {
      auth: { test: async () => ({ user_id: "UBOT" }) },
      chat: {
        postMessage: async (args: any) => {
          posts.push(args);
          return { ts: `ts-${posts.length}` };
        },
        update: async (args: any) => void updates.push(args),
        delete: async (args: any) => void deletes.push(args),
      },
      reactions: { add: async () => undefined },
    },
  };
  return { app, posts, updates, deletes };
}

describe("Slack outbound cleanup", () => {
  it("strips IDE links for markdown sends and edits and deletes via chat.delete", async () => {
    const { app, posts, updates, deletes } = makeSlackApp();
    const adapter = new SlackChannelAdapter(
      makeConfig({
        slack: { botToken: "s", appToken: "a", allowedUsers: new Set() },
      }),
      { appFactory: () => app },
    );
    stops.push(() => adapter.stop());
    await adapter.start(() => {});

    await adapter.sendMessage({
      chatId: "C1",
      text: "[app.ts](file:///src/app.ts#L9-L10)",
      markdown: true,
    });
    expect(posts[0]!.text).toBe("`app.ts:9-10`");

    await adapter.editMessage("C1", "1.1", "[x](file:///x.ts#L3)", {
      markdown: true,
    });
    expect(updates[0]!.text).toBe("`x:3`");

    await adapter.deleteMessage("C1", "1.1");
    expect(deletes).toEqual([{ token: "s", channel: "C1", ts: "1.1" }]);
  });
});

/* ------------------------------------------------------ plain-text adapters */

class FakeIrcSocket extends EventEmitter implements IrcSocketLike {
  written: string[] = [];
  write(data: string): boolean {
    this.written.push(data);
    return true;
  }
  end(): void {
    this.emit("close");
  }
  destroy(): void {
    this.emit("close");
  }
  feed(data: string): void {
    this.emit("data", Buffer.from(data));
  }
}

async function startIrc() {
  const sockets: FakeIrcSocket[] = [];
  const factory: IrcSocketFactory = () => {
    const socket = new FakeIrcSocket();
    sockets.push(socket);
    queueMicrotask(() => socket.emit("connect"));
    return socket;
  };
  const adapter = new IrcChannelAdapter(
    makeConfig({
      irc: {
        host: "irc.test.invalid",
        port: 6667,
        tls: false,
        nick: "agy",
        channels: ["#general"],
        allowedUsers: new Set(),
      },
    }),
    { socketFactory: factory, reconnectDelay: () => 5, startupTimeoutMs: 100 },
  );
  stops.push(() => adapter.stop());
  await adapter.start(() => {});
  return { adapter, socket: sockets[0]! };
}

describe("IRC outbound readable text", () => {
  it("renders markdown as readable text only when requested", async () => {
    const { adapter, socket } = await startIrc();
    await adapter.sendMessage({ chatId: "#general", text: "**bold**", markdown: true });
    const privmsg = socket.written.find((line) => line.startsWith("PRIVMSG"));
    expect(privmsg).toBe("PRIVMSG #general :bold\r\n");

    await adapter.sendMessage({ chatId: "#general", text: "**raw**" });
    expect(socket.written.at(-1)).toBe("PRIVMSG #general :**raw**\r\n");
  });
});

describe("LINE outbound readable text", () => {
  it("renders markdown to plain text when markdown is requested", async () => {
    const bodies: any[] = [];
    const fetchImpl = async (_input: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ sentMessages: [{ id: "m1" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const adapter = new LineChannelAdapter(
      makeConfig({
        line: {
          channelAccessToken: "line-token",
          channelSecret: "line-secret",
          host: "127.0.0.1",
          port: 0,
          allowedUsers: new Set(),
        },
      }),
      { fetchImpl: fetchImpl as typeof fetch },
    );
    await adapter.sendMessage({ chatId: "U1", text: "## Title\n\n**bold**", markdown: true });
    expect(bodies[0].messages[0]).toEqual({ type: "text", text: "【Title】\n\nbold" });
  });
});

describe("Signal outbound readable text", () => {
  it("renders markdown to plain text when markdown is requested", async () => {
    const bodies: any[] = [];
    const fetchImpl = async (_input: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ timestamp: 1 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const config = makeConfig() as GatewayConfig & { signal?: SignalConfig };
    config.signal = {
      enabled: true,
      apiUrl: "http://signal.test",
      account: "+15550000001",
      pollIntervalMs: 10,
    };
    const adapter = new SignalChannelAdapter(config, {
      fetchImpl: fetchImpl as typeof fetch,
    });
    await adapter.sendMessage({ chatId: "+15550000002", text: "~~gone~~", markdown: true });
    expect(bodies[0].message).toBe("gone");
  });
});

describe("OneBot outbound readable text", () => {
  it("renders markdown to plain text when markdown is requested", async () => {
    const adapter = new OneBotChannelAdapter(
      makeConfig({
        onebot: { wsUrl: "ws://onebot.test", allowedUsers: new Set() },
      }),
    );
    const sent: any[] = [];
    const socket = {
      readyState: 1,
      send(data: string) {
        const frame = JSON.parse(data);
        sent.push(frame.params.message);
        queueMicrotask(() => {
          void adapter.handleFrame(
            JSON.stringify({ echo: frame.echo, status: "ok", retcode: 0, data: { message_id: 7 } }),
          );
        });
      },
      close() {},
      addEventListener() {},
    };
    (adapter as unknown as { socket: unknown }).socket = socket;

    await adapter.sendMessage({ chatId: "private:1", text: "# Head\n\n**bold**", markdown: true });
    expect(sent[0]).toEqual([{ type: "text", data: { text: "【Head】\n\nbold" } }]);
  });
});