import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  chooseSendFormat,
  chunkMessage,
  extractOutboundMedia,
  normalizeSpaceId,
  sanitizeForIMessage,
} from "../src/photon/format.js";
import {
  StreamStalenessWatchdog,
  isProbeChannelAliveRejection,
} from "../src/photon/staleness.js";

describe("normalizeSpaceId", () => {
  it("normalizes DM routing prefixes and bare phone numbers to E.164", () => {
    expect(normalizeSpaceId("any;-;+15550001234")).toBe("+15550001234");
    expect(normalizeSpaceId("iMessage;-;+15550001234")).toBe("+15550001234");
    expect(normalizeSpaceId("SMS;-;1 (555) 000-1234")).toBe("+15550001234");
    expect(normalizeSpaceId("+15550001234")).toBe("+15550001234");
  });

  it("normalizes Apple ID email handles to lowercase", () => {
    expect(normalizeSpaceId("any;-;Alice.User@Example.COM")).toBe(
      "alice.user@example.com",
    );
    expect(normalizeSpaceId("iMessage;-;Bob@Example.org")).toBe(
      "bob@example.org",
    );
  });

  it("preserves group chat GUIDs containing ;+;", () => {
    expect(normalizeSpaceId("  any;+;chat1234567890abcdef  ")).toBe(
      "any;+;chat1234567890abcdef",
    );
    expect(normalizeSpaceId("iMessage;+;chat99887766")).toBe(
      "iMessage;+;chat99887766",
    );
  });
});

describe("chooseSendFormat & sanitizeForIMessage", () => {
  it("selects richlink for bare URLs and text when URLs appear inline", () => {
    expect(chooseSendFormat("https://example.com/docs/page")).toEqual({
      mode: "richlink",
      content: "https://example.com/docs/page",
    });

    expect(
      chooseSendFormat("Check out https://example.com/docs for details."),
    ).toEqual({
      mode: "text",
      content: "Check out https://example.com/docs for details.",
    });
  });

  it("selects markdown by default for non-URL text and text when preferMarkdown is false", () => {
    expect(chooseSendFormat("**Hello** world")).toEqual({
      mode: "markdown",
      content: "**Hello** world",
    });

    expect(chooseSendFormat("**Hello** world", false)).toEqual({
      mode: "text",
      content: "**Hello** world",
    });
  });

  it("tidies markdown headings, tables, and horizontal rules while preserving code blocks", () => {
    const input = [
      "### Summary",
      "",
      "| Name | Status |",
      "| --- | --- |",
      "| Build | Pass |",
      "| Tests | Pass |",
      "",
      "---",
      "",
      "```ts",
      "# comment inside code",
      "| keep | pipe |",
      "```",
    ].join("\n");

    const sanitized = sanitizeForIMessage(input);
    expect(sanitized).toContain("**Summary**");
    expect(sanitized).toContain("• Name: Build | Status: Pass");
    expect(sanitized).toContain("• Name: Tests | Status: Pass");
    expect(sanitized).toContain("———");
    expect(sanitized).toContain("# comment inside code");
    expect(sanitized).toContain("| keep | pipe |");
    expect(sanitized).not.toContain("| --- | --- |");
  });
});

describe("chunkMessage", () => {
  it("leaves short messages unchanged", () => {
    expect(chunkMessage("Short message.", 100)).toEqual(["Short message."]);
  });

  it("chunks multi-paragraph text within maxLen with [i/n] prefixes", () => {
    const paragraphA = "First paragraph with several words to fill space cleanly.";
    const paragraphB = "Second paragraph with more text so it splits across chunks.";
    const paragraphC = "Third paragraph rounding out the test payload.";
    const combined = `${paragraphA}\n\n${paragraphB}\n\n${paragraphC}`;

    const chunks = chunkMessage(combined, 75);
    expect(chunks.length).toBeGreaterThan(1);
    for (let i = 0; i < chunks.length; i += 1) {
      const chunk = chunks[i]!;
      expect(chunk.length).toBeLessThanOrEqual(75);
      expect(chunk.startsWith(`[${i + 1}/${chunks.length}] `)).toBe(true);
    }
  });

  it("hard-splits a single oversized word safely within maxLen", () => {
    const giantWord = "A".repeat(120);
    const chunks = chunkMessage(giantWord, 40);
    expect(chunks.length).toBeGreaterThan(2);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(40);
    }
    const reassembled = chunks.map((c) => c.replace(/^\[\d+\/\d+\] /, "")).join("");
    expect(reassembled).toBe(giantWord);
  });
});

