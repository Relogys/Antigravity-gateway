<div align="center">

# 🪐 Antigravity Gateway

**Universal 8-Platform Multi-Channel Messaging Gateway for Google Antigravity (`agy acp`)**

*通用 8 平台多通道 Google Antigravity 消息网关 — 无需公网域名与内网穿透，随时随地通过 iMessage / Telegram / Discord / Slack / 飞书 / 钉钉 / QQ / Webhook 远程驱动你的本地 Antigravity Agent*

<p>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/Node.js-22%2B%20%7C%2024%2B-339933?style=for-the-badge&logo=nodedotjs&logoColor=white" alt="Node.js 22+ / 24+" /></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-5.8%2B%20ESM-3178C6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript" /></a>
  <a href="https://agentclientprotocol.com/"><img src="https://img.shields.io/badge/ACP-v1%20(%40agentclientprotocol%2Fsdk)-6E56CF?style=for-the-badge" alt="ACP v1" /></a>
  <a href="#supported-channels--支持通道一览"><img src="https://img.shields.io/badge/Built--in%20Channels-8%20Platforms-0A84FF?style=for-the-badge" alt="8 Built-in Channels" /></a>
  <a href="#slash-commands--斜杠命令"><img src="https://img.shields.io/badge/Quota%20Check-0%20Tokens-F59E0B?style=for-the-badge" alt="Zero-Token Quota" /></a>
  <a href="#license"><img src="https://img.shields.io/badge/License-MIT-10B981?style=for-the-badge" alt="MIT License" /></a>
</p>

<p>
  <a href="#architecture--架构设计">Architecture</a> •
  <a href="#supported-channels--支持通道一览">8 Channels</a> •
  <a href="#quick-start--快速开始">Quick Start</a> •
  <a href="#channel-configuration--各平台环境变量">Env Vars</a> •
  <a href="#cli--health-endpoint--命令行与健康检查">CLI &amp; Health</a> •
  <a href="#slash-commands--斜杠命令">Slash Commands</a> •
  <a href="#security--compliance--安全与合规">Security</a>
</p>

</div>

---

## Overview / 项目定位

**Antigravity Gateway** turns local **Google Antigravity CLI (`agy acp`)** into an always-on, multi-platform engineering assistant. Enable any combination of the **8 built-in adapters** simultaneously via [`MultiChannelHub`](src/channels/hub.ts) — every platform runs behind NAT with **zero public domain or reverse-proxy setup required**.

- **Concurrent Multi-Channel Hub (`MultiChannelHub`)**: Runs up to all 8 channels side by side in one process, namespacing conversations as `<channel>::<rawChatId>` with per-channel health tracking and non-blocking inbound dispatch (a failing channel never crashes healthy ones).
- **Unified Gateway Core**: Every adapter shares fail-closed auth (`ALLOWED_SENDERS` + per-channel `*_ALLOWED_USERS` + 8-char DM pairing), interactive tool approval forwarding, busy turn control (`queue` / `interrupt` / `steer`), media/secret guards, zero-token `/usage`, and persistent `/loop` & `/remind` schedules.
- **Extensible by Design**: Drop in a new `src/channels/<name>.ts` exporting `createAdapter(config)` against [`ChannelAdapter`](src/types.ts) to add any custom platform.

---

## Architecture / 架构设计

