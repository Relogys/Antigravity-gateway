export interface ConversationGroupSync {
  syncSessionGroup(input: {
    sessionId: string;
    channelGroup: string;
    title?: string;
  }): Promise<boolean>;
}

/**
 * Best-effort bridge that mirrors gateway session groups into the official
 * Antigravity sidebar. Activated only when both env vars are explicitly set;
 * no files or ports are probed otherwise.
 */
export function createConversationSyncFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): ConversationGroupSync | undefined {
  const address = env.ANTIGRAVITY_LS_ADDRESS?.trim();
  const csrfToken = env.ANTIGRAVITY_CSRF_TOKEN?.trim();
  if (!address || !csrfToken) {
    return undefined;
  }

  return {
    async syncSessionGroup({ sessionId, channelGroup, title }) {
      try {
        const res = await fetchImpl(
          `http://${address}/product.v1.ConversationService/UpdateConversation`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Connect-Protocol-Version": "1",
              "x-antigravity-csrf-token": csrfToken,
            },
            body: JSON.stringify({
              conversationId: sessionId,
              annotations: {
                ...(title ? { title } : {}),
                tags: ["gateway", `channel:${channelGroup}`],
                conversationGroupId: `gateway:${channelGroup}`,
              },
            }),
            signal: AbortSignal.timeout(3000),
          },
        );
        return res.ok;
      } catch {
        return false;
      }
    },
  };
}