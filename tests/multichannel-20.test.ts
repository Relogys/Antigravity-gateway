import { describe, expect, it, vi } from "vitest";
import {
  MultiChannelHub,
  qualifyChatId,
  splitQualifiedChatId,
} from "../src/channels/hub.js";
import { createEnabledAdapters } from "../src/channels/registry.js";
import {
  CHANNEL_NAMES,
  getChannelAllowedUsers,
  getEnabledChannelNames,
  loadConfig,
} from "../src/config.js";
import type { ChannelAdapter, InboundMessage, OutboundMessage } from "../src/types.js";

// The hub exports the parser as `splitQualifiedChatId`; alias mirrors the
// qualify/parse round-trip intent used throughout the gateway.
const parseQualifiedChatId = splitQualifiedChatId;

/** Every channel except Photon has a per-channel `*_ALLOWED_USERS` allowlist. */
const NON_PHOTON_CHANNELS = CHANNEL_NAMES.filter((name) => name !== "photon");

/** Distinct allowlist entry per channel so isolation failures are obvious. */
const ALLOWED_USER_BY_CHANNEL: Record<(typeof NON_PHOTON_CHANNELS)[number], string> = {
  telegram: "tg-alpha",
  discord: "dc-bravo",
  slack: "sl-charlie",
  feishu: "fs-delta",
  dingtalk: "dt-echo",
  onebot: "ob-foxtrot",
  webhook: "wh-golf",
  wecom: "wc-hotel",
  qqbot: "qq-india",
  matrix: "mx-juliet",
  mattermost: "mm-kilo",
  line: "ln-lima",
  irc: "ir-mike",
  whatsapp: "wa-november",
  zulip: "zu-oscar",
  rocketchat: "rc-papa",
  signal: "sg-quebec",
  teams: "tm-romeo",
  googlechat: "gc-sierra",
};

/** Representative raw chat ids, deliberately full of colons and punctuation. */
const RAW_CHAT_ID_BY_CHANNEL: Record<(typeof CHANNEL_NAMES)[number], string> = {
  photon: "any;-;user@example.org",
  telegram: "123456789",
  discord: "987654321098765432",
  slack: "C0123456789:thread_1",
  feishu: "oc_abc:def",
  dingtalk: "conversation:1",
  onebot: "group_12345",
  webhook: "conversation:001",
  wecom: "user:alpha",
  qqbot: "group:openid-1",
  matrix: "!room:example.org",
  mattermost: "channel:id:1",
  line: "U1234567890abcdef:thread",
  irc: "#general",
  whatsapp: "wamid:test-message",
  zulip: "stream:eng:topic",
  rocketchat: "room:GENERAL",
  signal: "group:abc=",
  teams: "19:abc@thread.v2",
  googlechat: "spaces/AAA",
};

