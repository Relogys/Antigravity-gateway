# 🚀 3-Minute Quick Start & Platform Setup Guide

> Turn your local **Google Antigravity CLI (`agy acp`)** into an always-on assistant on **20 chat platforms** — no public domain, no port forwarding, no reverse proxy for most channels.
>
> 中文提示：本指南面向第一次使用的同学，照抄命令即可。多数平台 3 分钟内就能跑通，所有密钥只写入本地 `.env`，永不提交到 Git。

**Contents / 目录**

1. [Before you start / 开始之前](#0-before-you-start--开始之前)
2. [The 3-Minute Quick Start / 三分钟快速开始](#1-the-3-minute-quick-start--三分钟快速开始)
3. [Credentials + minimal `.env` recipes / 凭据获取与最小配置](#2-credentials--minimal-env-recipes--凭据获取与最小配置)
4. [Daily operations / 日常运维](#3-daily-operations--日常运维)
5. [Docker / 容器部署](#4-docker--容器部署)
6. [Troubleshooting FAQ / 常见问题](#5-troubleshooting-faq--常见问题)
7. [Security checklist / 安全清单](#6-security-checklist--安全清单)

---

## 0. Before you start / 开始之前

| Requirement | Check | Notes |
| :--- | :--- | :--- |
| **Node.js >= 22** (24 recommended) | `node --version` | Node 24 is the tested target. |
| **pnpm** | `pnpm --version` | Missing? Run `corepack enable pnpm`. |
| **Google Antigravity CLI (`agy`)** | `agy --version` | Run `agy` once interactively to sign in. |
| **One platform account** | — | Telegram is the fastest (0 public domain needed). |

> 中文提示：`agy` 未登录时，网关能启动但无法回复；请先在终端手动运行一次 `agy` 完成登录，或用 `GEMINI_API_KEY` 模式。
>
> **Note**: `GEMINI_API_KEY` mode disables `/usage` quota reporting. With the cached `agy` session, `pnpm cli usage` works with **0 model tokens**.

---

## 1. The 3-Minute Quick Start / 三分钟快速开始

```bash
git clone https://github.com/Relogys/Antigravity-gateway.git
cd Antigravity-gateway

pnpm setup        # 1) interactive onboarding wizard (alias: pnpm cli init)
pnpm build        # 2) compile TypeScript once
pnpm cli doctor   # 3) validate Node, agy, channels, allowlist, ports
pnpm cli start    # 4) start the background daemon
pnpm cli logs -n 120
```

> 中文提示：`pnpm setup` 会引导你选择平台并把凭据写入 `.env`。若你的代码版本还没有该向导，请使用等价的手动步骤（见下方说明）。

**Prefer manual setup? / 想手动配置：**

```bash
pnpm install
cp .env.example .env     # Windows PowerShell: Copy-Item .env.example .env
# edit .env and fill in ONE platform (see section 2)
pnpm build
pnpm cli doctor
pnpm cli start
```

### What each step does / 每一步在做什么

| Step | Command | Result |
| :--- | :--- | :--- |
| 1 | `pnpm setup` (`pnpm cli init`) | Writes `.env`, picks a channel, sets your allowlist. |
| 2 | `pnpm build` | Compiles `src/` to `dist/` (required by `pnpm cli start`). |
| 3 | `pnpm cli doctor` | Prints `[OK]` / `[WARN]` / `[FAIL]` for Node, `agy`, all 20 channels, allowlist, health port, and PID lock. Exits non-zero on failures. |
| 4 | `pnpm cli start` | Launches the gateway detached, writes `data/gateway.pid`, logs to `logs/gateway.log`. |

### Your first conversation / 第一次对话

1. DM your bot from the platform (or `@`-mention it in an allowed group).
2. With an **empty allowlist**, the gateway replies with an **8-character pairing code** (1-hour TTL, 5-attempt lockout). This is fail-closed by design.
3. Approve it once:

   ```bash
   pnpm cli pair list
   pnpm cli pair approve <CODE>
   ```

4. Chat normally. `/help` lists every slash command; `/status` shows gateway health.

> 中文提示：也可以提前把平台用户 ID 写入 `ALLOWED_SENDERS`（格式 `<channel>:<userId>`）或对应的 `*_ALLOWED_USERS`，这样就无需配对。

For hot-reload development / 开发模式：

```bash
pnpm dev
```

---

## 2. Credentials + minimal `.env` recipes / 凭据获取与最小配置

Only configure the platforms you need. **Blank values = channel disabled.** Never commit `.env`; validate with `pnpm cli doctor` after every edit.

> 中文提示：`*_ALLOWED_USERS` 是逗号分隔的平台用户 ID，按需填入；留空时依靠 8 位配对码授权。

### 1) Photon iMessage (flagship / 旗舰通道)

**Console path / 后台路径**: **Spectrum Dashboard → Project → Project ID + Project Secret**; then **Users → register your Apple Messages handle** (E.164 phone number or Apple ID email). Verify the exact identifier with the Spectrum debug tool before registering.

> **Inbound-first rule / 首条消息规则**: on shared iMessage pools, **send the first message from your Apple device to your project's assigned number** before expecting outbound replies (`Target not allowed for this project` otherwise).

Minimal `.env`:

```env
SPECTRUM_PROJECT_ID=<project-id>
SPECTRUM_PROJECT_SECRET=<project-secret>
PHOTON_READ_RECEIPTS=true
PHOTON_REACTIONS=true
```

Optional resilience / 可选断线自愈:

```env
PHOTON_HEARTBEAT_TIMEOUT_MS=180000
PHOTON_PROBE_SPACE_ID=<a-photon-space-where-the-bot-is-active>
```

Rendering / 气泡长度上限:

```env
# Cap each iMessage bubble; 1600 keeps long replies from folding/collapsing on iOS.
PHOTON_MAX_CHUNK_CHARS=1600
```

What you get / 体验：

- **Dual-layer heartbeat**: a transport heartbeat watchdog plus an application-level probe that catches half-open gRPC streams (see [FAQ](#photon-stops-replying-after-hours-idle--photon-闲置数小时后不再回复)).
- **Read receipts & reactions**: the inbound message is marked read (**已读**) → reacts **👀** while `agy` is working → **👍** on success / **👎** on error. Typing indicators refresh periodically on long turns.
- **Native iMessage rendering**: Markdown keeps its styling even with URLs; wide tables become mobile cards and render errors fall back to plain text.
- **Native iMessage commands**: `/poll <question> | <opt1> | <opt2>`, `/bg [preset|clear|list]` (24 presets), `/unsend` (~2-minute window), and `/card` (Share Name and Photo).
- Images sent to the bot are downloaded and forwarded to `agy` as native image attachments.

### 2) Telegram (easiest, 0 public domain / 最简单)

1. In Telegram, message **@BotFather** → `/newbot` → choose a name and username → copy the **bot token**.
2. Message **@userinfobot** → copy your **numeric user ID**.
3. Nothing else — the gateway uses native Bot API **long polling**; no webhook, no public domain.

Minimal `.env`:

```env
TELEGRAM_BOT_TOKEN=<bot-token>
TELEGRAM_ALLOWED_USERS=<your-numeric-user-id>
```

> 中文提示：Telegram 不需要公网域名或反代，最适合第一次验证。群聊中需 `@` 提及机器人（回复消息也可触发）。

### 3) Discord

1. Open the **Discord Developer Portal → Applications → New Application**.
2. **Bot → Reset Token** → copy the bot token.
3. **Bot → Privileged Gateway Intents → enable Message Content Intent** (required to read message text).
4. Invite the bot with the `bot` scope and message permissions.
5. Get your own Discord user ID (Settings → Advanced → Developer Mode → right-click yourself → Copy User ID).

Minimal `.env`:

```env
DISCORD_BOT_TOKEN=<bot-token>
DISCORD_ALLOWED_USERS=<your-discord-user-id>
DISCORD_ALLOW_GUILDS=false
```

> 中文提示：默认只响应私信；需要服务器频道时把 `DISCORD_ALLOW_GUILDS=true` 并谨慎配置权限。

### 4) Slack (Socket Mode, 0 public URL / 无需公网地址)

1. **api.slack.com/apps → Create New App → From scratch**.
2. **Basic Information → App-Level Tokens** → generate a token with `connections:write` → this is your `xapp-` token.
3. **OAuth & Permissions → Bot Token Scopes**: `app_mentions:read`, `chat:write`, `im:history`, `im:read`, `files:read`, `files:write`, optional `reactions:write`. Install to workspace → copy the `xoxb-` token.
4. **Socket Mode → toggle ON**.
5. **Event Subscriptions → Subscribe to bot events**: `app_mention`, `message.im`.
6. Get your Slack member ID from your profile → **Copy member ID**.

Minimal `.env`:

```env
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
SLACK_ALLOWED_USERS=<your-slack-member-id>
```

> 中文提示：Socket Mode 由网关主动外连，**不需要公网域名**；线程回复会自动保持 `thread_ts` 上下文。

### 5) Feishu / Lark 飞书

1. Open **Feishu Open Platform** (or **Lark Open Platform** for international) → **创建企业自建应用 / Create custom app**.
2. **Credentials & Basic Info / 凭证与基础信息** → copy **App ID** and **App Secret**.
3. Add the **Bot / 机器人** capability; grant message permissions (`im:message`, `im:message:send_as_bot`, `im:resource`).
4. **Events & Callbacks / 事件与回调** → subscribe `im.message.receive_v1` → choose **long connection (WebSocket) / 使用长连接接收事件** — no public URL.
5. Publish a version and have an admin approve it.

Minimal `.env`:

```env
FEISHU_APP_ID=<app-id>
FEISHU_APP_SECRET=<app-secret>
FEISHU_DOMAIN=feishu
```

Use `FEISHU_DOMAIN=lark` for the international Lark domain.

> 中文提示：务必选择“长连接”事件订阅方式，否则需要公网回调地址。

### 6) DingTalk 钉钉

1. Open **DingTalk Open Platform / 钉钉开放平台** → create an app (企业内部应用).
2. Add a **Robot / 机器人**; choose **Stream Mode / Stream 模式**.
3. **Credentials / 凭证** → copy **Client ID (AppKey)** and **Client Secret (AppSecret)**.
4. Publish and add the robot to a group.

Minimal `.env`:

```env
DINGTALK_CLIENT_ID=<client-id>
DINGTALK_CLIENT_SECRET=<client-secret>
```

> 中文提示：Stream 模式同样是网关主动外连，无需公网地址；群聊中需 `@` 机器人。

### 7) QQ / OneBot v11 (NapCat / LLOneBot / Lagrange)

1. Run a OneBot v11 implementation such as **NapCat**, **LLOneBot**, or **Lagrange**.
2. Enable its **WebSocket server** (forward WS) and note the URL + optional access token.
3. Point the gateway at it. If the gateway runs on the host: `ws://127.0.0.1:<onebot-port>`. If the gateway runs in Docker: use `host.docker.internal` or a shared Compose network.

Minimal `.env`:

```env
ONEBOT_WS_URL=ws://127.0.0.1:<onebot-port>
ONEBOT_ACCESS_TOKEN=<ws-token-if-configured>
```

> 中文提示：OneBot 适配器是 **客户端**，由网关主动连接你的 NapCat / LLOneBot / Lagrange，因此同样无需公网域名。QQ 官方机器人请改用 `QQBOT_APP_ID` + `QQBOT_CLIENT_SECRET`。

### 8) More platforms / 更多平台（简要指引）

| Platform | Where to get credentials | Minimal `.env` | Public endpoint? |
| :--- | :--- | :--- | :--- |
| **WhatsApp Cloud API** | Meta for Developers → App → WhatsApp → API Setup (permanent access token + phone number ID); App Secret for signature verification | `WHATSAPP_ACCESS_TOKEN=<token>`<br>`WHATSAPP_PHONE_NUMBER_ID=<phone-number-id>`<br>`WHATSAPP_VERIFY_TOKEN=<random-verify-token>`<br>`WHATSAPP_APP_SECRET=<app-secret>` | **Yes** — HTTPS webhook (tunnel/reverse proxy) |
| **Microsoft Teams** | Outgoing webhook secret **or** Bot Framework App ID/Password **or** Incoming Webhook URL | `TEAMS_WEBHOOK_SECRET=<secret>`<br>or `TEAMS_APP_ID` + `TEAMS_APP_PASSWORD`<br>or `TEAMS_INCOMING_WEBHOOK_URL=<url>` | Outgoing webhook: yes |
| **Signal** | Self-host `signal-cli-rest-api`; link/register a number there | `SIGNAL_API_URL=<rest-api-url>`<br>`SIGNAL_ACCOUNT=<e164-number>` | No (WS + poll) |
| **Matrix** | Log in with a bot account and create an access token (Element: Settings → Help & About → Access Token) | `MATRIX_HOMESERVER_URL=<https-homeserver>`<br>`MATRIX_ACCESS_TOKEN=<access-token>`<br>`MATRIX_USER_ID=@bot:<homeserver>` | No (`/sync` long poll) |
| **Generic Webhook / HTTP API** | You define the token/secret | `WEBHOOK_ENABLED=true`<br>`WEBHOOK_TOKEN=<random-token>`<br>`WEBHOOK_SECRET=<random-hmac-secret>` | Only if you expose it |

More platforms are documented in the main [README channel table](../README.md#supported-channels--支持通道一览): WeCom (企业微信), LINE, Google Chat, IRC, Zulip, Rocket.Chat, Mattermost, and QQ Official Bot. Each is enabled purely by setting its credentials.

> 中文提示：除 WhatsApp / Teams / WeCom / LINE / Google Chat 这类回调式平台外，其余 14 个通道都是**主动外连**，天然穿透 NAT，无需公网地址。

### Validate your configuration / 校验配置

```bash
pnpm cli doctor
```

`doctor` prints one line per channel: `configured` or `disabled` plus a non-secret hint. It never prints tokens, user IDs, or secrets.

### Rich rendering & live progress / 富文本渲染与实时进度

No configuration is required — the gateway adapts outbound Markdown per platform and falls back to plain text on any render error:

| Platform | What you get |
| :--- | :--- |
| **Photon iMessage** | Native UTF-16 Markdown (URLs included), mobile cards for wide tables, `PHOTON_MAX_CHUNK_CHARS=1600` bubble cap against iOS fold/collapse, automatic plain-text fallback. |
| **Telegram** | Native HTML (`parse_mode: "HTML"`) with plain-text retry on parse errors; `editMessage` / `deleteMessage`. |
| **Discord & Slack** | `editMessage` / `deleteMessage`; IDE `file:///` links removed. |
| **IRC, LINE, Signal, OneBot** | Markdown converted to readable plain text. |
| **All channels** | IDE `file:///` links sanitized globally — local paths never leak into chat. |

During long turns, editable channels (Telegram, Discord, Slack, …) update **a single compact tool-call card in place** instead of spamming messages:

```env
TOOL_PROGRESS_MODE=auto                   # auto | edit | silence | off
TOOL_PROGRESS_KEEP=false                  # false deletes the card on completion; true keeps a summary
TOOL_PROGRESS_EDIT_INTERVAL_MS=1500       # throttle between in-place edits
```

- `auto` → edit-in-place where supported, silence pulses on iMessage (avoids Apple's 5-edit cap).
- Change it live from any chat: `/progress [auto|edit|silence|off|keep|delete]` (`-h` shows help).
- `keep`/`delete` controls whether the final tool-call summary stays above the answer.

> 中文提示：无需额外配置。iMessage 会自动限制单条气泡长度并降级为纯文本；长任务期间只在可编辑渠道原地刷新一张工具进度卡片，默认完成后删除，可用 `/progress keep` 保留摘要。

---

## 3. Daily operations / 日常运维

| Command | What it does |
| :--- | :--- |
| `pnpm cli start` | Start the gateway as a background daemon (PID in `data/gateway.pid`, logs in `logs/gateway.log`). |
| `pnpm cli start --foreground` | Run in the foreground (Ctrl+C to stop). |
| `pnpm cli stop` | Graceful shutdown (`SIGTERM`, then `taskkill` fallback on Windows); cleans stale PID files. |
| `pnpm cli restart` | Stop + start. |
| `pnpm cli logs -n 200` | Print the last 200 lines of the rotating log file. |
| `pnpm cli status` | Query the live health endpoint (`/status`) and persisted store summary. |
| `pnpm cli doctor` | Full environment / channel / allowlist / port diagnostics. |
| `pnpm cli pair list` | List pending pairing codes and approved senders. |
| `pnpm cli pair approve <CODE>` | Approve an 8-character pairing code. |
| `pnpm cli pair revoke <sender>` | Revoke an approved sender. |
| `pnpm cli usage` | Zero-token Antigravity quota check (5-hour + weekly). |
| `pnpm cli send --channel telegram --to <chatId> "Hi"` | Send a one-off message through any configured channel. |

> 中文提示：`pnpm cli logs` 只打印日志末尾；它不是 `-f` 跟随模式。持续观察请重复执行或使用 `Get-Content -Wait` / `tail -f`。

### Windows autostart / 开机自启

```powershell
# Register a Scheduled Task ("AntigravityGateway", AtLogOn, hidden window)
powershell -ExecutionPolicy Bypass -File .\scripts\install-task.ps1

# Remove it
powershell -ExecutionPolicy Bypass -File .\scripts\uninstall-task.ps1
```

### Crash-backoff supervisor / 崩溃自动重启

`scripts/start-gateway.ps1` builds `dist/index.js` if missing, then supervises the gateway:

- Restarts on crash with **exponential backoff** (2s → 60s, capped at 60s).
- Resets the delay after 60s of healthy runtime.
- Rotates `logs/gateway.log` at **5 MB** (keeps `.1`–`.3`).
- Use `-OneShot` to exit on first crash instead of restarting.

---

## 4. Docker / 容器部署

The included [`Dockerfile`](../Dockerfile) is a multi-stage build on `node:24-slim`:

- `corepack enable pnpm` + `pnpm install --frozen-lockfile` (reproducible).
- `pnpm build`, then a slim runtime with production dependencies only.
- Runs as the non-root **`node`** user.
- `HEALTHCHECK` against `http://127.0.0.1:18790/healthz`.

Quick start:

```bash
cp .env.example .env     # fill in at least one channel
docker compose up -d --build
docker compose logs -f
curl http://127.0.0.1:18790/healthz
```

What `docker-compose.yml` gives you:

- `./.env` mounted **read-only** at `/app/.env`.
- `./data` mounted at `/app/data` for sessions, pairings, loops, and the PID file.
- Only `127.0.0.1:18790` published (health/status) — **loopback only** on the host.
- `restart: unless-stopped`.

> 中文提示：容器内健康服务监听 `0.0.0.0:18790` 以便端口映射生效，但 Compose 只把它发布到宿主机 `127.0.0.1`，外网不可直连。

### The `agy` backend inside Docker / 容器里的 `agy`

The image ships the **gateway**, not Google Antigravity. Choose one:

1. **Mount your `agy` CLI + credentials** into the container (binary at a path on `PATH`, plus its config/credential directory read-only), **or**
2. **Set `GEMINI_API_KEY`** in `.env` (quota reporting via `/usage` is unavailable in this mode).

Check inside the container:

```bash
docker compose exec gateway node --version
docker compose exec gateway agy --version
```

### Callback platforms in Docker / 回调平台

`webhook`, `wecom`, `line`, `whatsapp`, `teams`, and `googlechat` bind to loopback by default on ports `18791`–`18796`. To receive callbacks in Docker:

1. Set the matching `*_HOST` / `*_WEBHOOK_HOST` to `0.0.0.0` inside the container.
2. Publish the port to the **host loopback only**, e.g. `127.0.0.1:18794:18794`.
3. Put a TLS tunnel or reverse proxy in front (see [FAQ](#webhook-platforms-behind-nat--回调平台在-nat-后)).

> 中文提示：不要把这些回调端口直接暴露到公网；务必用 Cloudflare Tunnel / Tailscale Funnel / 反代并保留原始请求体用于验签。

### Data permissions / 数据目录权限（Linux）

The container runs as UID 1000 (`node`). Ensure the host data directory is writable:

```bash
mkdir -p data
sudo chown -R 1000:1000 data
```

---

## 5. Troubleshooting FAQ / 常见问题

### Bot receives messages but doesn't reply / 收到消息但不回复

Work through this checklist in order:

1. **Is the daemon alive?** → `pnpm cli status`
   - Unreachable `/status` usually means the gateway is stopped or `HEALTH_ENABLED=false`.
2. **Read the logs** → `pnpm cli logs -n 200`
   - Look for channel connection errors, auth failures, `agy` errors, or a pending approval request.
3. **Authorization** → `pnpm cli pair list`
   - Empty allowlist + no approved sender = **deny all**. The sender should have received an 8-character code; approve with `pnpm cli pair approve <CODE>`.
   - Or pre-approve via `ALLOWED_SENDERS` (`<channel>:<userId>`) / `*_ALLOWED_USERS`.
4. **Backend** → `agy --version`, then run `agy` once to sign in. Run `pnpm cli doctor`.
   - With `GEMINI_API_KEY`, confirm the key is valid; `/usage` quota reporting is disabled in this mode.
5. **Interactive approval waiting** → the agent may be blocked on a tool permission. Reply `/approve` or `/deny` (or `/yolo` to switch that chat to auto approval).
6. **Busy queue** → `/queue list`; messages arriving mid-turn follow your busy mode (`queue` / `interrupt` / `steer`).
7. **Channel-specific checks**:
   - **Photon**: inbound-first rule; send the first message from your Apple device.
   - **Slack**: Socket Mode ON, `app_mention` + `message.im` subscribed, correct scopes.
   - **Discord**: Message Content Intent enabled.
   - **Feishu**: event subscription set to **long connection**, version published and approved.
   - **DingTalk**: robot uses **Stream mode**.
   - **Telegram/Discord**: verify `*_ALLOWED_USERS` matches the numeric/ID exactly.

> 中文提示：90% 的“不回复”来自三处——allowlist 未授权、`agy` 未登录、以及交互式工具审批在等待 `/approve`。

### Photon stops replying after hours idle / Photon 闲置数小时后不再回复

iMessage/gRPC streams can become **half-open**: the connection looks alive (heartbeats keep pulsing) but no messages are delivered. The gateway defends with a **dual-layer heartbeat**:

1. **Transport heartbeat watchdog** — if no transport heartbeat arrives within `PHOTON_HEARTBEAT_TIMEOUT_MS` (**default `180000` = 3 minutes**), the adapter reconnects the stream.
2. **Application-level probe** — a synthetic probe is posted into `PHOTON_PROBE_SPACE_ID` to verify end-to-end delivery. This catches half-open streams that still pulse heartbeats but silently drop messages.
3. **Zombie-inbound detection** — inbound messages that never finish processing also trigger a reconnect.

Recommended configuration:

```env
PHOTON_HEARTBEAT_TIMEOUT_MS=180000
PHOTON_PROBE_SPACE_ID=<a-space-where-the-bot-is-active>
```

- Set `PHOTON_PROBE_SPACE_ID` to a real conversation/space where the bot is active so probes have a valid target.
- Keep the default timeout; a value of `0` disables the heartbeat probe (not recommended).
- Look for `heartbeat missing … reconnecting` in `pnpm cli logs` to confirm recovery.
- If replies never resume, run `pnpm cli restart` and check the Spectrum project/phone registration again.

> 中文提示：这不是“进程挂了”，而是长连接半开。双层心跳会自动重连；务必配置 `PHOTON_PROBE_SPACE_ID` 才能真正探测“能收到消息”而不只是“连接还在”。

### Webhook platforms behind NAT / 回调平台在 NAT 后

Only these need **inbound** HTTP: `webhook` (`18791`), `wecom` (`18792`), `line` (`18793`), `whatsapp` (`18794`), `teams` (`18795`), `googlechat` (`18796`). They bind `127.0.0.1` by default. Three common options:

**Cloudflare Tunnel**

```bash
cloudflared tunnel --url http://127.0.0.1:18794
```

Use the generated HTTPS URL as the WhatsApp webhook callback.

**Tailscale Funnel**

```bash
tailscale funnel 18794
```

**Reverse proxy (Caddy / nginx)** on the same host, terminating TLS and proxying to the loopback port.

Requirements for all three:

- **TLS** in front; never expose plain HTTP to the internet.
- **Preserve the raw request body** — HMAC verification (LINE, WhatsApp, generic webhook) is computed over the exact bytes.
- Configure the platform's verify token / signature secret (`WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET`, `LINE_CHANNEL_SECRET`, `TEAMS_WEBHOOK_SECRET`, etc.).
- Expose **only the required path**, not the whole gateway; never publish `18790` publicly.
- In Docker, either run the tunnel/proxy in the same network namespace, or set `*_HOST=0.0.0.0` and publish the port to host loopback only.

> 中文提示：14 个主动外连通道（Photon / Telegram / Discord / Slack / 飞书 / 钉钉 / OneBot / QQ 官方 / Matrix / Mattermost / IRC / Zulip / Rocket.Chat / Signal）**完全不需要**这一步。

### Other quick fixes / 其他常见问题

| Symptom | Fix |
| :--- | :--- |
| `pnpm: command not found` | `corepack enable pnpm` (or install pnpm 10+). |
| `pnpm setup` / `pnpm cli init` not found | Use the manual path: `pnpm install`, copy `.env.example` → `.env`, `pnpm build`. |
| `Built entry point not found` | Run `pnpm build` before `pnpm cli start`. |
| `Health port 18790 already in use` | Another instance is running; `pnpm cli stop`, or change `HEALTH_PORT`. |
| Stale PID / “already running” but nothing responds | `pnpm cli stop` cleans stale PID files; retry `pnpm cli start`. |
| Docker `EACCES` writing `./data` | `sudo chown -R 1000:1000 data` (Linux). |
| `agy: not found` in container | Mount the `agy` binary/credentials or set `GEMINI_API_KEY`. |
| Emoji reactions missing | Platform or channel disables reactions; set `PHOTON_REACTIONS=true` for Photon. Replies still work. |
| Typing indicator disappears quickly | Normal; it refreshes periodically during long turns and may be throttled by the platform. |
| Long iMessage replies fold/collapse | Lower `PHOTON_MAX_CHUNK_CHARS` (e.g. `1200`); wide tables render as mobile cards automatically. |
| No live tool-call card | The channel may lack `editMessage`; use `/progress edit` on Telegram/Discord/Slack, or `/progress auto` to reset. |

---

## 6. Security checklist / 安全清单

- [ ] `.env` stays local — never committed. Run `pnpm audit:secrets` before committing.
- [ ] Keep callback bindings on `127.0.0.1`; expose through a TLS tunnel only when a platform requires it.
- [ ] Leave `ALLOWED_SENDERS` and `*_ALLOWED_USERS` minimal; prefer 8-character pairing for one-off access.
- [ ] Keep group access disabled (`ALLOW_GROUPS=false`) unless you need it, and rely on mention gating.
- [ ] In Docker, run as the non-root `node` user (default) and mount `.env` read-only.
- [ ] Rotate any token immediately if it was pasted into a chat, log, or issue.

For the full threat model, see [`SECURITY.md`](../SECURITY.md). For architecture, the 20-platform matrix, slash commands, and every environment variable, see the [README](../README.md).