```mermaid
flowchart LR
    subgraph Channels["8 Built-in Channel Adapters (Zero Public Domain / NAT-Friendly)"]
        PH["📱 Photon iMessage (photon)<br/>Spectrum Outbound TLS gRPC"]
        TG["✈️ Telegram (telegram)<br/>Native Bot API Long Polling (0 extra deps)"]
        DC["🎮 Discord (discord)<br/>discord.js Gateway WebSocket"]
        SL["💼 Slack (slack)<br/>@slack/bolt Socket Mode"]
        FS["🪶 Feishu / Lark 飞书 (feishu)<br/>Official WSClient Long Connection"]
        DT["🔔 DingTalk 钉钉 (dingtalk)<br/>Official dingtalk-stream Mode"]
        QQ["🐧 QQ / OneBot v11 (onebot)<br/>Forward WS: NapCat/LLOneBot/Lagrange (0 deps)"]
        WH["🔗 Generic Webhook (webhook)<br/>POST /v1/messages + wait:true + SSE /v1/events"]
    end

    subgraph Hub["MultiChannelHub (Concurrent Dispatch & Health)"]
        HB["🔀 Channel Namespace Router<br/>&lt;channel&gt;::&lt;rawChatId&gt; • Fault Isolation"]
    end

    subgraph Core["Gateway Core (Node.js / TypeScript)"]
        RT["🛡️ GatewayRouter<br/>• Fail-closed Auth & 8-Char Pairing<br/>• Busy Queue / Steer / Interrupt<br/>• /channels, Slash Commands & Media Guard"]
        ST["💾 GatewayStore<br/>Atomic JSON state.json"]
        SC["⏰ LoopScheduler<br/>Loops & 0-Token Reminders"]
        HL["🩺 HealthServer<br/>127.0.0.1:18790 (/healthz, /status)"]
    end

    subgraph Agent["AgentBackend (agy acp)"]
        ACP["🤖 AgyAgentBackend<br/>• @agentclientprotocol/sdk (stdio)<br/>• Interactive / Sandbox / Auto Approvals<br/>• Multimodal Media & Session Resume"]
        QU["📊 Zero-Token Quota<br/>agy -p '/usage' --output-format json"]
    end

    PH & TG & DC & SL & FS & DT & QQ & WH <--> HB
    HB <-->|Unified ChannelAdapter| RT
    RT <--> ST
    RT <--> SC
    HL -.->|HealthSnapshot + channels| RT
    RT <-->|AgentTurnInput / Result| ACP
    RT -.->|5h / Weekly Quota| QU
```

---

## Supported Channels / 支持通道一览

Every channel is **optional** and automatically enabled when its credentials are configured in `.env`. Multiple channels run concurrently in `MultiChannelHub`.

| Channel | Name | Transport / SDK | Highlights &amp; NAT Traversal |
| :--- | :--- | :--- | :--- |
| **Photon iMessage** | `photon` | `spectrum-ts` Outbound TLS gRPC | Flagship iMessage / SMS / RCS adapter; 48h dedupe, zombie-stream probe, read receipts &amp; reactions |
| **Telegram** | `telegram` | Native Bot API `getUpdates` Long Polling (**0 extra deps**) | Node 24 built-in `fetch`; group `@bot` / reply gating, photo/doc/voice/audio download, multipart uploads, typing &amp; reactions |
| **Discord** | `discord` | `discord.js` Gateway WebSocket | DM + guild mention gating (`DISCORD_ALLOW_GUILDS`), attachment download/upload, reply references, typing, reactions &amp; edits |
| **Slack** | `slack` | `@slack/bolt` Socket Mode (`xoxb-` + `xapp-`) | Zero public URL; `app_mention` &amp; DM support, `thread_ts` continuity, Bearer file downloads, `filesUploadV2`, emoji reactions |
| **Feishu / Lark 飞书** | `feishu` | Official `@larksuiteoapi/node-sdk` `WSClient` | Feishu (`feishu`) &amp; Lark (`lark`) domains; long connection behind NAT, resource downloads, image/file uploads &amp; reactions |
| **DingTalk 钉钉** | `dingtalk` | Official `dingtalk-stream` Mode | Stream WebSocket robot callback (`TOPIC_ROBOT`); `sessionWebhook` reply caching, `@mention` detection, Markdown replies |
| **QQ / OneBot v11** | `onebot` | Forward WebSocket (**0 extra deps**) | Built-in Node 24 `WebSocket` for NapCat / LLOneBot / Lagrange; full string CQ-code &amp; segment array parsing, auto-reconnect |
| **Generic Webhook / HTTP** | `webhook` | Built-in Node `http` (`127.0.0.1:18791`) | `POST /v1/messages` (Bearer + HMAC-SHA256 + synchronous `wait: true` mode), `callbackUrl` webhooks &amp; `GET /v1/events` SSE stream for Siri Shortcuts, WeCom bridges, or custom apps |

---

## Quick Start / 快速开始

### 1. Prerequisites / 环境准备

- **Node.js `>= 22`** (tested on Node `24`) and **`pnpm`**
- **Google Antigravity CLI (`agy`)** installed on `PATH` and signed in (`agy --version`)
- Credentials for **at least one** of the 8 supported channels