/** Minimal dummy environment that enables all 20 channels (no real secrets). */
function fullEnv(): Record<string, string> {
  return {
    SPECTRUM_PROJECT_ID: "test-spectrum-project-id",
    SPECTRUM_PROJECT_SECRET: "test-spectrum-project-secret",

    TELEGRAM_BOT_TOKEN: "test-telegram-bot-token",
    TELEGRAM_ALLOWED_USERS: ALLOWED_USER_BY_CHANNEL.telegram,

    DISCORD_BOT_TOKEN: "test-discord-bot-token",
    DISCORD_ALLOWED_USERS: ALLOWED_USER_BY_CHANNEL.discord,

    SLACK_BOT_TOKEN: "test-slack-bot-token",
    SLACK_APP_TOKEN: "test-slack-app-token",
    SLACK_ALLOWED_USERS: ALLOWED_USER_BY_CHANNEL.slack,

    FEISHU_APP_ID: "test-feishu-app-id",
    FEISHU_APP_SECRET: "test-feishu-app-secret",
    FEISHU_ALLOWED_USERS: ALLOWED_USER_BY_CHANNEL.feishu,

    DINGTALK_CLIENT_ID: "test-dingtalk-client-id",
    DINGTALK_CLIENT_SECRET: "test-dingtalk-client-secret",
    DINGTALK_ALLOWED_USERS: ALLOWED_USER_BY_CHANNEL.dingtalk,

    ONEBOT_WS_URL: "ws://127.0.0.1:3001",
    ONEBOT_ALLOWED_USERS: ALLOWED_USER_BY_CHANNEL.onebot,

    WEBHOOK_ENABLED: "true",
    WEBHOOK_TOKEN: "test-webhook-token",
    WEBHOOK_ALLOWED_USERS: ALLOWED_USER_BY_CHANNEL.webhook,

    WECOM_CORP_ID: "test-wecom-corp-id",
    WECOM_AGENT_ID: "1000002",
    WECOM_SECRET: "test-wecom-secret",
    WECOM_ALLOWED_USERS: ALLOWED_USER_BY_CHANNEL.wecom,

    QQBOT_APP_ID: "test-qqbot-app-id",
    QQBOT_CLIENT_SECRET: "test-qqbot-client-secret",
    QQBOT_ALLOWED_USERS: ALLOWED_USER_BY_CHANNEL.qqbot,

    MATRIX_HOMESERVER_URL: "https://matrix.example.org",
    MATRIX_ACCESS_TOKEN: "test-matrix-access-token",
    MATRIX_ALLOWED_USERS: ALLOWED_USER_BY_CHANNEL.matrix,

    MATTERMOST_BASE_URL: "https://mattermost.example.org",
    MATTERMOST_BOT_TOKEN: "test-mattermost-bot-token",
    MATTERMOST_ALLOWED_USERS: ALLOWED_USER_BY_CHANNEL.mattermost,

    LINE_CHANNEL_ACCESS_TOKEN: "test-line-access-token",
    LINE_CHANNEL_SECRET: "test-line-channel-secret",
    LINE_ALLOWED_USERS: ALLOWED_USER_BY_CHANNEL.line,

    IRC_HOST: "irc.example.org",
    IRC_ALLOWED_USERS: ALLOWED_USER_BY_CHANNEL.irc,

    WHATSAPP_ACCESS_TOKEN: "test-whatsapp-access-token",
    WHATSAPP_PHONE_NUMBER_ID: "test-whatsapp-phone-id",
    WHATSAPP_ALLOWED_USERS: ALLOWED_USER_BY_CHANNEL.whatsapp,

    ZULIP_SITE: "https://zulip.example.org",
    ZULIP_BOT_EMAIL: "bot@example.org",
    ZULIP_API_KEY: "test-zulip-api-key",
    ZULIP_ALLOWED_USERS: ALLOWED_USER_BY_CHANNEL.zulip,

    ROCKETCHAT_URL: "https://rocketchat.example.org",
    ROCKETCHAT_USER_ID: "test-rocketchat-user-id",
    ROCKETCHAT_AUTH_TOKEN: "test-rocketchat-auth-token",
    ROCKETCHAT_ALLOWED_USERS: ALLOWED_USER_BY_CHANNEL.rocketchat,

    SIGNAL_API_URL: "http://127.0.0.1:8080",
    SIGNAL_ACCOUNT: "signal-test-account",
    SIGNAL_ALLOWED_USERS: ALLOWED_USER_BY_CHANNEL.signal,

    TEAMS_WEBHOOK_SECRET: "test-teams-webhook-secret",
    TEAMS_ALLOWED_USERS: ALLOWED_USER_BY_CHANNEL.teams,

    GOOGLECHAT_WEBHOOK_URL: "https://chat.googleapis.com/v1/spaces/test/messages",
    GOOGLECHAT_ALLOWED_USERS: ALLOWED_USER_BY_CHANNEL.googlechat,
  };
}

function loadDummyConfig(overrides: Record<string, string> = {}) {
  return loadConfig({ ...fullEnv(), ...overrides }, { loadDotenv: false });
}

class FakeAdapter implements ChannelAdapter {
  connected = false;
  sent: OutboundMessage[] = [];
  typing: Array<{ chatId: string; active: boolean }> = [];
  reactions: string[] = [];
  edits: string[] = [];
  handler?: (msg: InboundMessage) => Promise<void> | void;

  constructor(readonly name: string) {}

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

  async sendTyping(chatId: string, active: boolean): Promise<void> {
    this.typing.push({ chatId, active });
  }

  async react(chatId: string, messageId: string, emoji: string): Promise<void> {
    this.reactions.push(`${chatId}|${messageId}|${emoji}`);
  }

  async editMessage(chatId: string, messageId: string, text: string): Promise<void> {
    this.edits.push(`${chatId}|${messageId}|${text}`);
  }
}

function makeInbound(
  channel: string,
  overrides: Partial<InboundMessage> = {},
): InboundMessage {
  return {
    id: `msg-${channel}-${Math.random().toString(36).slice(2, 8)}`,
    channel,
    chatId: "raw-chat",
    senderId: "sender-1",
    isGroup: false,
    text: "hello",
    attachments: [],
    timestamp: Date.now(),
    mentionsBot: true,
    ...overrides,
  };
}

