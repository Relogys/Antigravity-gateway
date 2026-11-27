#!/usr/bin/env node
// Zero-dependency sender for the "Antigravity Gateway Notify" composite action.
//
// Mirrors the gateway's inbound webhook auth (src/channels/webhook.ts): every
// request carries X-Webhook-Timestamp (Unix seconds) and X-Webhook-Id, and when
// a secret is configured the signature is
//   sha256 = HMAC-SHA256(secret, `${timestamp}.${deliveryId}.${rawBody}`)
// so a captured request cannot be replayed with a different body.

import { createHmac, randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

export const DEFAULT_TIMEOUT_MS = 30_000;

function toUnixSeconds(timestamp) {
  const value = Number(timestamp ?? Date.now() / 1000);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("timestamp must be a positive Unix time");
  }
  return String(Math.floor(value >= 1e12 ? value / 1000 : value));
}

function redactUrl(raw) {
  try {
    const url = new URL(raw);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "<invalid-url>";
  }
}

function parseBoolean(raw, fallback = false) {
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(String(raw).trim().toLowerCase());
}

/**
 * Build the headers for a gateway webhook request.
 *
 * @param {object} options
 * @param {string} options.body Raw JSON body that will be sent.
 * @param {string} [options.secret] HMAC secret; omitting it sends no signature.
 * @param {string} [options.token] Bearer token for inbound HTTP auth.
 * @param {string|number} [options.timestamp] Unix seconds (or milliseconds).
 * @param {string} [options.deliveryId] Delivery id; defaults to a random UUID.
 * @returns {Record<string, string>}
 */
export function buildSignedWebhookHeaders({
  body,
  secret,
  token,
  timestamp = Math.floor(Date.now() / 1000),
  deliveryId = randomUUID(),
} = {}) {
  if (typeof body !== "string") {
    throw new TypeError("buildSignedWebhookHeaders: body must be a string");
  }
  const ts = toUnixSeconds(timestamp);
  const id = String(deliveryId ?? "").trim();
  if (!id) {
    throw new Error("buildSignedWebhookHeaders: deliveryId is required");
  }

  const headers = {
    "Content-Type": "application/json",
    "User-Agent": "antigravity-gateway-notify-action",
    "X-Webhook-Timestamp": ts,
    "X-Webhook-Id": id,
  };

  if (secret) {
    const signature = createHmac("sha256", secret)
      .update(`${ts}.${id}.${body}`)
      .digest("hex");
    headers["X-Webhook-Signature"] = `sha256=${signature}`;
  }

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  return headers;
}

/**
 * POST a message to an Antigravity Gateway webhook endpoint.
 *
 * @param {object} options
 * @param {string} options.url Gateway endpoint, e.g. https://gateway.example.com/v1/messages
 * @param {string} options.chatId Target chat id.
 * @param {string} options.text Message body.
 * @param {string} [options.senderId] Optional sender id.
 * @param {string} [options.token] Optional Bearer token.
 * @param {string} [options.secret] Optional HMAC secret.
 * @param {boolean} [options.wait] Wait for the agent reply payload.
 * @param {number} [options.timeoutMs] Request timeout in milliseconds.
 * @param {typeof fetch} [options.fetchImpl] Inject a fetch implementation (tests).
 * @returns {Promise<{status: number, messageId: string | undefined, replies: Array<object>}>}
 */
export async function sendWebhookNotification({
  url,
  chatId,
  text,
  senderId,
  token,
  secret,
  wait = false,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!url || typeof url !== "string") {
    throw new Error("sendWebhookNotification: url is required");
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("sendWebhookNotification: url is not a valid absolute URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("sendWebhookNotification: url must use http or https");
  }
  if (!chatId || typeof chatId !== "string") {
    throw new Error("sendWebhookNotification: chatId is required");
  }
  if (typeof text !== "string" || text.trim() === "") {
    throw new Error("sendWebhookNotification: text is required");
  }
  const timeout = Number(timeoutMs);
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new Error("sendWebhookNotification: timeoutMs must be a positive number");
  }
  if (typeof fetchImpl !== "function") {
    throw new Error("sendWebhookNotification: no fetch implementation available");
  }

  const payload = { chatId, text };
  const trimmedSender = typeof senderId === "string" ? senderId.trim() : "";
  if (trimmedSender) {
    payload.senderId = trimmedSender;
  }
  if (wait === true) {
    payload.wait = true;
    payload.timeoutMs = timeout;
  }

  const body = JSON.stringify(payload);
  const headers = buildSignedWebhookHeaders({ body, secret, token });
  const target = redactUrl(url);

  let response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(timeout),
    });
  } catch (error) {
    if (error?.name === "TimeoutError" || error?.name === "AbortError") {
      throw new Error(`Webhook request to ${target} timed out after ${timeout}ms`);
    }
    throw new Error(
      `Webhook request to ${target} failed: ${error?.message ?? String(error)}`,
    );
  }

  const raw = await response.text();
  if (!response.ok) {
    const detail = raw.trim().slice(0, 500) || "(empty response body)";
    throw new Error(`Webhook request to ${target} failed with HTTP ${response.status}: ${detail}`);
  }

  let data = {};
  if (raw.trim()) {
    try {
      data = JSON.parse(raw);
    } catch {
      if (wait === true) {
        throw new Error(`Webhook response from ${target} was not valid JSON`);
      }
      data = {};
    }
  }

  return {
    status: response.status,
    messageId: typeof data.messageId === "string" ? data.messageId : undefined,
    replies: Array.isArray(data.replies) ? data.replies : [],
  };
}

/** Append GitHub Actions step outputs using the multiline-safe delimiter syntax. */
function writeGithubOutputs(values) {
  const outputFile = process.env.GITHUB_OUTPUT;
  if (!outputFile) {
    return;
  }
  let chunk = "";
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === null) {
      continue;
    }
    const delimiter = `EOF_${randomUUID().replaceAll("-", "")}`;
    chunk += `${key}<<${delimiter}\n${String(value)}\n${delimiter}\n`;
  }
  appendFileSync(outputFile, chunk);
}

async function main() {
  const result = await sendWebhookNotification({
    url: (process.env.GATEWAY_URL ?? "").trim(),
    chatId: (process.env.GATEWAY_CHAT_ID ?? "").trim(),
    text: process.env.GATEWAY_TEXT ?? "",
    senderId: process.env.GATEWAY_SENDER_ID ?? "",
    token: (process.env.GATEWAY_TOKEN ?? "").trim(),
    secret: process.env.GATEWAY_SECRET ?? "",
    wait: parseBoolean(process.env.GATEWAY_WAIT),
    timeoutMs: Number(process.env.GATEWAY_TIMEOUT_MS || DEFAULT_TIMEOUT_MS),
  });

  writeGithubOutputs({
    "message-id": result.messageId ?? "",
    "replies-json": JSON.stringify(result.replies),
  });

  const suffix = result.messageId ? `, message id ${result.messageId}` : "";
  console.error(`Delivered to gateway (HTTP ${result.status})${suffix}`);
  if (result.replies.length > 0) {
    console.error(`Received ${result.replies.length} reply payload(s)`);
  }
}

const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
const invokedDirectly =
  entry === import.meta.url ||
  (process.platform === "win32" && entry.toLowerCase() === import.meta.url.toLowerCase());

if (invokedDirectly) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`::error::${message}`);
    process.exitCode = 1;
  });
}