### 2. Install & Configure / 安装与配置

```powershell
git clone https://github.com/Relogys/Antigravity-gateway.git
cd Antigravity-gateway
pnpm install
Copy-Item .env.example .env
```

Edit `.env` (never commit `.env`), configure any channels you want to enable, then validate and start:

```powershell
pnpm cli doctor
pnpm build
pnpm start
```

For TypeScript hot execution during development:

```powershell
pnpm dev
```

---

## Channel Configuration / 各平台环境变量

Every variable below matches [`.env.example`](.env.example). Empty everywhere = deny all (DMs receive an 8-character pairing code instead).

### Per-Channel Credentials &amp; Allowlists / 各平台配置

| Channel | Required Env Vars | Optional Env Vars |
| :--- | :--- | :--- |
| **Photon iMessage** | `SPECTRUM_PROJECT_ID`, `SPECTRUM_PROJECT_SECRET` | `PHOTON_READ_RECEIPTS=true`, `PHOTON_REACTIONS=true` |
| **Telegram** | `TELEGRAM_BOT_TOKEN` | `TELEGRAM_ALLOWED_USERS`, `TELEGRAM_POLL_TIMEOUT_SEC=30` |
| **Discord** | `DISCORD_BOT_TOKEN` | `DISCORD_ALLOWED_USERS`, `DISCORD_ALLOW_GUILDS=false` |
| **Slack** | `SLACK_BOT_TOKEN` (`xoxb-...`), `SLACK_APP_TOKEN` (`xapp-...`) | `SLACK_ALLOWED_USERS` |
| **Feishu / Lark 飞书** | `FEISHU_APP_ID`, `FEISHU_APP_SECRET` | `FEISHU_DOMAIN=feishu` (`feishu` \| `lark`), `FEISHU_ALLOWED_USERS` |
| **DingTalk 钉钉** | `DINGTALK_CLIENT_ID`, `DINGTALK_CLIENT_SECRET` | `DINGTALK_ALLOWED_USERS` |
| **QQ / OneBot v11** | `ONEBOT_WS_URL` (`ws://` or `wss://`) | `ONEBOT_ACCESS_TOKEN`, `ONEBOT_SELF_ID`, `ONEBOT_ALLOWED_USERS` |
| **Webhook / HTTP** | `WEBHOOK_ENABLED=true` | `WEBHOOK_HOST=127.0.0.1`, `WEBHOOK_PORT=18791`, `WEBHOOK_TOKEN`, `WEBHOOK_SECRET`, `WEBHOOK_CALLBACK_URL`, `WEBHOOK_ALLOWED_USERS` |

> [!IMPORTANT]
> **Webhook Security Guard**: `webhook` refuses to bind to a non-loopback `WEBHOOK_HOST` unless `WEBHOOK_TOKEN` or `WEBHOOK_SECRET` is configured. For `POST /v1/messages`, pass `Authorization: Bearer <token>` and/or `X-Webhook-Signature: sha256=<hmac-hex>`. Set `"wait": true` in the request body to receive `{ "ok": true, "messageId": "...", "replies": [...] }` synchronously, or subscribe to `GET /v1/events` (SSE) / `WEBHOOK_CALLBACK_URL`.

### Global Access Control &amp; Core Settings / 全局访问控制与核心配置

```env
# Global allowlist: Photon entries are E.164 phones or Apple ID emails.
# Non-Photon entries use "<channel>:<userId>" (e.g. telegram:123456789, discord:987654321).
# Unioned with per-channel *_ALLOWED_USERS and CLI-paired senders.
ALLOWED_SENDERS=+15550001111,user@example.com
ALLOW_GROUPS=false
GROUP_MENTION_PATTERNS=@agy,@antigravity

# Antigravity CLI (`agy`) backend
AGY_BIN=agy
DEFAULT_CWD=.
APPROVAL_MODE=interactive
DEFAULT_MODEL=
DEFAULT_EFFORT=
GEMINI_API_KEY=

# Optional local health endpoint (disabled by default; strictly localhost)
HEALTH_ENABLED=false
HEALTH_HOST=127.0.0.1
HEALTH_PORT=18790
QUOTA_WARN_THRESHOLD=15

DATA_DIR=./data
LOG_LEVEL=info
```

