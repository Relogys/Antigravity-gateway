# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Added

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

