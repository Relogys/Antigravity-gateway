<div align="center">

# 🪐 Antigravity Gateway

**Universal 20-Platform Multi-Channel Messaging Gateway for Google Antigravity (`agy acp`)**

*通用 20 平台多通道 Google Antigravity 消息网关 — 无需公网域名与内网穿透，随时随地通过 iMessage / Telegram / Discord / Slack / 飞书 / 钉钉 / QQ / QQ 官方机器人 / 企业微信 / Matrix / Mattermost / LINE / IRC / Webhook / WhatsApp / Zulip / Rocket.Chat / Signal / Microsoft Teams / Google Chat 远程驱动你的本地 Antigravity Agent*

<p>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/Node.js-22%2B%20%7C%2024%2B-339933?style=for-the-badge&logo=nodedotjs&logoColor=white" alt="Node.js 22+ / 24+" /></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-5.8%2B%20ESM-3178C6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript" /></a>
  <a href="https://agentclientprotocol.com/"><img src="https://img.shields.io/badge/ACP-v1%20(%40agentclientprotocol%2Fsdk)-6E56CF?style=for-the-badge" alt="ACP v1" /></a>
  <a href="#supported-channels--支持通道一览"><img src="https://img.shields.io/badge/Built--in%20Channels-20%20Platforms-0A84FF?style=for-the-badge" alt="20 Built-in Channels" /></a>
  <a href="#supported-channels--支持通道一览"><img src="https://img.shields.io/badge/NAT--Friendly-Zero%20Public%20Domain-8B5CF6?style=for-the-badge" alt="NAT Friendly" /></a>
  <a href="#slash-commands--斜杠命令"><img src="https://img.shields.io/badge/Quota%20Check-0%20Tokens-F59E0B?style=for-the-badge" alt="Zero-Token Quota" /></a>
  <a href="#license"><img src="https://img.shields.io/badge/License-MIT-10B981?style=for-the-badge" alt="MIT License" /></a>
</p>

<p>
  <a href="#architecture--架构设计">Architecture</a> •
  <a href="#supported-channels--支持通道一览">20 Channels</a> •
  <a href="#quick-start--快速开始">Quick Start</a> •
  <a href="docs/QUICKSTART.md">3-Min Guide</a> •
  <a href="#channel-configuration--各平台环境变量">Env Vars</a> •
  <a href="#cli--health-endpoint--命令行与健康检查">CLI &amp; Health</a> •
  <a href="#slash-commands--斜杠命令">Slash Commands</a> •
  <a href="#security--compliance--安全与合规">Security</a>
</p>

</div>

---

## Overview / 项目定位

**Antigravity Gateway** turns local **Google Antigravity CLI (`agy acp`)** into an always-on, multi-platform engineering assistant. Enable any combination of the **20 built-in adapters** simultaneously via [`MultiChannelHub`](src/channels/hub.ts) — every platform runs behind NAT with **zero public domain or reverse-proxy setup required**.

- **Concurrent Multi-Channel Hub (`MultiChannelHub`)**: Runs up to all 20 channels side by side in one process, namespacing conversations as `<channel>::<rawChatId>` with per-channel health tracking and non-blocking inbound dispatch (a failing channel never crashes healthy ones).
- **14 Outbound-Only + 6 Loopback Receivers**: `photon`, `telegram`, `discord`, `slack`, `feishu`, `dingtalk`, `onebot`, `qqbot`, `matrix`, `mattermost`, `irc`, `zulip`, `rocketchat` and `signal` dial out (long polling / WebSocket / TLS) and need **zero inbound ports**; only `webhook`, `wecom`, `line`, `whatsapp`, `teams` and `googlechat` listen on callbacks, and they bind to `127.0.0.1` by default.
- **Unified Gateway Core**: Every adapter shares fail-closed auth (`ALLOWED_SENDERS` + per-channel `*_ALLOWED_USERS` + 8-char DM pairing), interactive tool approval forwarding, busy turn control (`queue` / `interrupt` / `steer`), media/secret guards, zero-token `/usage`, and persistent `/loop` & `/remind` schedules.
- **Extensible by Design**: Drop in a new `src/channels/<name>.ts` exporting `createAdapter(config)` against [`ChannelAdapter`](src/types.ts) to add any custom platform.

---

## Architecture / 架构设计