### Photon Dashboard &amp; Inbound-First Note / Photon 后台与首条消息规则

1. In **Photon Dashboard -> Users**, register the Apple Messages handle you send from (E.164 phone number or Apple ID email; verify your exact identifier at `https://debug.photon.codes`).
2. **Inbound-First Rule**: On Photon shared iMessage pools, **send the first message from your Apple device to your project's assigned number** before the gateway sends outbound replies (`Target not allowed for this project` otherwise).

---

## CLI &amp; Health Endpoint / 命令行与健康检查

### Admin CLI (`pnpm cli ...`)

```powershell
pnpm cli doctor                                      # Check Node, agy, and status of all 8 channels
pnpm cli send --channel telegram --to 123456789 "Hi" # Send a one-off message through any configured channel
pnpm cli status                                      # Query live health endpoint + local store summary
pnpm cli usage                                       # Zero-token Antigravity quota check
pnpm cli pair list                                   # List pending pairing codes & approved senders
pnpm cli pair approve ABCD2345                       # Approve an 8-character DM pairing code
pnpm cli pair revoke telegram:123456789              # Revoke an approved sender
pnpm cli pair clear                                  # Clear all pending pairing requests
```

### `GET /status` &amp; `GET /healthz` Per-Channel Health Output

When `HEALTH_ENABLED=true`, [`HealthServer`](src/health.ts) serves read-only JSON on `127.0.0.1:18790` with per-channel connectivity and timestamps (no secrets or PII):

```json
{
  "status": "ok",
  "startedAt": 1700000000000,
  "uptimeMs": 42500,
  "channelConnected": true,
  "activeSessions": 2,
  "activeTurns": 0,
  "pendingPermissions": 0,
  "activeLoops": 1,
  "channels": {
    "photon": { "name": "photon", "connected": true, "lastInboundAt": 1700000030000, "lastOutboundAt": 1700000032000 },
    "telegram": { "name": "telegram", "connected": true, "lastInboundAt": 1700000040000 }
  }
}
```

- `GET /healthz` returns HTTP `200` (`ok: true`) when `status === "ok"` (or `503` otherwise) with a compact `{ channels: { "<name>": boolean } }` map.
- From any chat, run `/channels` to print the live connection status, last inbound/outbound ages, and any per-channel errors.

---

## Slash Commands / 斜杠命令

### Always Dispatchable While Busy / 运行中随时可触发

| Command | Aliases | Purpose |
| :--- | :--- | :--- |
| `/stop` | `/cancel` | Cancel the active turn immediately |
| `/new` | `/reset` | Cancel active turn, clear queue, and start a fresh ACP session |
| `/status` | — | Show gateway health, uptime, active session, model, effort, mode, CWD, queue, loops |
| `/channels` | — | Show all registered channels, connection state, and last inbound/outbound timing |
| `/usage` | — | Run zero-token Antigravity 5h &amp; weekly quota check |
| `/queue [prompt\|list\|clear]` | `/q` | Enqueue a follow-up prompt, inspect queue, or clear queued prompts |
| `/steer <prompt>` | `/s` | Cancel active turn and redirect immediately with `<prompt>` |
| `/busy [queue\|interrupt\|steer]` | — | Choose how messages arriving mid-turn are handled |
| `/approve [once\|session\|always]` | — | Approve a pending interactive tool permission request |
| `/deny [reason]` | — | Deny a pending interactive tool permission request |
| `/yolo` | — | Toggle `auto` approval mode for the current chat |
| `/whoami` | — | Display normalized sender ID, chat ID, service, and auth source |
| `/help` | `/commands` | Display command reference |
| `/version` | `/v` | Display gateway and Node.js versions |

### Session, Config &amp; Automation (When Idle) / 会话配置与定时任务

