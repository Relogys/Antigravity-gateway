import { readFile } from "node:fs/promises";
import path from "node:path";
import type { GatewayConfig, MatrixConfig } from "../config.js";
import type {
  ChannelAdapter,
  InboundAttachment,
  InboundMessage,
  OutboundAttachment,
  OutboundMessage,
} from "../types.js";
import { BaseChannelAdapter, type InboundHandler } from "./base.js";
import {
  MAX_INBOUND_MEDIA_BYTES,
  downloadInboundMedia,
  type DownloadInboundMediaResult,
} from "./media.js";
import {
  BoundedDedupeCache,
  MAX_INLINE_MEDIA_BYTES,
  chunkText,
  errorMessage,
  isMentioned,
  readResponseWithinLimit,
  reconnectDelayMs,
  sleepWithAbort,
} from "./utils.js";

const MATRIX_TEXT_LIMIT = 4000;

export interface MatrixAdapterOptions {
  fetchImpl?: typeof fetch;
}

interface MatrixMessageContent {
  msgtype?: string;
  body?: string;
  url?: string;
  filename?: string;
  info?: { mimetype?: string; size?: number };
}

interface MatrixEvent {
  type?: string;
  event_id?: string;
  sender?: string;
  origin_server_ts?: number;
  content?: MatrixMessageContent;
}

interface MatrixJoinedRoom {
  summary?: {
    "m.joined_member_count"?: number;
  };
  timeline?: { events?: MatrixEvent[] };
}

interface MatrixSyncResponse {
  next_batch?: string;
  rooms?: { join?: Record<string, MatrixJoinedRoom> };
  account_data?: { events?: { type?: string; content?: unknown }[] };
}

export class MatrixChannelAdapter extends BaseChannelAdapter {
  readonly name = "matrix";

  private readonly cfg: MatrixConfig;
  private readonly fetchImpl: typeof fetch;
  private readonly mediaDir: string;
  private readonly groupMentionPatterns: string[];
  private readonly dedupe = new BoundedDedupeCache();
  private readonly directRooms = new Set<string>();

  private selfUserId: string;
  private since?: string;
  private stopped = false;
  private lifecycle = new AbortController();
  private syncLoop?: Promise<void>;
  private accountDataRequested = false;
  private txnCounter = 0;

  constructor(config: GatewayConfig, options: MatrixAdapterOptions = {}) {
    super();
    if (!config.matrix) {
      throw new Error("Matrix adapter requires config.matrix");
    }
    this.cfg = config.matrix;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.mediaDir = path.join(config.dataDir, "media");
    this.groupMentionPatterns = [...config.groupMentionPatterns];
    this.selfUserId = config.matrix.userId ?? "";
  }

  async start(onMessage: InboundHandler): Promise<void> {
    if (this.syncLoop) {
      return;
    }
    this.handler = onMessage;
    this.stopped = false;
    this.lifecycle = new AbortController();
    try {
      await this.ensureIdentity();
    } catch (err) {
      this.noteError(err);
    }
    if (this.stopped) {
      return;
    }
    this.syncLoop = this.runSyncLoop();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.lifecycle.abort();
    const loop = this.syncLoop;
    this.syncLoop = undefined;
    if (loop) {
      await loop.catch(() => undefined);
    }
    this.handler = undefined;
    this.setConnected(false);
  }

  async sendMessage(msg: OutboundMessage): Promise<{ messageId?: string }> {
    const relates = msg.replyToMessageId
      ? { "m.relates_to": { "m.in_reply_to": { event_id: msg.replyToMessageId } } }
      : {};
    let messageId: string | undefined;

    for (const chunk of chunkText(msg.text ?? "", MATRIX_TEXT_LIMIT)) {
      messageId =
        (await this.sendRoomEvent(msg.chatId, "m.room.message", {
          msgtype: "m.text",
          body: chunk,
          ...relates,
        })) ?? messageId;
    }

    for (const attachment of msg.attachments ?? []) {
      const uploaded = await this.uploadAttachment(attachment);
      const msgtype = uploaded.mimeType?.startsWith("image/")
        ? "m.image"
        : uploaded.mimeType?.startsWith("audio/")
          ? "m.audio"
          : "m.file";
      messageId =
        (await this.sendRoomEvent(msg.chatId, "m.room.message", {
          msgtype,
          body: uploaded.name,
          url: uploaded.url,
          info: { mimetype: uploaded.mimeType, size: uploaded.data.byteLength },
          ...relates,
        })) ?? messageId;
    }

    this.noteOutbound();
    return { messageId };
  }