```mermaid
flowchart LR
    subgraph Outbound["14 Outbound-Only Channels (Zero Inbound Ports / Behind NAT)"]
        PH["📱 Photon iMessage (photon)<br/>Spectrum outbound TLS gRPC"]
        TG["✈️ Telegram (telegram)<br/>Native Bot API long polling (0 extra deps)"]
        DC["🎮 Discord (discord)<br/>discord.js Gateway WebSocket"]
        SL["💼 Slack (slack)<br/>@slack/bolt Socket Mode"]
        FS["🪶 Feishu / Lark 飞书 (feishu)<br/>Official WSClient long connection"]
        DT["🔔 DingTalk 钉钉 (dingtalk)<br/>Official Stream Mode WebSocket"]
        OB["🐧 QQ / OneBot v11 (onebot)<br/>Forward WS: NapCat / LLOneBot / Lagrange (0 extra deps)"]
        QB["🤖 QQ Official Bot / QQ 官方机器人 (qqbot)<br/>OpenAPI v2 WS Gateway: C2C / Group / Guild (0 extra deps)"]
        MX["🧩 Matrix (matrix)<br/>/_matrix/client/v3/sync long polling (0 extra deps)"]
        MM["💬 Mattermost (mattermost)<br/>Native WebSocket + REST v4 (0 extra deps)"]
        IR["🖥️ IRC (irc)<br/>RFC 1459 / IRCv3 TCP + TLS (0 extra deps)"]
        ZP["💬 Zulip (zulip)<br/>Real-Time Events API long polling (0 extra deps)"]
        RC["🚀 Rocket.Chat (rocketchat)<br/>DDP WebSocket + REST v1 (0 extra deps)"]
        SG["🔒 Signal (signal)<br/>signal-cli-rest-api WS + poll fallback (0 extra deps)"]
    end

    subgraph Callback["6 Loopback Callback Receivers (127.0.0.1 by default)"]
        WH["🔗 Generic Webhook / HTTP API (webhook)<br/>POST /v1/messages + wait:true + SSE /v1/events"]
        WC["🏢 WeCom / 企业微信自建应用 (wecom)<br/>WXBizMsgCrypt AES-256-CBC callback + REST push"]
        LN["🟢 LINE (line)<br/>Messaging API webhook: HMAC-SHA256 + replyToken / push"]
        WA["📗 WhatsApp Cloud API (whatsapp)<br/>Graph API + X-Hub-Signature-256 webhook"]
        TM["🟣 Microsoft Teams (teams)<br/>Bot Framework + outgoing HMAC webhook"]
        GC["🔵 Google Chat (googlechat)<br/>Chat App events + REST / incoming webhook"]
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

    PH & TG & DC & SL & FS & DT <--> HB
    OB & QB & MX & MM & IR <--> HB
    ZP & RC & SG <--> HB
    WH & WC & LN & WA & TM & GC <--> HB
    HB <-->|Unified ChannelAdapter| RT
    RT <--> ST
    RT <--> SC
    HL -.->|HealthSnapshot + channels| RT
    RT <-->|AgentTurnInput / Result| ACP
    RT -.->|5h / Weekly Quota| QU
```

---

## Supported Channels / 支持通道一览

Every channel is **optional** and automatically enabled when its credentials are configured in `.env`. Multiple channels run concurrently in `MultiChannelHub` across **20 platforms**; only **5 adapters are SDK-backed** (`spectrum-ts`, `discord.js`, `@slack/bolt`, `@larksuiteoapi/node-sdk`, `dingtalk-stream`), while the other **15 are zero-extra-dependency native Node 24 adapters**.

