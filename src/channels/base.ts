import type { ChannelAdapter, InboundMessage, OutboundMessage } from "../types.js";

export type InboundHandler = (msg: InboundMessage) => Promise<void> | void;

/**
 * Optional convenience base class for channel adapters: tracks connection state,
 * stats, and the inbound handler so subclasses only implement transport logic.
 *
 * Contract for adapters (base class or not):
 * - `name` MUST equal the channel name (e.g. "telegram").
 * - Inbound `chatId` is the RAW platform chat id; the MultiChannelHub namespaces it.
 * - Inbound `senderId` is the RAW platform user id (router lowercases + namespaces it).
 * - Use `emit()` to deliver inbound messages (stats + error isolation included).
 * - `start()` should resolve once the transport is up (or after a bounded wait) and keep
 *   reconnecting in the background; it must not throw for transient network errors.
 */
export abstract class BaseChannelAdapter implements ChannelAdapter {
  abstract readonly name: string;

  protected handler?: InboundHandler;
  protected connected = false;
  protected lastInboundAt?: number;
  protected lastOutboundAt?: number;
  protected lastError?: string;

  abstract start(onMessage: InboundHandler): Promise<void>;
  abstract stop(): Promise<void>;
  abstract sendMessage(msg: OutboundMessage): Promise<{ messageId?: string } | void>;

  isConnected(): boolean {
    return this.connected;
  }

  getStats(): { lastInboundAt?: number; lastOutboundAt?: number; lastError?: string } {
    return {
      lastInboundAt: this.lastInboundAt,
      lastOutboundAt: this.lastOutboundAt,
      lastError: this.lastError,
    };
  }

  protected setConnected(connected: boolean): void {
    this.connected = connected;
    if (connected) {
      this.lastError = undefined;
    }
  }

  protected noteOutbound(): void {
    this.lastOutboundAt = Date.now();
  }

  protected noteError(err: unknown): void {
    this.lastError = err instanceof Error ? err.message : String(err);
  }

  /** Deliver an inbound message to the gateway; handler errors never crash the transport. */
  protected async emit(msg: InboundMessage): Promise<void> {
    this.lastInboundAt = Date.now();
    if (!this.handler) {
      return;
    }
    try {
      await this.handler(msg);
    } catch (err) {
      this.noteError(err);
    }
  }
}
