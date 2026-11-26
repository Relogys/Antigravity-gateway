import path from "node:path";
import type { GatewayConfig } from "../config.js";
import type { ChannelAdapter, InboundAttachment, OutboundMessage } from "../types.js";
import { BaseChannelAdapter, type InboundHandler } from "./base.js";
import {
  BoundedDedupeCache,
  chunkText,
  errorMessage,
  isMentioned,
  MAX_INLINE_MEDIA_BYTES,
  readResponseWithinLimit,
  rememberBounded,
  saveInboundMedia,
} from "./utils.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

const MAX_TEXT = 4000;
const OPENAPI_BASE = "https://api.dingtalk.com";
const MAX_CHAT_CACHE = 2000;

/** Robot topic used by DingTalk Stream mode (mirrors `TOPIC_ROBOT` from `dingtalk-stream`). */
export const DINGTALK_TOPIC_ROBOT = "/v1.0/im/bot/messages/get";

export interface DingTalkDownStream {
  headers: { messageId: string; [key: string]: unknown };
  data: string;
}

/** Minimal structural view of `DWClient` (so tests can inject fakes). */
export interface DingTalkClientLike {
  registerCallbackListener(
    topic: string,
    callback: (msg: DingTalkDownStream) => unknown,
  ): unknown;
  connect(): Promise<void> | void;
  disconnect(): void;
  socketCallBackResponse?(messageId: string, result: unknown): void;
}

export interface DingTalkAdapterOptions {
  createClient?: (cfg: { clientId: string; clientSecret: string }) => DingTalkClientLike;
  fetchImpl?: typeof fetch;
  mediaDir?: string;
  now?: () => number;
}

interface ChatMeta {
  sessionWebhook?: string;
  expiresAt?: number;
  isGroup: boolean;
  staffId?: string;
  robotCode?: string;
}

