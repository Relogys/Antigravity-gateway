import { generateKeyPairSync, sign, type JsonWebKey, type KeyObject } from "node:crypto";
import { describe, expect, it } from "vitest";
import { GoogleChatChannelAdapter } from "../src/channels/googlechat.js";
import {
  signWebhookBody,
  signWebhookRequest,
  WebhookChannelAdapter,
} from "../src/channels/webhook.js";
import {
  loadConfig,
  type GatewayConfig,
  type GoogleChatConfig,
  type WebhookConfig,
} from "../src/config.js";
import type { InboundMessage } from "../src/types.js";

/* ------------------------------------------------------------------ fixtures */

const DEFAULT_JWKS_URL =
  "https://www.googleapis.com/service_accounts/v1/jwk/chat@system.gserviceaccount.com";
const OIDC_ISSUER = "chat@system.gserviceaccount.com";
const AUDIENCE = "test-project-123456";
const NOW_MS = 1_760_000_000_000;
const NOW_SEC = Math.floor(NOW_MS / 1000);

const WEBHOOK_SECRET = "synthetic-hmac-secret-for-tests";

function baseConfig(): GatewayConfig {
  return loadConfig({ DATA_DIR: "." }, { loadDotenv: false });
}

function gchatConfig(overrides: Partial<GoogleChatConfig> = {}): GoogleChatConfig {
  return {
    enabled: true,
    webhookUrl: "",
    accessToken: "",
    verificationToken: "",
    audience: AUDIENCE,
    webhookHost: "127.0.0.1",
    webhookPort: 0,
    webhookPath: "/googlechat/events",
    allowedUsers: new Set(),
    ...overrides,
  };
}

function webhookConfig(overrides: Partial<WebhookConfig> = {}): WebhookConfig {
  return {
    enabled: true,
    host: "127.0.0.1",
    port: 0,
    secret: WEBHOOK_SECRET,
    allowedUsers: new Set(),
    ...overrides,
  };
}

const { privateKey: KEY_ONE, publicKey: PUBLIC_ONE } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const { privateKey: KEY_TWO, publicKey: PUBLIC_TWO } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});