| Channel | Name | Transport / SDK | Highlights &amp; NAT Traversal |
| :--- | :--- | :--- | :--- |
| **Photon iMessage** | `photon` | `spectrum-ts` Outbound TLS gRPC | Flagship iMessage / SMS / RCS adapter; Spectrum gRPC behind NAT, 48h dedupe, zombie-stream probe, read receipts &amp; reactions |
| **Telegram** | `telegram` | Native Bot API `getUpdates` Long Polling (**0 extra deps**) | Node 24 built-in `fetch`, no inbound port; group `@bot` / reply gating, photo/doc/voice/audio download, multipart uploads, typing &amp; reactions |
| **Discord** | `discord` | `discord.js` Gateway WebSocket | Outbound gateway socket behind NAT; DM + guild mention gating (`DISCORD_ALLOW_GUILDS`), attachment download/upload, reply references, typing, reactions &amp; edits |
| **Slack** | `slack` | `@slack/bolt` Socket Mode (`xoxb-` + `xapp-`) | Zero public URL; `app_mention` &amp; DM support, `thread_ts` continuity, Bearer file downloads, `filesUploadV2`, emoji reactions |
| **Feishu / Lark 飞书** | `feishu` | Official `@larksuiteoapi/node-sdk` `WSClient` | Feishu (`feishu`) &amp; Lark (`lark`) domains; long connection behind NAT, resource downloads, image/file uploads &amp; reactions |
| **DingTalk 钉钉** | `dingtalk` | Official Stream Mode WebSocket | Stream WebSocket robot callback (`TOPIC_ROBOT`) behind NAT; `sessionWebhook` reply caching, `@mention` detection, Markdown replies |
| **QQ / OneBot v11** | `onebot` | Forward WebSocket client (**0 extra deps**) | Built-in Node 24 `WebSocket` for NapCat / LLOneBot / Lagrange; full string CQ-code &amp; segment array parsing, auto-reconnect, behind NAT |
| **QQ Official Bot / QQ 官方机器人** | `qqbot` | Official OpenAPI v2 WebSocket Gateway (**0 extra deps**) | C2C / group / guild delivery; access-token refresh, heartbeat &amp; resume handled natively, `QQBOT_SANDBOX` toggle, no inbound port |
| **WeCom / 企业微信** | `wecom` | `WXBizMsgCrypt` AES-256-CBC callback + REST push (**0 extra deps**) | Self-built app (自建应用) callback receiver on `127.0.0.1:18792` by default, SHA1 signature + AES decrypt/encrypt, passive XML replies and active REST `message/send` pushes |
| **Matrix** | `matrix` | Native `/_matrix/client/v3/sync` long polling (**0 extra deps**) | Works with Element / Beeper / Synapse &amp; friends; `since`-token sync, encrypted-room plain-text replies, outbound upload via media repo |
| **Mattermost** | `mattermost` | Native WebSocket + REST v4 (**0 extra deps**) | Self-hosted team chat behind NAT; `posted` event filtering, thread replies, file download/upload, typing indicators |
| **LINE** | `line` | Messaging API Webhook (HMAC-SHA256 + replyToken / push) (**0 extra deps**) | Webhook listener on `127.0.0.1:18793` by default; `X-Line-Signature` verification over the raw body, `replyToken` fast replies with `push` fallback, image/file messages |
| **IRC** | `irc` | Native RFC 1459 / IRCv3 TCP + TLS (**0 extra deps**) | Outbound client socket behind NAT; `NICK`/`USER` registration, SASL-free `PASS` auth, channel join list, PRIVMSG/NOTICE, auto-reconnect with backoff |
| **WhatsApp Cloud API** | `whatsapp` | Meta Graph API Webhook + REST (**0 extra deps**) | Cloud API `messages` endpoint; `X-Hub-Signature-256` HMAC verification + `hub.verify_token` GET challenge, text plus image/audio/video/document media upload &amp; link, webhook receiver on `127.0.0.1:18794` |
| **Zulip** | `zulip` | Real-Time Events API long polling (**0 extra deps**) | `register` + long-poll `/api/v1/events` behind NAT; stream topics &amp; private messages, optional `ZULIP_REQUIRE_MENTION` gating, API-key auth |
| **Rocket.Chat** | `rocketchat` | Native DDP WebSocket + REST v1 (**0 extra deps**) | `stream-room-messages` subscription behind NAT, `chat.postMessage` REST replies, `@mention` gating, auto-reconnect with backoff |
| **Signal** | `signal` | signal-cli-rest-api WebSocket + HTTP polling fallback (**0 extra deps**) | Self-hosted `signal-cli-rest-api`; `/v1/receive` WebSocket with polling fallback, `/v2/send` replies, 1:1 &amp; group routing, envelope dedupe |
| **Microsoft Teams** | `teams` | Bot Framework + Outgoing / Incoming Webhook (**0 extra deps**) | Outgoing webhook `Authorization: HMAC` verification, Bot Framework client-credentials token with cached `serviceUrl`, Incoming Webhook fallback, thread replies; webhook receiver on `127.0.0.1:18795` |
| **Google Chat** | `googlechat` | Chat App webhook + Chat REST API / Incoming Webhook (**0 extra deps**) | Event webhook on `127.0.0.1:18796` with verification-token / Bearer check, thread continuity, Chat REST `spaces/*/messages` or incoming-webhook replies |
| **Generic Webhook / HTTP API** | `webhook` | Built-in Node `http` (`127.0.0.1:18791`) | `POST /v1/messages` (Bearer + HMAC-SHA256 + synchronous `wait: true` mode), `callbackUrl` webhooks &amp; `GET /v1/events` SSE stream for Siri Shortcuts, custom apps or bridges |

---

## Quick Start / 快速开始

> [!TIP]
> **First time here? Read the [3-Minute Platform Setup Guides &amp; Troubleshooting → docs/QUICKSTART.md](docs/QUICKSTART.md).**
> Copy-paste `.env` recipes and credential walkthroughs for Photon, Telegram, Discord, Slack, Feishu, DingTalk, and OneBot — plus daily-ops commands, Docker, and a troubleshooting FAQ.
>
> 中文提示：第一次使用请先阅读 **[三分钟快速上手 → docs/QUICKSTART.md](docs/QUICKSTART.md)**，内含各平台凭据获取步骤、可直接复制的 `.env`、日常运维命令与常见问题排查。

### 4-Step Quick Start / 四步快速开始