  async sendTyping(chatId: string, active: boolean): Promise<void> {
    const res = await this.fetchImpl(
      `${this.hsUrl()}/_matrix/client/v3/rooms/${encodeURIComponent(chatId)}/typing/${encodeURIComponent(this.selfUserId)}`,
      {
        method: "PUT",
        headers: this.authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ typing: active, timeout: active ? 30_000 : 0 }),
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!res.ok) {
      throw new Error(`Matrix typing failed with HTTP ${res.status}`);
    }
  }

  async react(chatId: string, messageId: string, emoji: string): Promise<void> {
    await this.sendRoomEvent(chatId, "m.reaction", {
      "m.relates_to": {
        rel_type: "m.annotation",
        event_id: messageId,
        key: emoji,
      },
    });
  }

  private async ensureIdentity(): Promise<void> {
    if (!this.selfUserId) {
      const res = await this.fetchImpl(`${this.hsUrl()}/_matrix/client/v3/account/whoami`, {
        headers: this.authHeaders(),
        signal: AbortSignal.any([AbortSignal.timeout(15_000), this.lifecycle.signal]),
      });
      if (!res.ok) {
        throw new Error(`Matrix whoami failed with HTTP ${res.status}`);
      }
      const body = (await res.json()) as { user_id?: string };
      if (!body.user_id) {
        throw new Error("Matrix whoami response missing user_id");
      }
      this.selfUserId = body.user_id;
    }
    await this.loadDirectRooms();
  }

  private async loadDirectRooms(): Promise<void> {
    if (this.accountDataRequested || !this.selfUserId) {
      return;
    }
    this.accountDataRequested = true;
    const url = `${this.hsUrl()}/_matrix/client/v3/user/${encodeURIComponent(this.selfUserId)}/account_data/m.direct`;
    try {
      const res = await this.fetchImpl(url, {
        headers: this.authHeaders(),
        signal: AbortSignal.any([AbortSignal.timeout(15_000), this.lifecycle.signal]),
      });
      if (res.ok) {
        this.replaceDirectRooms(await res.json());
      }
    } catch {
      // m.direct is optional; DM detection falls back to member counts.
    }
  }

  private async runSyncLoop(): Promise<void> {
    const signal = this.lifecycle.signal;
    let attempt = 0;

    while (!this.stopped) {
      try {
        await this.ensureIdentity();
        const params = new URLSearchParams({ timeout: "30000" });
        if (this.since) {
          params.set("since", this.since);
        }
        const res = await this.fetchImpl(
          `${this.hsUrl()}/_matrix/client/v3/sync?${params.toString()}`,
          { headers: this.authHeaders(), signal },
        );
        if (!res.ok) {
          throw new Error(`Matrix sync failed with HTTP ${res.status}`);
        }
        const body = (await res.json()) as MatrixSyncResponse;
        // A sync WITHOUT `since` is the historical snapshot: keep next_batch but
        // never emit its timeline events.
        const isInitialSync = !this.since;
        if (body.next_batch) {
          this.since = body.next_batch;
        }
        this.setConnected(true);
        attempt = 0;
        this.applyAccountData(body);
        if (this.stopped) {
          break;
        }
        if (!isInitialSync) {
          await this.handleSync(body);
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

  private async handleSync(body: MatrixSyncResponse): Promise<void> {
    for (const [roomId, room] of Object.entries(body.rooms?.join ?? {})) {
      for (const event of room.timeline?.events ?? []) {
        if (this.stopped) {
          return;
        }
        await this.handleRoomEvent(roomId, room, event);
      }
    }
  }

  private async handleRoomEvent(
    roomId: string,
    room: MatrixJoinedRoom,
    event: MatrixEvent,
  ): Promise<void> {
    if (event.type !== "m.room.message" || !event.event_id || !event.sender) {
      return;
    }
    if (this.selfUserId && event.sender === this.selfUserId) {
      return;
    }
    if (this.dedupe.seen(event.event_id)) {
      return;
    }

    const content = event.content ?? {};
    const msgtype = content.msgtype ?? "m.text";
    const isMedia = msgtype === "m.image" || msgtype === "m.file" || msgtype === "m.audio";
    if (!isMedia && msgtype !== "m.text" && msgtype !== "m.notice") {
      return;
    }

    const text = content.body ?? content.filename ?? "";
    const attachments: InboundAttachment[] = [];
    if (isMedia) {
      attachments.push(await this.buildAttachment(msgtype, content));
    }

    const msg: InboundMessage = {
      id: event.event_id,
      channel: this.name,
      chatId: roomId,
      senderId: event.sender,
      rawSenderId: event.sender,
      isGroup: !this.isDirectRoom(roomId, room),
      text,
      attachments,
      timestamp: event.origin_server_ts ?? Date.now(),
      mentionsBot: this.mentionsSelf(text),
      raw: event,
    };
    await this.emit(msg);
  }

  private async buildAttachment(
    msgtype: string,
    content: MatrixMessageContent,
  ): Promise<InboundAttachment> {
    const attachment: InboundAttachment & { kind?: string } = {
      type: msgtype === "m.image" ? "image" : msgtype === "m.audio" ? "audio" : "file",
      mimeType: content.info?.mimetype,
      name: content.filename ?? content.body,
      sizeBytes: content.info?.size,
      url: content.url,
    };
    if (content.url?.startsWith("mxc://")) {
      try {
        const media = await this.downloadMxc(
          content.url,
          content.filename ?? content.body,
          content.info?.mimetype,
        );
        attachment.localPath = media.localPath;
        attachment.mimeType = attachment.mimeType ?? media.mimeType;
        attachment.sizeBytes = media.sizeBytes;
        attachment.name = attachment.name ?? media.name;
        attachment.kind = attachment.type;
      } catch (err) {
        this.noteError(err);
      }
    }
    return attachment;
  }

  private async downloadMxc(
    mxcUrl: string,
    filenameHint?: string,
    mimeTypeHint?: string,
  ): Promise<DownloadInboundMediaResult> {
    const rest = mxcUrl.slice("mxc://".length);
    const slash = rest.indexOf("/");
    if (slash <= 0 || slash === rest.length - 1) {
      throw new Error(`Invalid mxc URL: ${mxcUrl}`);
    }
    const segments = `${encodeURIComponent(rest.slice(0, slash))}/${encodeURIComponent(
      rest.slice(slash + 1),
    )}`;
    const options = {
      mediaDir: this.mediaDir,
      headers: this.authHeaders(),
      filenameHint,
      mimeTypeHint,
      maxBytes: MAX_INBOUND_MEDIA_BYTES,
      fetchImpl: this.fetchImpl,
      signal: this.lifecycle.signal,
    };
    try {
      return await downloadInboundMedia({
        url: `${this.hsUrl()}/_matrix/client/v1/media/download/${segments}`,
        ...options,
      });
    } catch (err) {
      if (!/HTTP 404\b/.test(errorMessage(err))) {
        throw err;
      }
      // Older homeservers may not expose the authenticated v1 media endpoint yet.
      return await downloadInboundMedia({
        url: `${this.hsUrl()}/_matrix/media/v3/download/${segments}`,
        ...options,
      });
    }
  }

  private isDirectRoom(roomId: string, room: MatrixJoinedRoom): boolean {
    if (this.directRooms.has(roomId)) {
      return true;
    }
    const memberCount = room.summary?.["m.joined_member_count"];
    return typeof memberCount === "number" && memberCount <= 2;
  }

  private mentionsSelf(text: string): boolean {
    const patterns = [...this.groupMentionPatterns];
    const localpart = this.selfLocalpart();
    if (localpart) {
      patterns.push(`@${localpart}`);
    }
    return isMentioned(text, patterns);
  }

  private selfLocalpart(): string {
    if (!this.selfUserId.startsWith("@")) {
      return "";
    }
    const colon = this.selfUserId.indexOf(":");
    return this.selfUserId.slice(1, colon === -1 ? this.selfUserId.length : colon);
  }

  private applyAccountData(body: MatrixSyncResponse): void {
    for (const event of body.account_data?.events ?? []) {
      if (event.type === "m.direct") {
        this.replaceDirectRooms(event.content);
      }
    }
  }

  private replaceDirectRooms(content: unknown): void {
    if (!content || typeof content !== "object") {
      return;
    }
    this.directRooms.clear();
    for (const rooms of Object.values(content as Record<string, unknown>)) {
      if (!Array.isArray(rooms)) {
        continue;
      }
      for (const roomId of rooms) {
        if (typeof roomId === "string") {
          this.directRooms.add(roomId);
        }
      }
    }
  }

  private async sendRoomEvent(
    roomId: string,
    eventType: string,
    content: Record<string, unknown>,
  ): Promise<string | undefined> {
    const txnId = `${Date.now()}.${this.txnCounter++}`;
    const res = await this.fetchImpl(
      `${this.hsUrl()}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/${eventType}/${txnId}`,
      {
        method: "PUT",
        headers: this.authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify(content),
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!res.ok) {
      throw new Error(`Matrix ${eventType} send failed with HTTP ${res.status}`);
    }
    const body = (await res.json().catch(() => ({}))) as { event_id?: string };
    return body.event_id;
  }

  private async uploadAttachment(
    attachment: OutboundAttachment,
  ): Promise<{ url: string; name: string; mimeType?: string; data: Buffer }> {
    const data = await this.readAttachment(attachment);
    const name = attachment.name ?? (attachment.path ? path.basename(attachment.path) : "attachment.bin");
    const res = await this.fetchImpl(
      `${this.hsUrl()}/_matrix/media/v3/upload?filename=${encodeURIComponent(name)}`,
      {
        method: "POST",
        headers: this.authHeaders(attachment.mimeType ? { "Content-Type": attachment.mimeType } : {}),
        body: data,
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!res.ok) {
      throw new Error(`Matrix media upload failed with HTTP ${res.status}`);
    }
    const body = (await res.json()) as { content_uri?: string };
    if (!body.content_uri) {
      throw new Error("Matrix media upload response missing content_uri");
    }
    return { url: body.content_uri, name, mimeType: attachment.mimeType, data };
  }

  private async readAttachment(attachment: OutboundAttachment): Promise<Buffer> {
    if (attachment.buffer) {
      return attachment.buffer;
    }
    if (attachment.path) {
      return readFile(attachment.path);
    }
    if (attachment.url) {
      const res = await this.fetchImpl(attachment.url, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) {
        throw new Error(`Attachment fetch failed with HTTP ${res.status}`);
      }
      const declared = Number(res.headers.get("content-length") ?? 0);
      if (declared > MAX_INLINE_MEDIA_BYTES) {
        throw new Error(`Download exceeds ${MAX_INLINE_MEDIA_BYTES} bytes`);
      }
      return readResponseWithinLimit(res, MAX_INLINE_MEDIA_BYTES);
    }
    throw new Error("Outbound attachment has no data source");
  }

  private authHeaders(extra: Record<string, string> = {}): Record<string, string> {
    return { Authorization: `Bearer ${this.cfg.accessToken}`, ...extra };
  }

  private hsUrl(): string {
    return this.cfg.homeserverUrl.replace(/\/+$/, "");
  }
}

export function createAdapter(config: GatewayConfig): ChannelAdapter {
  return new MatrixChannelAdapter(config);
}