function jwkOf(publicKey: KeyObject, kid: string): JsonWebKey {
  return { ...publicKey.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" };
}

function b64url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function mintJwt(
  privateKey: KeyObject,
  overrides: {
    kid?: string;
    alg?: string;
    iss?: string;
    aud?: string | string[];
    exp?: number;
    iat?: number;
    nbf?: number;
  } = {},
): string {
  const header = {
    alg: overrides.alg ?? "RS256",
    typ: "JWT",
    kid: overrides.kid ?? "kid-one",
  };
  const payload: Record<string, unknown> = {
    iss: overrides.iss ?? OIDC_ISSUER,
    aud: overrides.aud ?? AUDIENCE,
    exp: overrides.exp ?? NOW_SEC + 600,
  };
  if (overrides.iat !== undefined) payload.iat = overrides.iat;
  if (overrides.nbf !== undefined) payload.nbf = overrides.nbf;
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const signature = sign("RSA-SHA256", Buffer.from(signingInput, "utf8"), privateKey);
  return `${signingInput}.${signature.toString("base64url")}`;
}

function tamperPayload(jwt: string, mutate: (payload: Record<string, unknown>) => void): string {
  const [header, payload, signature] = jwt.split(".");
  const parsed = JSON.parse(Buffer.from(payload!, "base64url").toString("utf8")) as Record<
    string,
    unknown
  >;
  mutate(parsed);
  return `${header}.${b64url(JSON.stringify(parsed))}.${signature}`;
}

interface JwksHarness {
  fetchImpl: typeof fetch;
  calls: () => number;
  setKeys: (keys: JsonWebKey[]) => void;
}

function makeJwksHarness(initial: JsonWebKey[]): JwksHarness {
  let keys = initial;
  let count = 0;
  const fetchImpl = (async (input: RequestInfo | URL) => {
    count += 1;
    expect(String(input)).toBe(DEFAULT_JWKS_URL);
    return new Response(JSON.stringify({ keys }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return {
    fetchImpl,
    calls: () => count,
    setKeys: (next) => {
      keys = next;
    },
  };
}

function chatEvent(messageName: string, text = "hello over oidc"): Record<string, unknown> {
  return {
    type: "MESSAGE",
    eventTime: "2026-01-02T03:04:05.000Z",
    space: { name: "spaces/AAA", type: "DM" },
    message: {
      name: messageName,
      sender: { name: "users/1001" },
      text,
      argumentText: text,
    },
  };
}

async function startGchat(
  cfg: GoogleChatConfig,
  fetchImpl: typeof fetch,
): Promise<{
  adapter: GoogleChatChannelAdapter;
  port: number;
  messages: InboundMessage[];
}> {
  const adapter = new GoogleChatChannelAdapter(
    { ...baseConfig(), googlechat: cfg },
    { fetchImpl, nowFn: () => NOW_MS },
  );
  const messages: InboundMessage[] = [];
  await adapter.start((msg) => {
    messages.push(msg);
  });
  return { adapter, port: adapter.getPort() as number, messages };
}

function postJson(
  port: number,
  path: string,
  payload: Record<string, unknown>,
  bearer?: string,
): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (bearer) {
    headers.authorization = `Bearer ${bearer}`;
  }
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
}

function waitFor(check: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (check()) {
        resolve();
      } else if (Date.now() - start > timeoutMs) {
        reject(new Error("waitFor timed out"));
      } else {
        setTimeout(tick, 5);
      }
    };
    tick();
  });
}

/* ------------------------------------------------------ Google Chat OIDC JWT */

describe("Google Chat OIDC RS256 bearer verification", () => {
  it("accepts a valid RS256 JWT and dispatches the inbound message", async () => {
    const jwks = makeJwksHarness([jwkOf(PUBLIC_ONE, "kid-one")]);
    const { adapter, port, messages } = await startGchat(
      gchatConfig(),
      jwks.fetchImpl,
    );
    try {
      const jwt = mintJwt(KEY_ONE);
      const res = await postJson(
        port,
        "/googlechat/events",
        chatEvent("spaces/AAA/messages/valid-1"),
        jwt,
      );
      expect(res.status).toBe(200);
      await waitFor(() => messages.length === 1);
      expect(messages[0]).toMatchObject({
        channel: "googlechat",
        chatId: "spaces/AAA",
        senderId: "users/1001",
        text: "hello over oidc",
      });
      expect(jwks.calls()).toBe(1);
    } finally {
      await adapter.stop();
    }
  });

  it("rejects a JWT with the wrong audience", async () => {
    const jwks = makeJwksHarness([jwkOf(PUBLIC_ONE, "kid-one")]);
    const { adapter, port, messages } = await startGchat(gchatConfig(), jwks.fetchImpl);
    try {
      const res = await postJson(
        port,
        "/googlechat/events",
        chatEvent("spaces/AAA/messages/bad-aud"),
        mintJwt(KEY_ONE, { aud: "some-other-project" }),
      );
      expect(res.status).toBe(401);
      expect(messages).toHaveLength(0);
    } finally {
      await adapter.stop();
    }
  });

  it("rejects a JWT with the wrong issuer", async () => {
    const jwks = makeJwksHarness([jwkOf(PUBLIC_ONE, "kid-one")]);
    const { adapter, port } = await startGchat(gchatConfig(), jwks.fetchImpl);
    try {
      const res = await postJson(
        port,
        "/googlechat/events",
        chatEvent("spaces/AAA/messages/bad-iss"),
        mintJwt(KEY_ONE, { iss: "evil@system.gserviceaccount.com" }),
      );
      expect(res.status).toBe(401);
    } finally {
      await adapter.stop();
    }
  });

  it("rejects an expired JWT (beyond 60s skew)", async () => {
    const jwks = makeJwksHarness([jwkOf(PUBLIC_ONE, "kid-one")]);
    const { adapter, port, messages } = await startGchat(gchatConfig(), jwks.fetchImpl);
    try {
      const res = await postJson(
        port,
        "/googlechat/events",
        chatEvent("spaces/AAA/messages/expired"),
        mintJwt(KEY_ONE, { exp: NOW_SEC - 120 }),
      );
      expect(res.status).toBe(401);
      expect(messages).toHaveLength(0);
    } finally {
      await adapter.stop();
    }
  });

  it("rejects a JWT whose payload was tampered with after signing", async () => {
    const jwks = makeJwksHarness([jwkOf(PUBLIC_ONE, "kid-one")]);
    const { adapter, port } = await startGchat(gchatConfig(), jwks.fetchImpl);
    try {
      const original = mintJwt(KEY_ONE);
      const tampered = tamperPayload(original, (payload) => {
        payload.aud = "attacker-controlled";
      });
      const res = await postJson(
        port,
        "/googlechat/events",
        chatEvent("spaces/AAA/messages/tampered"),
        tampered,
      );
      expect(res.status).toBe(401);
    } finally {
      await adapter.stop();
    }
  });

  it("refreshes JWKS once on an unknown kid and succeeds after key rotation", async () => {
    const jwks = makeJwksHarness([jwkOf(PUBLIC_ONE, "kid-one")]);
    const { adapter, port, messages } = await startGchat(gchatConfig(), jwks.fetchImpl);
    try {
      const first = await postJson(
        port,
        "/googlechat/events",
        chatEvent("spaces/AAA/messages/pre-rotate"),
        mintJwt(KEY_ONE, { kid: "kid-one" }),
      );
      expect(first.status).toBe(200);
      expect(jwks.calls()).toBe(1);

      // Google rotates its signing key: OLD key is gone, NEW key (kid-two) is served.
      jwks.setKeys([jwkOf(PUBLIC_TWO, "kid-two")]);
      const rotated = await postJson(
        port,
        "/googlechat/events",
        chatEvent("spaces/AAA/messages/post-rotate"),
        mintJwt(KEY_TWO, { kid: "kid-two" }),
      );
      expect(rotated.status).toBe(200);
      expect(jwks.calls()).toBe(2);

      await waitFor(() => messages.length === 2);
    } finally {
      await adapter.stop();
    }
  });

  it("does not re-fetch a still-fresh cached JWKS on later requests", async () => {
    const jwks = makeJwksHarness([jwkOf(PUBLIC_ONE, "kid-one")]);
    const { adapter, port } = await startGchat(gchatConfig(), jwks.fetchImpl);
    try {
      for (let i = 0; i < 3; i += 1) {
        const res = await postJson(
          port,
          "/googlechat/events",
          chatEvent(`spaces/AAA/messages/cached-${i}`),
          mintJwt(KEY_ONE, { kid: "kid-one" }),
        );
        expect(res.status).toBe(200);
      }
      expect(jwks.calls()).toBe(1);
    } finally {
      await adapter.stop();
    }
  });

  it("falls back to the static token only when it is explicitly configured", async () => {
    const jwks = makeJwksHarness([jwkOf(PUBLIC_ONE, "kid-one")]);
    const strict = await startGchat(gchatConfig({ verificationToken: "" }), jwks.fetchImpl);
    try {
      const withBodyToken = await postJson(
        strict.port,
        "/googlechat/events",
        { ...chatEvent("spaces/AAA/messages/no-fallback"), token: "static-token" },
        "not-a-jwt",
      );
      expect(withBodyToken.status).toBe(401);
    } finally {
      await strict.adapter.stop();
    }

    const fallback = await startGchat(
      gchatConfig({ verificationToken: "static-token" }),
      jwks.fetchImpl,
    );
    try {
      const allowed = await postJson(
        fallback.port,
        "/googlechat/events",
        { ...chatEvent("spaces/AAA/messages/fallback"), token: "static-token" },
        "not-a-jwt",
      );
      expect(allowed.status).toBe(200);
    } finally {
      await fallback.adapter.stop();
    }
  });
});

/* ------------------------------------------- Webhook anti-replay & pinning */

function signedHeaders(
  body: string,
  options: { ts?: string; id?: string; signature?: string } = {},
): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (options.ts !== undefined) headers["x-webhook-timestamp"] = options.ts;
  if (options.id !== undefined) headers["x-webhook-id"] = options.id;
  if (options.signature !== undefined) headers["x-webhook-signature"] = options.signature;
  return headers;
}