**Prerequisites / 前置条件**: **Node.js `>= 22`** (Node `24` recommended) and **`pnpm`**; **Google Antigravity CLI (`agy`)** on `PATH` and signed in (`agy --version`); credentials for **at least one** of the 20 channels (Telegram needs **0 public domain**).

```bash
# 1) Clone and run the interactive onboarding wizard (alias: pnpm cli init)
git clone https://github.com/Relogys/Antigravity-gateway.git
cd Antigravity-gateway
pnpm setup

# 2) Build once
pnpm build

# 3) Validate Node, agy, every channel, allowlist, and ports
pnpm cli doctor

# 4) Start the background daemon and follow the log
pnpm cli start
pnpm cli logs -n 120
```

> Prefer manual setup? Run `pnpm install`, copy `.env.example` to `.env` (PowerShell: `Copy-Item .env.example .env`), fill in one channel, then `pnpm build` → `pnpm cli doctor` → `pnpm cli start`.

Send a DM to your bot. With an empty allowlist the gateway replies with an **8-character pairing code** — approve it with `pnpm cli pair approve <CODE>` and chat normally. For TypeScript hot execution during development, use `pnpm dev`.

### Docker / 容器

```bash
cp .env.example .env     # fill in at least one channel
docker compose up -d --build
docker compose logs -f
curl http://127.0.0.1:18790/healthz
```