describe("canonical channel names", () => {
  it("lists exactly 20 unique, prefix-safe channel names", () => {
    expect(CHANNEL_NAMES).toHaveLength(20);
    expect(new Set(CHANNEL_NAMES).size).toBe(20);
    expect(CHANNEL_NAMES.every((name) => /^[a-z][a-z0-9_-]*$/.test(name))).toBe(true);
    expect(CHANNEL_NAMES).toEqual(
      expect.arrayContaining(["whatsapp", "zulip", "rocketchat", "signal", "teams", "googlechat"]),
    );
  });
});

describe("config enables all 20 channels", () => {
  it("enables every channel when valid dummy credentials are present", () => {
    const config = loadDummyConfig();
    const enabled = getEnabledChannelNames(config);

    expect(enabled).toHaveLength(20);
    expect(enabled).toEqual([...CHANNEL_NAMES]);
    for (const name of CHANNEL_NAMES) {
      expect(enabled).toContain(name);
    }
  });

  it("ignores blank strings and your-... placeholders", () => {
    const config = loadDummyConfig({
      TELEGRAM_BOT_TOKEN: "",
      DISCORD_BOT_TOKEN: "   ",
      SLACK_BOT_TOKEN: "your-slack-bot-token",
      SLACK_APP_TOKEN: "your-slack-app-token",
      FEISHU_APP_ID: "your-feishu-app-id",
      FEISHU_APP_SECRET: "your-feishu-app-secret",
      ONEBOT_WS_URL: "your-onebot-ws-url",
      ZULIP_SITE: "your-zulip-site",
      WHATSAPP_PHONE_NUMBER_ID: "",
    });

    expect(getEnabledChannelNames(config)).toEqual([
      "photon",
      "dingtalk",
      "webhook",
      "wecom",
      "qqbot",
      "matrix",
      "mattermost",
      "line",
      "irc",
      "rocketchat",
      "signal",
      "teams",
      "googlechat",
    ]);
  });

  it("treats placeholders case-insensitively", () => {
    const config = loadConfig(
      {
        TELEGRAM_BOT_TOKEN: "YOUR-telegram-bot-token",
        DISCORD_BOT_TOKEN: "Your-discord-bot-token",
      },
      { loadDotenv: false },
    );
    expect(getEnabledChannelNames(config)).toEqual([]);
  });

  it("keeps channels disabled until their full credential pair is present", () => {
    const config = loadConfig(
      {
        SLACK_BOT_TOKEN: "test-slack-bot-token",
        MATRIX_HOMESERVER_URL: "https://matrix.example.org",
        WECOM_CORP_ID: "test-wecom-corp-id",
        ROCKETCHAT_URL: "https://rocketchat.example.org",
        TEAMS_APP_ID: "test-teams-app-id",
      },
      { loadDotenv: false },
    );
    expect(getEnabledChannelNames(config)).toEqual([]);
  });
});

describe("createEnabledAdapters", () => {
  it("instantiates all 20 adapters with zero errors and matching names", async () => {
    const config = loadDummyConfig();
    const { adapters, errors } = await createEnabledAdapters(config);

    expect(errors).toEqual({});
    expect(adapters).toHaveLength(20);
    expect(adapters.map((adapter) => adapter.name)).toEqual([...CHANNEL_NAMES]);
    for (const adapter of adapters) {
      expect(adapter.isConnected()).toBe(false);
    }
  }, 30_000);

  it("honors the optional channel filter", async () => {
    const config = loadDummyConfig();
    const { adapters, errors } = await createEnabledAdapters(config, ["zulip", "signal"]);

    expect(errors).toEqual({});
    expect(adapters.map((adapter) => adapter.name)).toEqual(["zulip", "signal"]);
  });

  it("returns nothing when no channel is configured", async () => {
    const config = loadConfig({}, { loadDotenv: false });
    const { adapters, errors } = await createEnabledAdapters(config);
    expect(adapters).toEqual([]);
    expect(errors).toEqual({});
  });
});