function postWebhook(
  port: number,
  body: string,
  headers: Record<string, string>,
): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    headers,
    body,
  });
}

async function startWebhook(cfg: WebhookConfig): Promise<{
  adapter: WebhookChannelAdapter;
  port: number;
  messages: InboundMessage[];
}> {
  const adapter = new WebhookChannelAdapter(
    { ...baseConfig(), webhook: cfg },
    { nowFn: () => NOW_MS },
  );
  const messages: InboundMessage[] = [];
  await adapter.start((msg) => {
    messages.push(msg);
  });
  return { adapter, port: adapter.getPort() as number, messages };
}

describe("Webhook anti-replay and sender pinning", () => {
  it("accepts a fresh signed request and rejects an exact replay with 409", async () => {
    const { adapter, port, messages } = await startWebhook(webhookConfig());
    try {
      const body = JSON.stringify({ chatId: "replay-1", text: "hello" });
      const ts = String(NOW_SEC);
      const id = "delivery-abc";
      const headers = signedHeaders(body, {
        ts,
        id,
        signature: signWebhookRequest(WEBHOOK_SECRET, body, ts, id),
      });

      const first = await postWebhook(port, body, headers);
      expect(first.status).toBe(202);

      const replay = await postWebhook(port, body, headers);
      expect(replay.status).toBe(409);

      await waitFor(() => messages.length === 1);
    } finally {
      await adapter.stop();
    }
  });

  it("rejects stale and future timestamps outside the replay window", async () => {
    const { adapter, port } = await startWebhook(webhookConfig());
    try {
      const body = JSON.stringify({ chatId: "stale-1", text: "hello" });

      const staleTs = String(NOW_SEC - 400);
      const stale = await postWebhook(
        port,
        body,
        signedHeaders(body, {
          ts: staleTs,
          id: "delivery-stale",
          signature: signWebhookRequest(WEBHOOK_SECRET, body, staleTs, "delivery-stale"),
        }),
      );
      expect(stale.status).toBe(401);

      const futureTs = String(NOW_SEC + 400);
      const future = await postWebhook(
        port,
        body,
        signedHeaders(body, {
          ts: futureTs,
          id: "delivery-future",
          signature: signWebhookRequest(WEBHOOK_SECRET, body, futureTs, "delivery-future"),
        }),
      );
      expect(future.status).toBe(401);
    } finally {
      await adapter.stop();
    }
  });

  it("does not poison the replay cache with an unauthenticated delivery id", async () => {
    const { adapter, port } = await startWebhook(webhookConfig());
    try {
      const body = JSON.stringify({ chatId: "poison-1", text: "hello" });
      const ts = String(NOW_SEC);
      const id = "delivery-shared";

      const forged = await postWebhook(
        port,
        body,
        signedHeaders(body, {
          ts,
          id,
          signature: signWebhookRequest("wrong-secret", body, ts, id),
        }),
      );
      expect(forged.status).toBe(401);

      const legit = await postWebhook(
        port,
        body,
        signedHeaders(body, {
          ts,
          id,
          signature: signWebhookRequest(WEBHOOK_SECRET, body, ts, id),
        }),
      );
      expect(legit.status).toBe(202);
    } finally {
      await adapter.stop();
    }
  });

  it("requires timestamp and delivery id when requireTimestamp is enabled", async () => {
    const { adapter, port } = await startWebhook(
      webhookConfig({ requireTimestamp: true }),
    );
    try {
      const body = JSON.stringify({ chatId: "strict-1", text: "legacy" });
      const res = await postWebhook(
        port,
        body,
        signedHeaders(body, { signature: signWebhookBody(WEBHOOK_SECRET, body) }),
      );
      expect(res.status).toBe(401);
      const payload = (await res.json()) as { error?: string };
      expect(payload.error).toBe("timestamp and delivery id required");
    } finally {
      await adapter.stop();
    }
  });

  it("pins the sender identity to fixedSenderId, ignoring a spoofed body.senderId", async () => {
    const { adapter, port, messages } = await startWebhook(
      webhookConfig({ fixedSenderId: "ci-bot" }),
    );
    try {
      const body = JSON.stringify({
        chatId: "pinned-1",
        senderId: "admin-user",
        text: "run the deploy",
      });
      const res = await postWebhook(
        port,
        body,
        signedHeaders(body, { signature: signWebhookBody(WEBHOOK_SECRET, body) }),
      );
      expect(res.status).toBe(202);

      await waitFor(() => messages.length === 1);
      expect(messages[0]?.senderId).toBe("ci-bot");
    } finally {
      await adapter.stop();
    }
  });
});