The container runs as the non-root `node` user, reads `./.env` read-only, persists state in `./data`, publishes only `127.0.0.1:18790`, and uses `restart: unless-stopped`. Mount your `agy` binary/credentials or set `GEMINI_API_KEY` — see [`Dockerfile`](Dockerfile) and the [Docker guide](docs/QUICKSTART.md#4-docker--容器部署).

### What you get out of the box / 开箱即用的体验

- **Hermes-grade read receipts &amp; emoji reaction lifecycle**: an inbound message is marked read (**已读**) → reacts **👀** while `agy` works → **👍** on success / **👎** on error. Typing indicators refresh periodically during long turns.
- **Photon dual-layer heartbeat**: a transport heartbeat watchdog plus an application-level probe (`PHOTON_HEARTBEAT_TIMEOUT_MS=180000`, `PHOTON_PROBE_SPACE_ID`) detects half-open iMessage streams and reconnects automatically after hours of idle time.
- **Cross-channel inbound image vision**: photos from Photon, Telegram, Discord, WhatsApp, and Matrix are downloaded, cached, and forwarded to `agy` as native image attachments.
- **Daemon CLI**: `pnpm cli start`, `stop`, `restart`, `logs`, and `status` with a PID lock and graceful shutdown — plus the crash-backoff supervisor in [`scripts/start-gateway.ps1`](scripts/start-gateway.ps1).
- **Docker &amp; Compose**: multi-stage `node:24-slim` image, non-root, built-in `/healthz` `HEALTHCHECK`, loopback-only port publishing.

---

## Channel Configuration / 各平台环境变量

Every variable below matches [`.env.example`](.env.example). Empty everywhere = deny all (DMs receive an 8-character pairing code instead). Leave unused values blank — a channel is simply not registered.

### Enablement Rules / 通道启用规则

| Channel | Registered when |
| :--- | :--- |
| `photon` | **both** `SPECTRUM_PROJECT_ID` and `SPECTRUM_PROJECT_SECRET` are set |
| `telegram` | `TELEGRAM_BOT_TOKEN` is set |
| `discord` | `DISCORD_BOT_TOKEN` is set |
| `slack` | **both** `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN` are set |
| `feishu` | **both** `FEISHU_APP_ID` and `FEISHU_APP_SECRET` are set |
| `dingtalk` | **both** `DINGTALK_CLIENT_ID` and `DINGTALK_CLIENT_SECRET` are set |
| `onebot` | `ONEBOT_WS_URL` is set (gateway dials out to the OneBot implementation) |
| `qqbot` | **both** `QQBOT_APP_ID` and `QQBOT_CLIENT_SECRET` are set |
| `wecom` | **corp id**, **agent id** and **secret** are all set |
| `matrix` | **both** `MATRIX_HOMESERVER_URL` and `MATRIX_ACCESS_TOKEN` are set |
| `mattermost` | **both** `MATTERMOST_BASE_URL` and `MATTERMOST_BOT_TOKEN` are set |
| `line` | **both** `LINE_CHANNEL_ACCESS_TOKEN` and `LINE_CHANNEL_SECRET` are set |
| `irc` | `IRC_HOST` is set (comma-separated `IRC_CHANNELS` to actually join rooms) |
| `whatsapp` | **both** `WHATSAPP_ACCESS_TOKEN` and `WHATSAPP_PHONE_NUMBER_ID` are set |
| `zulip` | **all of** `ZULIP_SITE`, `ZULIP_BOT_EMAIL` and `ZULIP_API_KEY` are set |
| `rocketchat` | **all of** `ROCKETCHAT_URL`, `ROCKETCHAT_USER_ID` and `ROCKETCHAT_AUTH_TOKEN` are set |
| `signal` | **both** `SIGNAL_API_URL` and `SIGNAL_ACCOUNT` are set |
| `teams` | `TEAMS_WEBHOOK_SECRET`, **or both** `TEAMS_APP_ID` + `TEAMS_APP_PASSWORD`, **or** `TEAMS_INCOMING_WEBHOOK_URL` is set |
| `googlechat` | **any of** `GOOGLECHAT_WEBHOOK_URL`, `GOOGLECHAT_ACCESS_TOKEN` or `GOOGLECHAT_VERIFICATION_TOKEN` is set |
| `webhook` | `WEBHOOK_ENABLED=true` |

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
| **QQ Official Bot / QQ 官方机器人** | `QQBOT_APP_ID`, `QQBOT_CLIENT_SECRET` | `QQBOT_SANDBOX=false`, `QQBOT_ALLOWED_USERS` |
| **WeCom / 企业微信** | `WECOM_CORP_ID`, `WECOM_AGENT_ID`, `WECOM_SECRET` | `WECOM_TOKEN`, `WECOM_ENCODING_AES_KEY`, `WECOM_HOST=127.0.0.1`, `WECOM_PORT=18792`, `WECOM_ALLOWED_USERS` |
| **Matrix** | `MATRIX_HOMESERVER_URL`, `MATRIX_ACCESS_TOKEN` | `MATRIX_USER_ID`, `MATRIX_ALLOWED_USERS` |
| **Mattermost** | `MATTERMOST_BASE_URL`, `MATTERMOST_BOT_TOKEN` | `MATTERMOST_ALLOWED_USERS` |
| **LINE** | `LINE_CHANNEL_ACCESS_TOKEN`, `LINE_CHANNEL_SECRET` | `LINE_HOST=127.0.0.1`, `LINE_PORT=18793`, `LINE_ALLOWED_USERS` |
| **IRC** | `IRC_HOST`, `IRC_CHANNELS` (comma-separated) | `IRC_PORT=6697`, `IRC_TLS=true`, `IRC_NICK=antigravity-bot`, `IRC_PASSWORD`, `IRC_ALLOWED_USERS` |
| **WhatsApp Cloud API** | `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID` | `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET`, `WHATSAPP_API_VERSION=v21.0`, `WHATSAPP_WEBHOOK_HOST=127.0.0.1`, `WHATSAPP_WEBHOOK_PORT=18794`, `WHATSAPP_WEBHOOK_PATH=/whatsapp/webhook`, `WHATSAPP_ALLOWED_USERS` |
| **Zulip** | `ZULIP_SITE`, `ZULIP_BOT_EMAIL`, `ZULIP_API_KEY` | `ZULIP_STREAMS`, `ZULIP_REQUIRE_MENTION=true`, `ZULIP_ALLOWED_USERS` |
| **Rocket.Chat** | `ROCKETCHAT_URL`, `ROCKETCHAT_USER_ID`, `ROCKETCHAT_AUTH_TOKEN` | `ROCKETCHAT_REQUIRE_MENTION=true`, `ROCKETCHAT_ALLOWED_USERS` |
| **Signal** | `SIGNAL_API_URL`, `SIGNAL_ACCOUNT` | `SIGNAL_POLL_INTERVAL_MS=3000`, `SIGNAL_ALLOWED_USERS` |
| **Microsoft Teams** | `TEAMS_WEBHOOK_SECRET`, or `TEAMS_APP_ID` + `TEAMS_APP_PASSWORD`, or `TEAMS_INCOMING_WEBHOOK_URL` | `TEAMS_TENANT_ID=botframework.com`, `TEAMS_WEBHOOK_HOST=127.0.0.1`, `TEAMS_WEBHOOK_PORT=18795`, `TEAMS_WEBHOOK_PATH=/teams/messages`, `TEAMS_ALLOWED_USERS` |
| **Google Chat** | `GOOGLECHAT_WEBHOOK_URL`, or `GOOGLECHAT_ACCESS_TOKEN`, or `GOOGLECHAT_VERIFICATION_TOKEN` | `GOOGLECHAT_WEBHOOK_HOST=127.0.0.1`, `GOOGLECHAT_WEBHOOK_PORT=18796`, `GOOGLECHAT_WEBHOOK_PATH=/googlechat/events`, `GOOGLECHAT_ALLOWED_USERS` |
| **Generic Webhook / HTTP API** | `WEBHOOK_ENABLED=true` | `WEBHOOK_HOST=127.0.0.1`, `WEBHOOK_PORT=18791`, `WEBHOOK_TOKEN`, `WEBHOOK_SECRET`, `WEBHOOK_CALLBACK_URL`, `WEBHOOK_ALLOWED_USERS` |

### Per-Channel `.env` Blocks / 各平台配置块

```env
# Photon / Spectrum iMessage (enabled iff BOTH are set)
SPECTRUM_PROJECT_ID=
SPECTRUM_PROJECT_SECRET=
PHOTON_READ_RECEIPTS=true
PHOTON_REACTIONS=true

# Telegram (Bot API long polling)
TELEGRAM_BOT_TOKEN=
TELEGRAM_ALLOWED_USERS=
TELEGRAM_POLL_TIMEOUT_SEC=30

# Discord (discord.js)
DISCORD_BOT_TOKEN=
DISCORD_ALLOWED_USERS=
DISCORD_ALLOW_GUILDS=false

# Slack (Socket Mode: bot token xoxb-... + app-level token xapp-...)
SLACK_BOT_TOKEN=
SLACK_APP_TOKEN=
SLACK_ALLOWED_USERS=

# Feishu / Lark (domain: feishu | lark)
FEISHU_APP_ID=
FEISHU_APP_SECRET=
FEISHU_DOMAIN=feishu
FEISHU_ALLOWED_USERS=

# DingTalk (Stream mode)
DINGTALK_CLIENT_ID=
DINGTALK_CLIENT_SECRET=
DINGTALK_ALLOWED_USERS=

# OneBot v11 / QQ (forward-WS client; e.g. ws://127.0.0.1:<port>)
ONEBOT_WS_URL=
ONEBOT_ACCESS_TOKEN=
ONEBOT_SELF_ID=
ONEBOT_ALLOWED_USERS=

# QQ Bot (enabled iff app id and client secret are set)
QQBOT_APP_ID=
QQBOT_CLIENT_SECRET=
QQBOT_SANDBOX=false
QQBOT_ALLOWED_USERS=

# WeCom / Enterprise WeChat (enabled iff corp id, agent id, and secret are set)
WECOM_CORP_ID=
WECOM_AGENT_ID=
WECOM_SECRET=
WECOM_TOKEN=
WECOM_ENCODING_AES_KEY=
WECOM_HOST=127.0.0.1
WECOM_PORT=18792
WECOM_ALLOWED_USERS=

# Matrix (enabled iff homeserver URL and access token are set)
MATRIX_HOMESERVER_URL=
MATRIX_ACCESS_TOKEN=
MATRIX_USER_ID=
MATRIX_ALLOWED_USERS=

# Mattermost (enabled iff base URL and bot token are set)
MATTERMOST_BASE_URL=
MATTERMOST_BOT_TOKEN=
MATTERMOST_ALLOWED_USERS=

# LINE Messaging API (enabled iff access token and channel secret are set)
LINE_CHANNEL_ACCESS_TOKEN=
LINE_CHANNEL_SECRET=
LINE_HOST=127.0.0.1
LINE_PORT=18793
LINE_ALLOWED_USERS=

# IRC (enabled when a host is set; channels are comma-separated)
IRC_HOST=
IRC_PORT=6697
IRC_TLS=true
IRC_NICK=antigravity-bot
IRC_PASSWORD=
IRC_CHANNELS=
IRC_ALLOWED_USERS=

# WhatsApp Cloud API (Meta Graph API; enabled iff access token + phone number id are set)
WHATSAPP_ACCESS_TOKEN=
WHATSAPP_PHONE_NUMBER_ID=
WHATSAPP_VERIFY_TOKEN=
WHATSAPP_APP_SECRET=
WHATSAPP_API_VERSION=v21.0
WHATSAPP_WEBHOOK_HOST=127.0.0.1
WHATSAPP_WEBHOOK_PORT=18794
WHATSAPP_WEBHOOK_PATH=/whatsapp/webhook
WHATSAPP_ALLOWED_USERS=

# Zulip (Real-Time Events API long polling behind NAT; enabled iff site + email + api key are set)
ZULIP_SITE=
ZULIP_BOT_EMAIL=
ZULIP_API_KEY=
ZULIP_STREAMS=
ZULIP_REQUIRE_MENTION=true
ZULIP_ALLOWED_USERS=

# Rocket.Chat (DDP WebSocket behind NAT + REST v1; enabled iff url + user id + auth token are set)
ROCKETCHAT_URL=
ROCKETCHAT_USER_ID=
ROCKETCHAT_AUTH_TOKEN=
ROCKETCHAT_REQUIRE_MENTION=true
ROCKETCHAT_ALLOWED_USERS=

# Signal (via self-hosted signal-cli-rest-api WS/poll behind NAT; enabled iff api url + account are set)
SIGNAL_API_URL=
SIGNAL_ACCOUNT=
SIGNAL_POLL_INTERVAL_MS=3000
SIGNAL_ALLOWED_USERS=

# Microsoft Teams (Outgoing Webhook HMAC or Bot Framework or Incoming Webhook)
TEAMS_WEBHOOK_SECRET=
TEAMS_APP_ID=
TEAMS_APP_PASSWORD=
TEAMS_TENANT_ID=botframework.com
TEAMS_INCOMING_WEBHOOK_URL=
TEAMS_WEBHOOK_HOST=127.0.0.1
TEAMS_WEBHOOK_PORT=18795
TEAMS_WEBHOOK_PATH=/teams/messages
TEAMS_ALLOWED_USERS=

# Google Chat (Chat App webhook + REST API or Incoming Webhook)
GOOGLECHAT_WEBHOOK_URL=
GOOGLECHAT_ACCESS_TOKEN=
GOOGLECHAT_VERIFICATION_TOKEN=
GOOGLECHAT_WEBHOOK_HOST=127.0.0.1
GOOGLECHAT_WEBHOOK_PORT=18796
GOOGLECHAT_WEBHOOK_PATH=/googlechat/events
GOOGLECHAT_ALLOWED_USERS=

# Generic Webhook / HTTP (avoid other local agents' ports 8789/9119/8765; health uses 18790)
WEBHOOK_ENABLED=false
WEBHOOK_HOST=127.0.0.1
WEBHOOK_PORT=18791
WEBHOOK_TOKEN=
WEBHOOK_SECRET=
WEBHOOK_CALLBACK_URL=
WEBHOOK_ALLOWED_USERS=
```

> [!NOTE]
> **Loopback Listeners / 本地回调端口**: `webhook` (`18791`), `wecom` (`18792`), `line` (`18793`), `whatsapp` (`18794`), `teams` (`18795`) and `googlechat` (`18796`) bind to `127.0.0.1` by default, alongside the optional `HealthServer` (`18790`). Only expose a callback receiver through your own TLS reverse proxy or tunnel when the platform genuinely requires it — the other 14 channels never listen at all.

### Local Ports / 本地端口

| Port | Service | Endpoint / Notes |
| :--- | :--- | :--- |
| `18790` | `HealthServer` | Optional (`HEALTH_ENABLED=true`); `GET /healthz`, `GET /status` |
| `18791` | `webhook` | `POST /v1/messages`, `GET /v1/events` (SSE) |
| `18792` | `wecom` | Self-built app (自建应用) callback |
| `18793` | `line` | Messaging API webhook |
| `18794` | `whatsapp` | Cloud API verification (`hub.challenge`) + message events |
| `18795` | `teams` | Outgoing webhook / Bot Framework activities |
| `18796` | `googlechat` | Chat App event webhook |

All listeners above default to `127.0.0.1`. Override the host only through `*_HOST` / `*_WEBHOOK_HOST` with a deliberate TLS reverse proxy or tunnel in front.

> [!IMPORTANT]
> **Webhook Security Guard**: `webhook` refuses to bind to a non-loopback `WEBHOOK_HOST` unless `WEBHOOK_TOKEN` or `WEBHOOK_SECRET` is configured. For `POST /v1/messages`, pass `Authorization: Bearer <token>` and/or `X-Webhook-Signature: sha256=<hmac-hex>`. Set `"wait": true` in the request body to receive `{ "ok": true, "messageId": "...", "replies": [...] }` synchronously, or subscribe to `GET /v1/events` (SSE) / `WEBHOOK_CALLBACK_URL`.

> [!TIP]
> **Inbound Callback Signature Verification / 回调验签**: `wecom` verifies the SHA1 `msg_signature` + `timestamp` + `nonce` triple and decrypts `Encrypt` payloads with `WECOM_ENCODING_AES_KEY` (WXBizMsgCrypt AES-256-CBC), replying passively in XML; `line` verifies `X-Line-Signature` with `LINE_CHANNEL_SECRET` (HMAC-SHA256 over the raw body) and answers via `replyToken`, falling back to `push`. `whatsapp` answers the `hub.verify_token` challenge and verifies `X-Hub-Signature-256` (HMAC-SHA256) with `WHATSAPP_APP_SECRET`; `teams` verifies `Authorization: HMAC <base64>` with `TEAMS_WEBHOOK_SECRET` for outgoing webhooks (app credentials are used for outbound Bot Framework replies); `googlechat` checks `GOOGLECHAT_VERIFICATION_TOKEN` against the event `token` or a Bearer header. Configure the matching secret/token so unsigned or tampered callbacks are rejected.

### Global Access Control &amp; Core Settings / 全局访问控制与核心配置

```env
# Global allowlist: Photon entries are E.164 phone numbers or Apple ID emails.
# Entries for other channels use "<channel>:<userId>" (e.g. telegram:<userId>, irc:<nick>).
# Unioned with per-channel *_ALLOWED_USERS and CLI-paired senders.
ALLOWED_SENDERS=<E.164-number>,<apple-id>@example.com
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
pnpm cli start                                         # Start the gateway as a background daemon (logs/gateway.log)
pnpm cli start --foreground                            # Run in the foreground instead
pnpm cli stop                                          # Graceful stop (SIGTERM; taskkill fallback on Windows)
pnpm cli restart                                       # Stop + start
pnpm cli logs -n 200                                   # Tail the rotating log file
pnpm cli doctor                                        # Check Node, agy, and status of all 20 channels
pnpm cli send --channel telegram --to <userId> "Hi"    # Send a one-off message through any configured channel
pnpm cli status                                        # Query live health endpoint + local store summary
pnpm cli usage                                         # Zero-token Antigravity quota check
pnpm cli pair list                                     # List pending pairing codes & approved senders
pnpm cli pair approve ABCD2345                         # Approve an 8-character DM pairing code
pnpm cli pair revoke telegram:<userId>                  # Revoke an approved sender
pnpm cli pair clear                                    # Clear all pending pairing requests
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
    "telegram": { "name": "telegram", "connected": true, "lastInboundAt": 1700000040000 },
    "whatsapp": { "name": "whatsapp", "connected": true, "lastInboundAt": 1700000045000 },
    "zulip": { "name": "zulip", "connected": true, "lastInboundAt": 1700000048000 },
    "wecom": { "name": "wecom", "connected": true, "lastInboundAt": 1700000050000 }
  }
}
```

- `GET /healthz` returns HTTP `200` (`ok: true`) when `status === "ok"` (or `503` otherwise) with a compact `{ channels: { "<name>": boolean } }` map.
- From any chat, run `/channels` to print the live connection status, last inbound/outbound ages, and any per-channel errors for **all 20 adapters**.

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
| [`scripts/start-gateway.ps1`](scripts/start-gateway.ps1) | Builds `dist/index.js` if missing, then supervises the gateway with crash backoff (2s→60s) and 5 MB log rotation |
| [`scripts/install-task.ps1`](scripts/install-task.ps1) | Registers Windows Scheduled Task `AntigravityGateway` (`AtLogOn`, hidden window, restart on failure) |
| [`scripts/uninstall-task.ps1`](scripts/uninstall-task.ps1) | Stops and unregisters `AntigravityGateway` |

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-task.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\uninstall-task.ps1
```

---

## Security &amp; Compliance / 安全与合规

- **Official Protocol &amp; Auth Compliance**: Connects strictly through official `agy acp` using your local cached `agy` session or `GEMINI_API_KEY`. Never extracts or reverse-proxies OAuth tokens. (Note: `GEMINI_API_KEY` mode disables `/usage` quota reporting inside `agy`.)
- **Zero Public Listening Ports by Default**: The 14 outbound transports (`photon`, `telegram`, `discord`, `slack`, `feishu`, `dingtalk`, `onebot`, `qqbot`, `matrix`, `mattermost`, `irc`, `zulip`, `rocketchat`, `signal`) dial out over long polling / WebSocket / TLS and require zero inbound ports. The 6 callback receivers (`webhook` `127.0.0.1:18791`, `wecom` `127.0.0.1:18792`, `line` `127.0.0.1:18793`, `whatsapp` `127.0.0.1:18794`, `teams` `127.0.0.1:18795`, `googlechat` `127.0.0.1:18796`) and `HealthServer` (`127.0.0.1:18790`) are disabled or loopback-only by default; `webhook` additionally blocks non-loopback hosts without `WEBHOOK_TOKEN`/`WEBHOOK_SECRET`.
- **Signed Callbacks**: Inbound HTTP callbacks are verified before dispatch — `webhook` (Bearer token + HMAC-SHA256 `X-Webhook-Signature`), `wecom` (SHA1 `msg_signature` + AES-256-CBC WXBizMsgCrypt decrypt), `line` (`X-Line-Signature` HMAC-SHA256 over the raw body), `whatsapp` (`hub.verify_token` GET challenge + `X-Hub-Signature-256` HMAC-SHA256), `teams` (`Authorization: HMAC` with `TEAMS_WEBHOOK_SECRET` for outgoing webhooks), `googlechat` (`GOOGLECHAT_VERIFICATION_TOKEN` event token or Bearer header).
- **Fail-Closed Auth &amp; Secret Audit**: Default-deny DM pairing (8-char unambiguous code, 1h TTL, 5-attempt lockout) across all 20 channels, outbound `MEDIA:<path>` guard against `.env*`/`.ssh`/private keys, single-instance lock (`<dataDir>/gateway.pid`), and `pnpm audit:secrets` before commits.

---

## License

MIT
