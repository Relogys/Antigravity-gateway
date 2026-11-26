import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

async function main(): Promise<void> {
  const agyBin = process.env.AGY_BIN?.trim() || "agy";
  const cwd = process.cwd();

  const child = spawn(agyBin, ["acp"], {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const stderrChunks: string[] = [];
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrChunks.push(chunk.toString("utf8"));
  });

  const input = Writable.toWeb(child.stdin!);
  const output = Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>;
  const stream = acp.ndJsonStream(input, output);

  const clientApp = acp
    .client({ name: "antigravity-gateway-probe" })
    .onRequest(acp.methods.client.session.requestPermission, async (ctx) => {
      const first = ctx.params.options[0];
      if (!first) {
        return { outcome: { outcome: "cancelled" } };
      }
      return {
        outcome: { outcome: "selected", optionId: first.optionId },
      };
    })
    .onNotification(acp.methods.client.session.update, async (ctx) => {
      console.log("[session/update]", JSON.stringify(ctx.params.update.sessionUpdate));
    });

  try {
    await clientApp.connectWith(stream, async (ctx) => {
      const initResult = await ctx.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
        },
      });
      console.log("=== INITIALIZE ===");
      console.log(JSON.stringify(initResult, null, 2));

      const newSession = await ctx.request(acp.methods.agent.session.new, {
        cwd,
        mcpServers: [],
      });
      console.log("=== SESSION/NEW ===");
      console.log(JSON.stringify(newSession, null, 2));

      if (initResult.agentCapabilities?.sessionCapabilities?.list) {
        const listResult = await ctx.request(acp.methods.agent.session.list, {
          cwd,
        });
        console.log("=== SESSION/LIST (top 3) ===");
        console.log(
          JSON.stringify(
            {
              ...listResult,
              sessions: listResult.sessions?.slice(0, 3) ?? [],
              totalShown: listResult.sessions?.length ?? 0,
            },
            null,
            2,
          ),
        );
      } else {
        console.log("=== SESSION/LIST === not advertised");
      }

      if (initResult.agentCapabilities?.sessionCapabilities?.close) {
        await ctx.request(acp.methods.agent.session.close, {
          sessionId: newSession.sessionId,
        });
        console.log("=== SESSION/CLOSE === ok");
      }
    });
  } finally {
    if (child.exitCode === null && !child.killed) {
      child.kill();
    }
    if (stderrChunks.length > 0) {
      console.error("=== STDERR ===");
      console.error(stderrChunks.join(""));
    }
  }
}

main().catch((err) => {
  console.error("Probe failed:", err);
  process.exit(1);
});
