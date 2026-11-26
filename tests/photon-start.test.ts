import { describe, expect, it, vi } from "vitest";
import type { GatewayConfig } from "../src/config.js";

vi.mock("spectrum-ts", () => ({
  Spectrum: vi.fn(),
  attachment: vi.fn(),
  markdown: vi.fn(),
  richlink: vi.fn(),
  text: vi.fn(),
  voice: vi.fn(),
}));
vi.mock("spectrum-ts/providers/imessage", () => ({
  effect: vi.fn(),
  imessage: Object.assign(vi.fn(), { config: vi.fn(() => ({})), effect: { message: {} } }),
}));

const { Spectrum } = await import("spectrum-ts");
const { PhotonChannelAdapter } = await import("../src/photon/adapter.js");

function config(withPhoton = true): GatewayConfig {
  return {
    allowedSenders: new Set(),
    allowGroups: false,
    groupMentionPatterns: [],
    agyBin: "agy",
    defaultCwd: "/tmp/workspace",
    approvalMode: "interactive",
    healthEnabled: false,
    healthHost: "127.0.0.1",
    healthPort: 0,
    quotaWarnThreshold: 15,
    dataDir: "/tmp/agw-photon-start-test",
    logLevel: "info",
    photon: withPhoton
      ? { projectId: "pid", projectSecret: "psecret", readReceipts: true, reactions: true }
      : undefined,
  };
}

function fakeApp() {
  let end!: () => void;
  const done = new Promise<void>((resolve) => {
    end = resolve;
  });
  return {
    messages: (async function* () {
      await done;
    })(),
    stop: async () => end(),
  };
}

describe("PhotonChannelAdapter startup readiness", () => {
  it("requires photon credentials", () => {
    expect(() => new PhotonChannelAdapter(config(false))).toThrow(/SPECTRUM_PROJECT_ID/);
  });

  it("start() resolves only after the Spectrum connection is established", async () => {
    vi.mocked(Spectrum).mockImplementation(
      (async () => {
        await new Promise((r) => setTimeout(r, 50));
        return fakeApp();
      }) as never,
    );
    const adapter = new PhotonChannelAdapter(config());
    expect(adapter.name).toBe("photon");
    await adapter.start(() => {});
    expect(adapter.isConnected()).toBe(true);
    await adapter.stop();
  });

  it("times out safely, keeps retrying in the background, and surfaces lastError", async () => {
    let calls = 0;
    vi.mocked(Spectrum).mockImplementation(
      (async () => {
        calls += 1;
        if (calls === 1) {
          return await new Promise(() => {}); // first attempt hangs
        }
        return fakeApp();
      }) as never,
    );
    const adapter = new PhotonChannelAdapter(config(), {
      startupTimeoutMs: 40,
      connectTimeoutMs: 150,
    });
    await adapter.start(() => {});
    expect(adapter.isConnected()).toBe(false);
    expect(adapter.getStats().lastError).toMatch(/not connected after/);
    // The hung attempt times out and the background loop reconnects.
    await vi.waitFor(() => expect(adapter.isConnected()).toBe(true), { timeout: 3000 });
    await adapter.stop();
  });
});