function safeJson(raw: unknown): any {
  if (typeof raw !== "string") {
    return raw ?? {};
  }
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function markdownTitle(text: string): string {
  const first = text.split("\n").find((l) => l.trim()) ?? "Antigravity";
  return first.replace(/[#*`>_~[\]]/g, "").trim().slice(0, 20) || "Antigravity";
}

export class DingTalkChannelAdapter extends BaseChannelAdapter {
  readonly name = "dingtalk";

  private readonly dedupe = new BoundedDedupeCache();
  private readonly chats = new Map<string, ChatMeta>();
  private readonly fetchImpl: typeof fetch;
  private readonly mediaDir: string;
  private readonly now: () => number;
  private client?: DingTalkClientLike;
  private token?: { value: string; expiresAt: number };
  private tokenRequest?: Promise<string>;
  private lifecycle = new AbortController();

  constructor(
    private readonly config: GatewayConfig,
    private readonly options: DingTalkAdapterOptions = {},
  ) {
    super();
    this.fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));
    this.mediaDir = options.mediaDir ?? path.join(config.dataDir, "media");
    this.now = options.now ?? Date.now;
  }

  async start(onMessage: InboundHandler): Promise<void> {
    const cfg = this.config.dingtalk;
    if (!cfg) {
      throw new Error("DingTalk is not configured (DINGTALK_CLIENT_ID / DINGTALK_CLIENT_SECRET)");
    }
    this.handler = onMessage;
    const sdkCfg = { clientId: cfg.clientId, clientSecret: cfg.clientSecret };

    let client: DingTalkClientLike;
    let topic = DINGTALK_TOPIC_ROBOT;
    if (this.options.createClient) {
      client = this.options.createClient(sdkCfg);
    } else {
      const sdk = await import("dingtalk-stream");
      topic = sdk.TOPIC_ROBOT;
      client = new sdk.DWClient(sdkCfg) as unknown as DingTalkClientLike;
    }
    this.client = client;

    client.registerCallbackListener(topic, (down) => {
      // Ack right away so DingTalk does not redeliver while we process.
      try {
        client.socketCallBackResponse?.(down.headers.messageId, { status: "SUCCESS" });
      } catch (err) {
        this.noteError(err);
      }
      void this.handleCallback(down.data).catch((err) => this.noteError(err));
      return { status: "SUCCESS", message: "OK" };
    });

    this.lifecycle = new AbortController();
    try {
      await client.connect();
    } catch (err) {
      this.client = undefined;
      this.handler = undefined;
      throw err;
    }
    this.setConnected(true);
  }

  async stop(): Promise<void> {
    this.setConnected(false);
    this.lifecycle.abort();
    try {
      this.client?.disconnect();
    } catch (err) {
      this.noteError(err);
    }
    this.client = undefined;
    this.handler = undefined;
    this.token = undefined;
    this.tokenRequest = undefined;
    this.chats.clear();
  }

  /** Process one robot callback payload (JSON string or object). Exposed for tests. */
  async handleCallback(rawData: unknown): Promise<void> {
    const msg = safeJson(rawData);
    const msgId = typeof msg.msgId === "string" ? msg.msgId : undefined;
    const chatId = typeof msg.conversationId === "string" ? msg.conversationId : undefined;
    if (!msgId || !chatId) {
      return;
    }
    if (this.dedupe.seen(msgId)) {
      return;
    }
    const senderId = String(msg.senderStaffId || msg.senderId || "");
    if (!senderId) {
      return;
    }
    const isGroup = String(msg.conversationType) === "2";

    this.rememberChat(chatId, {
      sessionWebhook: typeof msg.sessionWebhook === "string" ? msg.sessionWebhook : undefined,
      expiresAt: Number(msg.sessionWebhookExpiredTime) || undefined,
      isGroup,
      staffId: msg.senderStaffId || undefined,
      robotCode: msg.robotCode || undefined,
    });

    const content = safeJson(msg.content);
    const type = String(msg.msgtype ?? "text");
    let text = "";
    const attachments: InboundAttachment[] = [];
    const robotCode = msg.robotCode || this.config.dingtalk?.clientId;

    const fetchMedia = async (
      kind: InboundAttachment["type"],
      code: unknown,
      name: string | undefined,
    ) => {
      if (typeof code !== "string" || !code) {
        return;
      }
      try {
        const data = await this.downloadMedia(code, robotCode);
        const localPath = await saveInboundMedia(this.mediaDir, this.name, msgId, name ?? code, data);
        attachments.push({
          type: kind,
          name,
          sizeBytes: data.byteLength,
          localPath,
          guid: code,
        });
      } catch (err) {
        this.noteError(err);
      }
    };

    switch (type) {
      case "text":
        text = String(msg.text?.content ?? "");
        break;
      case "richText": {
        const parts: string[] = [];
        const pending: Array<Promise<void>> = [];
        for (const item of Array.isArray(content.richText) ? content.richText : []) {
          if (typeof item?.text === "string") {
            parts.push(item.text);
          } else if (item?.type === "picture" || item?.downloadCode) {
            pending.push(fetchMedia("image", item.downloadCode, `${msgId}.png`));
          }
        }
        await Promise.all(pending);
        text = parts.join("");
        break;
      }
      case "picture":
        await fetchMedia("image", content.downloadCode, `${msgId}.png`);
        break;
      case "file":
        await fetchMedia("file", content.downloadCode, content.fileName);
        break;
      case "audio":
        text = typeof content.recognition === "string" ? content.recognition : "";
        await fetchMedia("audio", content.downloadCode, `${msgId}.amr`);
        break;
      case "video":
        await fetchMedia("video", content.downloadCode, `${msgId}.mp4`);
        break;
      default:
        return;
    }

    text = text.trim();
    if (!text && attachments.length === 0) {
      return;
    }
    const mentionsBot =
      !isGroup ||
      msg.isInAtList === true ||
      msg.isMentioned === true ||
      isMentioned(text, this.config.groupMentionPatterns);

    await this.emit({
      id: msgId,
      channel: this.name,
      chatId,
      senderId,
      isGroup,
      text,
      attachments,
      timestamp: Number(msg.createAt) || this.now(),
      mentionsBot,
      raw: msg,
    });
  }

  private rememberChat(chatId: string, meta: ChatMeta): void {
    rememberBounded(this.chats, chatId, meta, MAX_CHAT_CACHE);
  }

  /** OpenAPI access token (cached until shortly before expiry). */
  private async getAccessToken(): Promise<string> {
    const cfg = this.config.dingtalk;
    if (!cfg) {
      throw new Error("DingTalk is not configured");
    }
    if (this.token && this.token.expiresAt > this.now() + 60_000) {
      return this.token.value;
    }
    if (this.tokenRequest) {
      return this.tokenRequest;
    }
    this.tokenRequest = (async () => {
      const res = await this.fetchImpl(`${OPENAPI_BASE}/v1.0/oauth2/accessToken`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ appKey: cfg.clientId, appSecret: cfg.clientSecret }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        throw new Error(`DingTalk access token request failed: HTTP ${res.status}`);
      }
      const body = (await res.json()) as { accessToken?: string; expireIn?: number };
      if (!body.accessToken) {
        throw new Error("DingTalk access token response had no accessToken");
      }
      this.token = {
        value: body.accessToken,
        expiresAt: this.now() + (body.expireIn ?? 7200) * 1000,
      };
      return this.token.value;
    })();
    try {
      return await this.tokenRequest;
    } finally {
      this.tokenRequest = undefined;
    }
  }

  private async openApi(pathname: string, body: unknown): Promise<any> {
    const token = await this.getAccessToken();
    const res = await this.fetchImpl(`${OPENAPI_BASE}${pathname}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-acs-dingtalk-access-token": token },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`DingTalk OpenAPI ${pathname} failed: HTTP ${res.status} ${detail}`.trim());
    }
    return res.json().catch(() => ({}));
  }

  private async downloadMedia(downloadCode: string, robotCode: string | undefined): Promise<Buffer> {
    const info = await this.openApi("/v1.0/robot/messageFiles/download", {
      downloadCode,
      robotCode,
    });
    const url = info?.downloadUrl;
    if (typeof url !== "string" || !url) {
      throw new Error("DingTalk file download returned no downloadUrl");
    }
    const res = await this.fetchImpl(url, {
      signal: AbortSignal.any([AbortSignal.timeout(30_000), this.lifecycle.signal]),
    });
    if (!res.ok) {
      throw new Error(`DingTalk media download failed: HTTP ${res.status}`);
    }
    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared > MAX_INLINE_MEDIA_BYTES) {
      throw new Error(`Download exceeds ${MAX_INLINE_MEDIA_BYTES} bytes`);
    }
    return readResponseWithinLimit(res, MAX_INLINE_MEDIA_BYTES);
  }

  async sendMessage(msg: OutboundMessage): Promise<{ messageId?: string } | void> {
    const meta = this.chats.get(msg.chatId);
    if (!meta) {
      throw new Error(
        `DingTalk: no session known for chat ${msg.chatId}; the bot can only reply after the chat has messaged it`,
      );
    }

    // DingTalk bot webhooks cannot upload binaries; link URLs inline, mention the rest.
    let text = msg.text ?? "";
    let markdown = Boolean(msg.markdown);
    for (const att of msg.attachments ?? []) {
      if (att.url) {
        text += `${text ? "\n\n" : ""}${/^image\//.test(att.mimeType ?? "") ? "!" : ""}[${att.name ?? "attachment"}](${att.url})`;
        markdown = true;
      } else {
        text += `${text ? "\n\n" : ""}[attachment not delivered: ${att.name ?? (att.path ? path.basename(att.path) : "file")}]`;
      }
    }

    let lastId: string | undefined;
    for (const chunk of chunkText(text, MAX_TEXT)) {
      lastId = (await this.sendChunk(msg.chatId, meta, chunk, markdown)) ?? lastId;
    }
    this.noteOutbound();
    return { messageId: lastId };
  }

  private async sendChunk(
    chatId: string,
    meta: ChatMeta,
    chunk: string,
    markdown: boolean,
  ): Promise<string | undefined> {
    const webhookUsable =
      meta.sessionWebhook && (!meta.expiresAt || this.now() < meta.expiresAt - 1000);
    let webhookError: string | undefined;

    if (webhookUsable) {
      try {
        await this.postWebhook(meta.sessionWebhook as string, chunk, markdown);
        return undefined;
      } catch (err) {
        webhookError = errorMessage(err);
      }
    } else {
      webhookError = "sessionWebhook expired or unavailable";
    }

    const robotCode = meta.robotCode ?? this.config.dingtalk?.clientId;
    if (!robotCode || (!meta.isGroup && !meta.staffId)) {
      throw new Error(
        `DingTalk reply failed (${webhookError}) and proactive send is not possible for chat ${chatId}`,
      );
    }
    try {
      const [msgKey, msgParam] = markdown
        ? ["sampleMarkdown", { title: markdownTitle(chunk), text: chunk }]
        : ["sampleText", { content: chunk }];
      const res = meta.isGroup
        ? await this.openApi("/v1.0/robot/groupMessages/send", {
            robotCode,
            openConversationId: chatId,
            msgKey,
            msgParam: JSON.stringify(msgParam),
          })
        : await this.openApi("/v1.0/robot/oToMessages/batchSend", {
            robotCode,
            userIds: [meta.staffId],
            msgKey,
            msgParam: JSON.stringify(msgParam),
          });
      return typeof res?.processQueryKey === "string" ? res.processQueryKey : undefined;
    } catch (err) {
      throw new Error(
        `DingTalk send failed: webhook (${webhookError}); proactive (${errorMessage(err)})`,
      );
    }
  }

  private async postWebhook(url: string, chunk: string, markdown: boolean): Promise<void> {
    const payload = markdown
      ? { msgtype: "markdown", markdown: { title: markdownTitle(chunk), text: chunk } }
      : { msgtype: "text", text: { content: chunk } };
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      throw new Error(`sessionWebhook HTTP ${res.status}`);
    }
    const body = (await res.json().catch(() => ({}))) as { errcode?: number; errmsg?: string };
    if (typeof body.errcode === "number" && body.errcode !== 0) {
      throw new Error(`sessionWebhook errcode ${body.errcode}: ${body.errmsg ?? "unknown"}`);
    }
  }
}

export function createAdapter(config: GatewayConfig): ChannelAdapter {
  return new DingTalkChannelAdapter(config);
}