| Command | Aliases | Purpose |
| :--- | :--- | :--- |
| `/model [slug]` | — | Show or switch model (supports composite slugs like `gemini-4-neon-high`) |
| `/effort [low\|medium\|high\|xhigh]` | — | Show or set reasoning effort (`thought_level`) |
| `/mode [default\|accept-edits\|auto\|plan]` | — | Show or set ACP session mode |
| `/approvals [auto\|interactive\|sandbox]` | — | Show or set tool approval policy |
| `/sessions` | — | List recent ACP sessions for the active workspace |
| `/resume <id\|index>` | — | Attach and resume a saved ACP session by ID or `/sessions` index |
| `/title [name]` | — | View or set a friendly title for the current chat session |
| `/compact` | `/compress` | Summarize and compact active conversation context |
| `/cwd [path]` | — | View or switch working directory (starts a clean session there) |
| `/discard` | — | Discard local session state and clear pending queue |
| `/loop [list\|add <dur> <prompt>\|rm <id>\|pause <id>\|resume <id>]` | — | Manage recurring prompt loops (e.g. `30m`, `2h`, `1d`) |
| `/remind <dur> <text>` | — | Schedule a one-way reminder push (`0` AI tokens) |

---

## Build a Custom `ChannelAdapter` / 扩展新通道

Add a new module `src/channels/<name>.ts` exporting `createAdapter(config: GatewayConfig): ChannelAdapter` (extend [`BaseChannelAdapter`](src/channels/base.ts) for built-in stats and error isolation), and register its config block in [`src/config.ts`](src/config.ts):

```ts
import type { GatewayConfig } from "../config.js";
import { BaseChannelAdapter, type InboundHandler } from "./base.js";
import type { ChannelAdapter, OutboundMessage } from "../types.js";

export class MyChatAdapter extends BaseChannelAdapter {
  readonly name = "my-chat";

  async start(onMessage: InboundHandler): Promise<void> {
    this.handler = onMessage;
    this.setConnected(true);
    // Emit raw chatId & senderId via `await this.emit({ ... })`; MultiChannelHub namespaces chatId.
  }

  async stop(): Promise<void> {
    this.setConnected(false);
  }

  async sendMessage(msg: OutboundMessage): Promise<{ messageId?: string } | void> {
    this.noteOutbound();
    return { messageId: "outbound-id" };
  }
}

export function createAdapter(config: GatewayConfig): ChannelAdapter {
  return new MyChatAdapter();
}
```

Optional hooks (`sendTyping`, `markRead`, `react`, `editMessage`) are automatically detected and invoked best-effort by `GatewayRouter`.

---

## Windows Autostart Scripts / Windows 开机自启脚本

Portable PowerShell scripts in [`scripts/`](scripts/) resolve paths dynamically via `$PSScriptRoot` (no hardcoded user directories):

| Script | Purpose |
| :--- | :--- |
| [`scripts/start-gateway.ps1`](scripts/start-gateway.ps1) | Builds `dist/index.js` if missing and launches the gateway |
| [`scripts/install-task.ps1`](scripts/install-task.ps1) | Registers Windows Scheduled Task `AntigravityGateway` (`AtLogOn`, hidden window, restart on failure) |
| [`scripts/uninstall-task.ps1`](scripts/uninstall-task.ps1) | Stops and unregisters `AntigravityGateway` |

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-task.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\uninstall-task.ps1
```

---

## Security &amp; Compliance / 安全与合规

- **Official Protocol &amp; Auth Compliance**: Connects strictly through official `agy acp` using your local cached `agy` session or `GEMINI_API_KEY`. Never extracts or reverse-proxies OAuth tokens. (Note: `GEMINI_API_KEY` mode disables `/usage` quota reporting inside `agy`.)
- **Zero Public Listening Ports by Default**: Outbound transports (`photon`, `telegram`, `discord`, `slack`, `feishu`, `dingtalk`, `onebot`) require zero inbound ports; `HealthServer` (`127.0.0.1:18790`) and `webhook` (`127.0.0.1:18791`) are disabled by default, bind to loopback, and `webhook` blocks non-loopback hosts without `WEBHOOK_TOKEN`/`WEBHOOK_SECRET`.
- **Fail-Closed Auth &amp; Secret Audit**: Default-deny DM pairing (8-char unambiguous code, 1h TTL, 5-attempt lockout), outbound `MEDIA:<path>` guard against `.env*`/`.ssh`/private keys, single-instance lock (`<dataDir>/gateway.pid`), and `pnpm audit:secrets` before commits.

---

## License

MIT