describe("per-channel allowlist isolation", () => {
  it("keeps each non-photon allowlist separate across all 19 channels", () => {
    const config = loadDummyConfig();

    expect(NON_PHOTON_CHANNELS).toHaveLength(19);
    for (const channel of NON_PHOTON_CHANNELS) {
      const users = [...getChannelAllowedUsers(config, channel)];
      expect(users, channel).toEqual([ALLOWED_USER_BY_CHANNEL[channel]]);
    }

    for (const source of NON_PHOTON_CHANNELS) {
      const leaked = ALLOWED_USER_BY_CHANNEL[source];
      for (const target of NON_PHOTON_CHANNELS) {
        if (source === target) {
          continue;
        }
        expect(
          getChannelAllowedUsers(config, target).has(leaked),
          `${source} entry leaked into ${target}`,
        ).toBe(false);
      }
    }
  });

  it("covers the six newly added channels explicitly", () => {
    const config = loadDummyConfig();
    for (const channel of ["whatsapp", "zulip", "rocketchat", "signal", "teams", "googlechat"] as const) {
      expect([...getChannelAllowedUsers(config, channel)]).toEqual([
        ALLOWED_USER_BY_CHANNEL[channel],
      ]);
    }
  });

  it("returns an empty set for photon, unknown channels, and unconfigured channels", () => {
    const config = loadDummyConfig();
    expect(getChannelAllowedUsers(config, "photon").size).toBe(0);
    expect(getChannelAllowedUsers(config, "unknown").size).toBe(0);

    const empty = loadConfig({}, { loadDotenv: false });
    for (const channel of CHANNEL_NAMES) {
      expect(getChannelAllowedUsers(empty, channel).size).toBe(0);
    }
  });

  it("normalizes case and whitespace and drops blank entries", () => {
    const config = loadConfig(
      {
        TELEGRAM_BOT_TOKEN: "test-telegram-bot-token",
        TELEGRAM_ALLOWED_USERS: "  TG-Alpha , , tg-Beta  ",
      },
      { loadDotenv: false },
    );
    expect([...getChannelAllowedUsers(config, "telegram")].sort()).toEqual([
      "tg-alpha",
      "tg-beta",
    ]);
  });
});

describe("qualified chat ids", () => {
  it("round-trips every channel including colon-bearing raw ids", () => {
    for (const channel of CHANNEL_NAMES) {
      const rawChatId = RAW_CHAT_ID_BY_CHANNEL[channel];
      const qualified = qualifyChatId(channel, rawChatId);

      expect(qualified).toBe(`${channel}::${rawChatId}`);
      expect(parseQualifiedChatId(qualified)).toEqual({ channel, chatId: rawChatId });
    }
  });

  it("preserves platform-specific colon formats verbatim", () => {
    const cases: Array<[string, string]> = [
      ["matrix", "!room:example.org"],
      ["zulip", "stream:eng:topic"],
      ["signal", "group:abc="],
      ["googlechat", "spaces/AAA"],
      ["teams", "19:abc@thread.v2"],
    ];

    for (const [channel, rawChatId] of cases) {
      const parsed = parseQualifiedChatId(qualifyChatId(channel, rawChatId));
      expect(parsed).toEqual({ channel, chatId: rawChatId });
      expect(parsed.chatId).toBe(rawChatId);
    }
  });

  it("preserves raw ids that themselves contain the separator", () => {
    const rawChatId = "weird::raw::id";
    expect(parseQualifiedChatId(qualifyChatId("zulip", rawChatId))).toEqual({
      channel: "zulip",
      chatId: rawChatId,
    });
  });

  it("leaves unqualified or invalid-prefix ids untouched", () => {
    expect(parseQualifiedChatId("plain-chat")).toEqual({ chatId: "plain-chat" });
    expect(parseQualifiedChatId("Bad Prefix::x")).toEqual({ chatId: "Bad Prefix::x" });
    expect(parseQualifiedChatId("::leading")).toEqual({ chatId: "::leading" });
    expect(parseQualifiedChatId("stream:eng:topic")).toEqual({ chatId: "stream:eng:topic" });
  });
});