describe("extractOutboundMedia", () => {
  it("extracts valid MEDIA directives relative to allowedRoot and cleans text", () => {
    const allowedRoot = path.resolve(os.tmpdir(), "gateway-media-test");
    const msg = [
      "Here is the chart you requested:",
      'MEDIA:"reports/chart 1.png"',
      "MEDIA:logs/output.txt",
    ].join("\n");

    const result = extractOutboundMedia(msg, allowedRoot);
    expect(result.cleanText).toBe("Here is the chart you requested:");
    expect(result.mediaPaths).toEqual([
      path.resolve(allowedRoot, "reports/chart 1.png"),
      path.resolve(allowedRoot, "logs/output.txt"),
    ]);
  });

  it("rejects .env, .env.local, .ssh, private keys, and path traversal escaping allowedRoot", () => {
    const allowedRoot = path.resolve(os.tmpdir(), "gateway-sandbox");
    const unsafe = [
      "Sending files:",
      "MEDIA:.env",
      "MEDIA:.env.local",
      "MEDIA:secrets/.ssh/id_rsa",
      "MEDIA:certs/server.pem",
      "MEDIA:certs/private.key",
      "MEDIA:../outside-secret.txt",
      "MEDIA:safe/preview.png",
    ].join("\n");

    const result = extractOutboundMedia(unsafe, allowedRoot);
    expect(result.cleanText).toBe("Sending files:");
    expect(result.mediaPaths).toEqual([
      path.resolve(allowedRoot, "safe/preview.png"),
    ]);
  });
});

describe("StreamStalenessWatchdog", () => {
  it("skips probing before silenceThresholdMs and resets on recordInbound()", async () => {
    let now = 1_000_000;
    const probeFn = vi.fn().mockRejectedValue({ code: 5, message: "NOT_FOUND" });
    const onZombieDetected = vi.fn();

    const watchdog = new StreamStalenessWatchdog({
      silenceThresholdMs: 60_000,
      probeCooldownMs: 30_000,
      probeSpaceId: "any;-;+15550001234",
      probeFn,
      onZombieDetected,
      nowFn: () => now,
    });

    now += 30_000;
    expect(await watchdog.checkOnce()).toBe("ok");
    expect(probeFn).not.toHaveBeenCalled();

    // Advance past threshold, then reset via recordInbound before probing
    now += 25_000;
    watchdog.recordInbound(now);
    now += 20_000;
    expect(await watchdog.checkOnce()).toBe("ok");
    expect(probeFn).not.toHaveBeenCalled();
    expect(onZombieDetected).not.toHaveBeenCalled();
  });

  it("triggers onZombieDetected when unary probe fails with NOT_FOUND after silence", async () => {
    let now = 1_000_000;
    const probeFn = vi.fn().mockRejectedValue({ code: 5, message: "5 NOT_FOUND" });
    const onZombieDetected = vi.fn();

    const watchdog = new StreamStalenessWatchdog({
      silenceThresholdMs: 60_000,
      probeCooldownMs: 30_000,
      probeSpaceId: "any;-;+15550001234",
      probeFn,
      onZombieDetected,
      nowFn: () => now,
    });

    now += 65_000;
    const outcome = await watchdog.checkOnce();
    expect(outcome).toBe("zombie");
    expect(probeFn).toHaveBeenCalledTimes(1);
    expect(onZombieDetected).toHaveBeenCalledTimes(1);
    expect(onZombieDetected).toHaveBeenCalledWith(
      expect.objectContaining({
        silentMs: 65_000,
        spaceId: "any;-;+15550001234",
      }),
    );

    // Cooldown prevents immediate re-probe
    expect(await watchdog.checkOnce()).toBe("skipped");
    expect(probeFn).toHaveBeenCalledTimes(1);
  });

  it("does NOT trigger onZombieDetected on network/offline errors", async () => {
    let now = 1_000_000;
    const probeFn = vi
      .fn()
      .mockRejectedValue(new Error("14 UNAVAILABLE: ECONNRESET"));
    const onZombieDetected = vi.fn();

    const watchdog = new StreamStalenessWatchdog({
      silenceThresholdMs: 60_000,
      probeCooldownMs: 30_000,
      probeSpaceId: "any;-;+15550001234",
      probeFn,
      onZombieDetected,
      nowFn: () => now,
    });

    now += 70_000;
    expect(await watchdog.checkOnce()).toBe("offline");
    expect(probeFn).toHaveBeenCalledTimes(1);
    expect(onZombieDetected).not.toHaveBeenCalled();
  });

  it("classifies gRPC error codes accurately", () => {
    expect(isProbeChannelAliveRejection({ code: 5 })).toBe(true);
    expect(isProbeChannelAliveRejection(new Error("Message not found"))).toBe(true);
    expect(isProbeChannelAliveRejection({ code: 14, message: "UNAVAILABLE" })).toBe(
      false,
    );
    expect(isProbeChannelAliveRejection(new Error("ETIMEDOUT"))).toBe(false);
  });
});
