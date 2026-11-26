import type { GatewayConfig, ZulipConfig } from "../config.js";
import type { ChannelAdapter, InboundMessage, OutboundMessage } from "../types.js";
import { BaseChannelAdapter, type InboundHandler } from "./base.js";
import {
  BoundedDedupeCache,
  chunkText,
  isMentioned,
  reconnectDelayMs,
  sleepWithAbort,
} from "./utils.js";

const ZULIP_TEXT_LIMIT = 9000;
const ZULIP_DEFAULT_TOPIC = "general";

export interface ZulipAdapterOptions {
  fetchImpl?: typeof fetch;
}

interface ZulipRegisterResponse {
  result?: string;
  msg?: string;
  code?: string;
  queue_id?: string;
  last_event_id?: number;
  full_name?: string;
  user_id?: number;
}

interface ZulipMessageEvent {
  id?: number;
  type?: string;
  sender_email?: string;
  sender_full_name?: string;
  display_recipient?: string | { email?: string }[];
  subject?: string;
  content?: string;
  timestamp?: number;
}

interface ZulipEvent {
  type?: string;
  message?: ZulipMessageEvent;
}

interface ZulipEventsResponse {
  result?: string;
  msg?: string;
  code?: string;
  events?: ZulipEvent[];
  last_event_id?: number;
}

interface ZulipSendResponse {
  result?: string;
  msg?: string;
  id?: number;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Zulip adapter backed by the Real-Time Events API (register + long-poll events),
 * so it works behind NAT without inbound webhooks.
 */
export class ZulipChannelAdapter extends BaseChannelAdapter {
  readonly name = "zulip";

  private readonly cfg: ZulipConfig;
  private readonly fetchImpl: typeof fetch;
  private readonly groupMentionPatterns: string[];
  private readonly dedupe = new BoundedDedupeCache();

  private botFullName = "";
  private queueId?: string;
  private lastEventId = -1;
  private stopped = false;
  private lifecycle = new AbortController();
  private pollLoop?: Promise<void>;

  constructor(config: GatewayConfig, options: ZulipAdapterOptions = {}) {
    super();
    if (!config.zulip) {
      throw new Error("Zulip adapter requires config.zulip");
    }
    this.cfg = config.zulip;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.groupMentionPatterns = [...config.groupMentionPatterns];
  }

  async start(onMessage: InboundHandler): Promise<void> {
    this.handler = onMessage;
    this.stopped = false;
    this.lifecycle = new AbortController();
    try {
      await this.register();
    } catch (err) {
      this.noteError(err);
    }
    this.pollLoop = this.runEventLoop();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.lifecycle.abort();
    void this.pollLoop?.catch(() => undefined);
    this.pollLoop = undefined;
    this.queueId = undefined;
    this.dedupe.clear();
    this.handler = undefined;
    this.setConnected(false);
  }

  async sendMessage(msg: OutboundMessage): Promise<{ messageId?: string }> {
    let messageId: string | undefined;
    for (const chunk of chunkText(msg.text ?? "", ZULIP_TEXT_LIMIT)) {
      const res = await this.fetchImpl(`${this.siteUrl()}/api/v1/messages`, {
        method: "POST",
        headers: this.authHeaders({ "Content-Type": "application/x-www-form-urlencoded" }),
        body: this.buildSendFields(msg.chatId, chunk),
      });
      if (!res.ok) {
        throw new Error(`Zulip send failed with HTTP ${res.status}`);
      }
      const body = (await res.json().catch(() => ({}))) as ZulipSendResponse;
      if (body.result === "error") {
        throw new Error(`Zulip send failed: ${body.msg ?? "unknown error"}`);
      }
      if (typeof body.id === "number") {
        messageId = String(body.id);
      }
    }

    this.noteOutbound();
    return { messageId };
  }

  private async register(): Promise<void> {
    const body = new URLSearchParams();
    body.set("event_types", JSON.stringify(["message"]));
    if (this.cfg.streams.length > 0) {
      body.set(
        "narrow",
        JSON.stringify(
          this.cfg.streams.map((stream) => ({ operator: "stream", operand: stream })),
        ),
      );
    }

    const res = await this.fetchImpl(`${this.siteUrl()}/api/v1/register`, {
      method: "POST",
      headers: this.authHeaders({ "Content-Type": "application/x-www-form-urlencoded" }),
      body,
    });
    if (!res.ok) {
      throw new Error(`Zulip register failed with HTTP ${res.status}`);
    }
    const parsed = (await res.json()) as ZulipRegisterResponse;
    if (parsed.result !== "success" || !parsed.queue_id) {
      throw new Error(`Zulip register failed: ${parsed.msg ?? parsed.code ?? "unknown error"}`);
    }

    this.queueId = parsed.queue_id;
    this.lastEventId = typeof parsed.last_event_id === "number" ? parsed.last_event_id : -1;
    if (typeof parsed.full_name === "string" && parsed.full_name.trim()) {
      this.botFullName = parsed.full_name.trim();
    }
    this.setConnected(true);
  }