describe("MultiChannelHub dispatch", () => {
  function buildHub(...names: string[]) {
    const adapters = Object.fromEntries(
      names.map((name) => [name, new FakeAdapter(name)]),
    ) as Record<string, FakeAdapter>;
    const hub = new MultiChannelHub(Object.values(adapters), { log: () => {} });
    return { adapters, hub };
  }

  it("sends outbound messages to the exact owning adapter", async () => {
    const { adapters, hub } = buildHub("telegram", "zulip", "teams", "googlechat");
    await hub.start(() => {});

    await hub.sendMessage({ chatId: qualifyChatId("zulip", "stream:eng:topic"), text: "hi zulip" });
    await hub.sendMessage({ chatId: qualifyChatId("teams", "19:abc@thread.v2"), text: "hi teams" });
    await hub.sendMessage({ chatId: qualifyChatId("googlechat", "spaces/AAA"), text: "hi googlechat" });
    await hub.sendMessage({ chatId: qualifyChatId("telegram", "123456789"), text: "hi telegram" });

    expect(adapters.zulip.sent).toEqual([{ chatId: "stream:eng:topic", text: "hi zulip" }]);
    expect(adapters.teams.sent).toEqual([{ chatId: "19:abc@thread.v2", text: "hi teams" }]);
    expect(adapters.googlechat.sent).toEqual([{ chatId: "spaces/AAA", text: "hi googlechat" }]);
    expect(adapters.telegram.sent).toEqual([{ chatId: "123456789", text: "hi telegram" }]);

    const total = Object.values(adapters).reduce((sum, adapter) => sum + adapter.sent.length, 0);
    expect(total).toBe(4);
  });

  it("routes auxiliary outbound operations to the owning adapter only", async () => {
    const { adapters, hub } = buildHub("zulip", "teams", "googlechat");
    await hub.start(() => {});

    await hub.sendTyping(qualifyChatId("zulip", "stream:eng:topic"), true);
    await hub.react(qualifyChatId("teams", "19:abc@thread.v2"), "activity-1", "👍");
    await hub.editMessage(qualifyChatId("googlechat", "spaces/AAA"), "msg-1", "edited");

    expect(adapters.zulip.typing).toEqual([{ chatId: "stream:eng:topic", active: true }]);
    expect(adapters.teams.reactions).toEqual(["19:abc@thread.v2|activity-1|👍"]);
    expect(adapters.googlechat.edits).toEqual(["spaces/AAA|msg-1|edited"]);

    expect(adapters.teams.typing).toEqual([]);
    expect(adapters.zulip.reactions).toEqual([]);
    expect(adapters.teams.edits).toEqual([]);
  });

  it("emits inbound messages with qualified chat ids and the adapter name", async () => {
    const { adapters, hub } = buildHub("zulip", "teams");
    const received: InboundMessage[] = [];
    await hub.start((msg) => {
      received.push(msg);
    });

    adapters.zulip.handler?.(
      makeInbound("zulip", { chatId: "stream:eng:topic", senderId: "zu-oscar" }),
    );
    adapters.teams.handler?.(
      makeInbound("teams", { chatId: "19:abc@thread.v2", senderId: "tm-romeo" }),
    );

    await vi.waitFor(() => expect(received).toHaveLength(2));

    const byChannel = new Map(received.map((msg) => [msg.channel, msg]));
    expect(byChannel.get("zulip")?.chatId).toBe("zulip::stream:eng:topic");
    expect(byChannel.get("zulip")?.senderId).toBe("zu-oscar");
    expect(byChannel.get("teams")?.chatId).toBe("teams::19:abc@thread.v2");
    expect(byChannel.get("teams")?.senderId).toBe("tm-romeo");

    for (const msg of received) {
      expect(parseQualifiedChatId(msg.chatId)).toEqual({
        channel: msg.channel,
        chatId: RAW_CHAT_ID_BY_CHANNEL[msg.channel as keyof typeof RAW_CHAT_ID_BY_CHANNEL],
      });
    }
  });

  it("uses the only adapter or defaultChannel for unqualified ids", async () => {
    const solo = new FakeAdapter("telegram");
    const soloHub = new MultiChannelHub([solo], { log: () => {} });
    await soloHub.start(() => {});
    await soloHub.sendMessage({ chatId: "raw:with:colons", text: "solo" });
    expect(solo.sent[0]?.chatId).toBe("raw:with:colons");

    const zulip = new FakeAdapter("zulip");
    const telegram = new FakeAdapter("telegram");
    const hub = new MultiChannelHub([zulip, telegram], {
      defaultChannel: "telegram",
      log: () => {},
    });
    await hub.start(() => {});
    await hub.sendMessage({ chatId: "raw:with:colons", text: "default" });
    expect(telegram.sent[0]?.chatId).toBe("raw:with:colons");
    expect(zulip.sent).toHaveLength(0);
  });

  it("rejects ambiguous unqualified ids and unknown channel prefixes", async () => {
    const { hub } = buildHub("telegram", "zulip");
    await hub.start(() => {});

    await expect(hub.sendMessage({ chatId: "no-prefix", text: "x" })).rejects.toThrow(
      /Cannot route/,
    );
    await expect(
      hub.sendMessage({ chatId: qualifyChatId("matrix", "!room:example.org"), text: "x" }),
    ).rejects.toThrow(/Unknown channel/);
  });
});