# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Added

#### Wave 5 & Wave 6 — Onboarding, reliability & containers

- Photon iMessage **dual-layer heartbeat**: a transport heartbeat watchdog
  (`PHOTON_HEARTBEAT_TIMEOUT_MS`, default `180000`) combined with an
  application-level probe (`PHOTON_PROBE_SPACE_ID`) and zombie-inbound
  detection, so half-open gRPC streams are detected and reconnected after long
  idle periods.
- **Daemon lifecycle CLI**: `pnpm cli start | stop | restart | logs` with a PID
  file, stale-lock cleanup, graceful `SIGTERM` (with a Windows `taskkill`
  fallback), background log capture, and foreground mode.
- Crash-backoff supervisor `scripts/start-gateway.ps1` (2s→60s exponential
  restart delay, 5 MB log rotation) and Windows Scheduled Task autostart via
  `scripts/install-task.ps1`.
- Rotating, redacting file logger (`RotatingFileLogger`): size-based rotation
  (`gateway.log` → `.1` → `.3`) that masks bearer tokens, Slack/Discord/Telegram
  tokens, provider API keys, and Spectrum project secrets before writing.
- **Cross-channel inbound image bridge**: images from Photon, Telegram,
  Discord, WhatsApp, and Matrix are downloaded, cached, and forwarded to `agy`
  as native image attachments; the outbound media guard still blocks
  `.env*`/`.ssh`/private-key paths.
- Hermes-grade **reaction lifecycle and read receipts**: `已读` (read) → `👀`
  while working → `👍` on success / `👎` on error, with periodically refreshed
  typing indicators during long turns.
- Interactive first-run onboarding wizard entry point (`pnpm setup`, alias
  `pnpm cli init`) with a documented manual fallback (`pnpm install` +
  `.env.example`).
- `docs/QUICKSTART.md`: bilingual 3-minute quick start, per-platform credential
  recipes (Photon, Telegram, Discord, Slack, Feishu/Lark, DingTalk, OneBot, plus
  WhatsApp/Teams/Signal/Matrix/Webhook pointers), a daily-operations cheat
  sheet, and a troubleshooting FAQ.
- **Docker support**: multi-stage `Dockerfile` on `node:24-slim` (corepack
  pnpm, frozen-lockfile install, non-root `node` user, `/healthz`
  `HEALTHCHECK`), `docker-compose.yml` (read-only `.env`, `./data` volume,
  loopback-only `127.0.0.1:18790`, `restart: unless-stopped`), and
  `.dockerignore`.

#### CI, documentation & cross-channel tests

- GitHub Actions CI workflow (`.github/workflows/ci.yml`) that runs on pushes to
  `main` and on pull requests, on a Node.js `[22, 24]` matrix with pnpm caching.
  Each job installs from the frozen lockfile, then runs typecheck, build, the
  full test suite, and the secret audit.
- `SECURITY.md` documenting the fail-closed authorization model, 8-character
  pairing codes with lockouts, loopback-default listeners, timing-safe webhook
  verification, secret hygiene, and coordinated vulnerability disclosure.
- `CHANGELOG.md` (this file).
- Cross-channel test coverage (`tests/multichannel-20.test.ts`) asserting that
  all 20 channels enable, construct, isolate their allowlists, round-trip
  qualified chat ids, and route outbound/inbound messages through the hub.

### Changed

- Redesigned the README top-level Quick Start around a 4-step copy-paste
  onboarding flow (`pnpm setup` → `pnpm build` → `pnpm cli doctor` →
  `pnpm cli start`), with a prominent link to `docs/QUICKSTART.md`, a Docker
  subsection, and a summary of the new read-receipt, heartbeat, image-vision,
  daemon CLI, and container capabilities.

### Security

- Documented and pinned the default-deny posture for every transport, including
  loopback-only health and callback servers and constant-time signature checks.

## 0.1.0 - 2026-11-26

First public release. The gateway evolved from a single iMessage bridge into a
20-channel hub while keeping one fail-closed authorization path.

### Added

#### Core gateway (Photon iMessage + Antigravity ACP v1)

- Photon Spectrum iMessage transport with read receipts, reactions, media
  handling, and inbound-first delivery support.
- Antigravity `agy acp` backend over the Agent Client Protocol (ACP v1), using
  the local cached `agy` session or `GEMINI_API_KEY`.
- Read-only local health server (`GET /healthz`, `GET /status`) bound to
  `127.0.0.1`.
- Session manager with serialized turns, prompt queueing, busy modes
  (queue/interrupt/steer), and cancellation.
- Loop scheduler and reminders (`/loop`, `/remind`) persisted across restarts.
- Admin CLI (`pnpm cli`) for doctor checks, one-off sends, pairing approvals and
  revocations, quota checks, and live status.
- Slash commands for session, model, effort, mode, approvals, queue, and
  scheduled automation control.

#### Multi-channel hub (8 channels)

- `MultiChannelHub` running many adapters concurrently behind one interface,
  with channel-qualified chat ids, per-channel health snapshots, and isolated
  start failures.
- New adapters: Telegram, Discord, Slack (Socket Mode), Feishu/Lark, DingTalk
  (Stream mode), OneBot v11 / QQ, and a generic HTTP/webhook adapter.
- Per-channel allowlists (`<CHANNEL>_ALLOWED_USERS`) and channel-namespaced
  global `ALLOWED_SENDERS` entries.
- Fail-closed DM pairing with 8-character codes, expiry, rate limiting, and
  lockouts; channel-aware `/channels` and `/whoami` reports.

#### Expansion to 14 channels

- Added WeCom/WeChat Work, QQ Bot, Matrix, Mattermost, LINE Messaging API, and
  IRC adapters.
- Loopback-only callback receivers for WeCom and LINE with signature
  verification and passive replies.
- Expanded health reporting to list every active channel with last
  inbound/outbound timestamps and errors.

#### Expansion to 20 channels

- Added WhatsApp Cloud API (Meta Graph API), Zulip, Rocket.Chat, Signal (via
  `signal-cli-rest-api`), Microsoft Teams, and Google Chat adapters.
- Signed callbacks across webhook platforms: WhatsApp `X-Hub-Signature-256`,
  Teams `Authorization: HMAC`, Google Chat verification token, plus existing
  WeCom and LINE verification.
- Six loopback-default callback receivers (`webhook`, `wecom`, `line`,
  `whatsapp`, `teams`, `googlechat`) alongside the health server.
- `pnpm audit:secrets` repository scanner plus `.env.example` placeholder
  conventions (`your-...` values are treated as unset).

### Security

- Default-deny authorization for all channels; empty allowlists authorize no
  one.
- Group access disabled by default and gated on explicit mentions.
- Timing-safe HMAC/signature comparisons with length checks for inbound
  callbacks.
- Outbound media guard blocking `.env*`, `.ssh`, and private-key material.
- Single-instance PID lock and secret audit to reduce accidental exposure.

