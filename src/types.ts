export type ApprovalMode = "auto" | "interactive" | "sandbox";

export type BusyMode = "queue" | "interrupt" | "steer";

export type LogLevel = "debug" | "info" | "warn" | "error";

export type AttachmentKind = "image" | "audio" | "video" | "file" | "other";

export interface InboundAttachment {
  type: AttachmentKind;
  mimeType?: string;
  name?: string;
  sizeBytes?: number;
  data?: Buffer;
  localPath?: string;
  url?: string;
  guid?: string;
  read?: () => Promise<Buffer>;
}

export interface InboundMessage {
  id: string;
  channel: string;
  chatId: string;
  senderId: string;
  rawSenderId?: string;
  isGroup: boolean;
  text: string;
  attachments: InboundAttachment[];
  replyToMessageId?: string;
  timestamp: number;
  service?: "iMessage" | "SMS" | "RCS" | "unknown";
  mentionsBot?: boolean;
  raw?: unknown;
}

export interface OutboundAttachment {
  path?: string;
  buffer?: Buffer;
  url?: string;
  name?: string;
  mimeType?: string;
}

export interface OutboundMessage {
  chatId: string;
  text?: string;
  markdown?: boolean;
  replyToMessageId?: string;
  attachments?: OutboundAttachment[];
  effect?: string;
}

export interface ChannelAdapter {
  readonly name: string;
  start(onMessage: (msg: InboundMessage) => Promise<void> | void): Promise<void>;
  stop(): Promise<void>;
  sendMessage(msg: OutboundMessage): Promise<{ messageId?: string } | void>;
  sendTyping?(chatId: string, active: boolean): Promise<void>;
  markRead?(chatId: string, messageId?: string): Promise<void>;
  react?(chatId: string, messageId: string, emoji: string): Promise<void>;
  editMessage?(chatId: string, messageId: string, text: string): Promise<void>;
  isConnected(): boolean;
  /** Optional per-channel counters surfaced by `/channels`, health, and the hub. */
  getStats?(): {
    lastInboundAt?: number;
    lastOutboundAt?: number;
    lastHeartbeatAt?: number;
    lastError?: string;
  };
}

export interface ChannelHealthStatus {
  name: string;
  connected: boolean;
  lastInboundAt?: number;
  lastOutboundAt?: number;
  lastHeartbeatAt?: number;
  lastError?: string;
}

export interface SessionInfo {
  chatId: string;
  sessionId: string;
  cwd: string;
  model?: string;
  effort?: string;
  mode?: string;
  approvalMode: ApprovalMode;
  busyMode: BusyMode;
  title?: string;
  channelGroup?: string;
  onboarded?: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface BoundChannelRecord {
  channel: string;
  groupName: string;
  firstBoundAt: number;
  defaultChatId?: string;
  defaultSessionId?: string;
}

export interface ModelCatalogEntry {
  id: string;
  name: string;
  efforts?: string[];
}

export type TurnActivityPhase =
  | "starting"
  | "thinking"
  | "tool"
  | "streaming"
  | "retrying";

export interface TurnActivitySnapshot {
  chatId: string;
  startedAt: number;
  lastActivityAt: number;
  phase: TurnActivityPhase;
  model?: string;
  effort?: string;
  currentTool?: string;
  toolCount: number;
  retryCount: number;
  maxRetries: number;
  lastRetryReason?: string;
}

export interface PermissionOption {
  optionId: string;
  name: string;
  kind: string;
}

export interface PendingPermission {
  id: string;
  chatId: string;
  sessionId: string;
  toolCallId: string;
  title: string;
  kind?: string;
  options: PermissionOption[];
  createdAt: number;
  resolve: (optionId: string | null) => void;
}

export interface ToolCallEvent {
  toolCallId: string;
  title: string;
  status: string;
  kind?: string;
  output?: string;
}

export interface AgentTurnCallbacks {
  onTextDelta?: (delta: string) => Promise<void> | void;
  onThoughtDelta?: (delta: string) => Promise<void> | void;
  onToolCall?: (event: ToolCallEvent) => Promise<void> | void;
  onPermissionRequest?: (
    perm: Omit<PendingPermission, "id" | "chatId" | "resolve" | "createdAt">,
  ) => Promise<string | null>;
}

export interface AgentTurnInput {
  chatId: string;
  sessionId?: string;
  cwd: string;
  text: string;
  attachments?: InboundAttachment[];
  model?: string;
  effort?: string;
  approvalMode?: ApprovalMode;
  callbacks?: AgentTurnCallbacks;
}

export interface AgentTurnResult {
  sessionId: string;
  text: string;
  stopReason: string;
}

export interface AcpSessionSummary {
  sessionId: string;
  cwd: string;
  title?: string;
  updatedAt?: string;
}

export interface AgentBackend {
  start?(): Promise<void>;
  stop(): Promise<void>;
  sendTurn(input: AgentTurnInput): Promise<AgentTurnResult>;
  cancelTurn(chatId: string): Promise<boolean>;
  resetSession(chatId: string): Promise<void>;
  listSessions(cwd?: string): Promise<AcpSessionSummary[]>;
  attachSession?(chatId: string, sessionId: string, cwd: string): Promise<void>;
  setConfigOption?(chatId: string, configId: string, value: string): Promise<void>;
  setMode?(chatId: string, modeId: string): Promise<void>;
}

export interface LoopJob {
  id: string;
  chatId: string;
  prompt: string;
  intervalMs?: number;
  cron?: string;
  cwd?: string;
  enabled: boolean;
  lastRunAt?: number;
  nextRunAt?: number;
  createdAt: number;
}

export interface QuotaBucket {
  id: string;
  name: string;
  window: "5h" | "weekly" | string;
  remainingFraction: number;
  remainingPercent: number;
  resetTime: string;
  description?: string;
}

export interface QuotaGroup {
  name: string;
  description?: string;
  buckets: QuotaBucket[];
}

export interface QuotaSummary {
  available: boolean;
  fetchedAt: number;
  groups: QuotaGroup[];
  fiveHourRemainingPercent?: number;
  fiveHourResetTime?: string;
  weeklyRemainingPercent?: number;
  weeklyResetTime?: string;
  rawText?: string;
  error?: string;
}

export interface HealthSnapshot {
  status: "ok" | "degraded" | "starting";
  startedAt: number;
  uptimeMs: number;
  channelConnected: boolean;
  activeSessions: number;
  activeTurns: number;
  pendingPermissions: number;
  activeLoops: number;
  lastInboundAt?: number;
  lastOutboundAt?: number;
  lastError?: string;
  /** Per-channel connection state keyed by channel name (multi-channel hub). */
  channels?: Record<string, ChannelHealthStatus>;
}