  private async runEventLoop(): Promise<void> {
    const signal = this.lifecycle.signal;
    let attempt = 0;

    while (!this.stopped) {
      try {
        if (!this.queueId) {
          await this.register();
        }
        const queueId = this.queueId;
        if (!queueId) {
          throw new Error("Zulip event queue unavailable");
        }

        const params = new URLSearchParams({
          queue_id: queueId,
          last_event_id: String(this.lastEventId),
        });
        const res = await this.fetchImpl(
          `${this.siteUrl()}/api/v1/events?${params.toString()}`,
          { headers: this.authHeaders(), signal },
        );
        if (!res.ok) {
          const failure = (await res.json().catch(() => ({}))) as ZulipEventsResponse;
          if (failure.code === "BAD_EVENT_QUEUE_ID") {
            this.queueId = undefined;
            continue;
          }
          throw new Error(`Zulip events failed with HTTP ${res.status}`);
        }

        const body = (await res.json()) as ZulipEventsResponse;
        if (body.result === "error" || body.code) {
          if (body.code === "BAD_EVENT_QUEUE_ID") {
            this.queueId = undefined;
            continue;
          }
          throw new Error(`Zulip events failed: ${body.msg ?? body.code ?? "unknown error"}`);
        }

        this.setConnected(true);
        attempt = 0;
        if (typeof body.last_event_id === "number") {
          this.lastEventId = body.last_event_id;
        }
        for (const event of body.events ?? []) {
          if (this.stopped) {
            break;
          }
          if (event.type !== "message" || !event.message) {
            continue;
          }
          await this.handleMessageEvent(event.message);
        }
      } catch (err) {
        if (this.stopped) {
          break;
        }
        this.setConnected(false);
        this.noteError(err);
        await sleepWithAbort(reconnectDelayMs(attempt), signal);
        attempt += 1;
      }
    }
  }

  private async handleMessageEvent(message: ZulipMessageEvent): Promise<void> {
    if (typeof message.id !== "number") {
      return;
    }
    const senderEmail = (message.sender_email ?? "").trim();
    if (!senderEmail) {
      return;
    }
    if (senderEmail.toLowerCase() === this.cfg.botEmail.toLowerCase()) {
      return;
    }
    const id = String(message.id);
    if (this.dedupe.seen(id)) {
      return;
    }

    const isStream = message.type === "stream";
    let chatId: string;
    if (isStream) {
      const stream =
        typeof message.display_recipient === "string" ? message.display_recipient : "";
      if (!stream) {
        return;
      }
      chatId = `stream:${stream}:${message.subject ?? ""}`;
    } else {
      chatId = `pm:${senderEmail}`;
    }

    let text = message.content ?? "";
    const mentioned = this.mentionsBot(text);
    if (isStream && this.cfg.requireMention && !mentioned) {
      return;
    }
    if (isStream) {
      text = this.stripMention(text);
    }

    // Zulip message timestamps are Unix seconds.
    const timestamp = typeof message.timestamp === "number" ? message.timestamp * 1000 : Date.now();

    const inbound: InboundMessage = {
      id,
      channel: this.name,
      chatId,
      senderId: senderEmail,
      rawSenderId: senderEmail,
      isGroup: isStream,
      text,
      attachments: [],
      timestamp,
      mentionsBot: mentioned,
      raw: message,
    };
    await this.emit(inbound);
  }

  private mentionsBot(text: string): boolean {
    if (!text) {
      return false;
    }
    if (/@\*\*[^*]+\*\*/.test(text)) {
      return true;
    }
    return isMentioned(text, this.mentionPatterns());
  }

  private mentionPatterns(): string[] {
    const patterns = [...this.groupMentionPatterns];
    if (this.cfg.botEmail) {
      const localpart = this.cfg.botEmail.split("@")[0] ?? "";
      patterns.push(this.cfg.botEmail, `@${this.cfg.botEmail}`);
      if (localpart) {
        patterns.push(localpart, `@${localpart}`);
      }
    }
    if (this.botFullName) {
      patterns.push(this.botFullName, `@${this.botFullName}`);
    }
    return patterns;
  }

  private stripMention(text: string): string {
    const botNames = [this.cfg.botEmail, this.botFullName]
      .filter((name) => name.length > 0)
      .map((name) => name.toLowerCase());

    let out = text.replace(/@\*\*([^*]+)\*\*/g, (match, inner: string) => {
      const name = (inner.split("|")[0] ?? "").trim().toLowerCase();
      return botNames.includes(name) ? "" : match;
    });

    for (const name of [this.cfg.botEmail, this.botFullName]) {
      if (!name) {
        continue;
      }
      out = out.replace(new RegExp(`@${escapeRegExp(name)}`, "gi"), "");
    }

    return out.replace(/\s{2,}/g, " ").trim();
  }

  private buildSendFields(chatId: string, content: string): URLSearchParams {
    const fields = new URLSearchParams();
    fields.set("content", content);
    if (chatId.startsWith("stream:")) {
      const rest = chatId.slice("stream:".length);
      const sep = rest.indexOf(":");
      const stream = sep === -1 ? rest : rest.slice(0, sep);
      const topic = sep === -1 ? "" : rest.slice(sep + 1);
      fields.set("type", "stream");
      fields.set("to", stream);
      fields.set("topic", topic || ZULIP_DEFAULT_TOPIC);
    } else {
      const recipient = chatId.startsWith("pm:") ? chatId.slice("pm:".length) : chatId;
      fields.set("type", "direct");
      fields.set("to", JSON.stringify([recipient]));
    }
    return fields;
  }

  private authHeaders(extra: Record<string, string> = {}): Record<string, string> {
    const token = Buffer.from(`${this.cfg.botEmail}:${this.cfg.apiKey}`).toString("base64");
    return { Authorization: `Basic ${token}`, ...extra };
  }

  private siteUrl(): string {
    return this.cfg.site.replace(/\/+$/, "");
  }
}

export function createAdapter(config: GatewayConfig): ChannelAdapter {
  return new ZulipChannelAdapter(config);
}