/**
 * OpenClaw Context Engine — deterministic memory integration.
 *
 * Unlike MCP tools (agent-driven, optional), the context engine hooks
 * fire on every lifecycle event:
 *   ingest    — every message stored as memory with embedding + HyDE
 *   assemble  — relevant memories injected as context before every prompt
 *   compact   — decay cycle runs when context window fills
 *   afterTurn — access counts updated
 */

/**
 * Create a ContextEngine implementation backed by @pentatonic/memory.
 *
 * @param {object} memory - createMemorySystem() instance
 * @param {object} [opts]
 * @param {string} [opts.clientId="default"] - Memory namespace
 * @param {number} [opts.searchLimit=5] - Memories to inject per prompt
 * @param {number} [opts.minScore=0.3] - Minimum relevance threshold
 * @param {Function} [opts.logger] - Optional logger
 * @returns {object} ContextEngine implementation
 */
export function createContextEngine(memory, opts = {}) {
  const clientId = opts.clientId || "default";
  const searchLimit = opts.searchLimit || 5;
  const minScore = opts.minScore || 0.3;
  const log = opts.logger || (() => {});

  return {
    info: {
      id: "pentatonic-memory",
      name: "Pentatonic Memory",
      ownsCompaction: false,
    },

    /**
     * Called when a new message is added to the session.
     * Store it as a memory with embedding + HyDE.
     */
    async ingest({ sessionId, message }) {
      if (!message?.content) return { ingested: false };

      // Skip tool results and system messages — only store user/assistant turns
      const role = message.role || message.type;
      if (role !== "user" && role !== "assistant") {
        return { ingested: false };
      }

      try {
        await memory.ingest(message.content, {
          clientId,
          metadata: {
            session_id: sessionId,
            role,
            source: "openclaw-plugin",
          },
        });
        log(`[memory] Ingested ${role} message for session ${sessionId}`);
        return { ingested: true };
      } catch (err) {
        log(`[memory] Ingest failed: ${err.message}`);
        return { ingested: false };
      }
    },

    /**
     * Called before each model run. Search for relevant memories
     * and inject them as a system prompt addition.
     */
    async assemble({ sessionId, messages, tokenBudget }) {
      // Use the last user message as the search query
      const lastUserMsg = [...messages]
        .reverse()
        .find((m) => m.role === "user" || m.type === "user");

      if (!lastUserMsg?.content) {
        return { messages, estimatedTokens: 0 };
      }

      try {
        const results = await memory.search(lastUserMsg.content, {
          clientId,
          limit: searchLimit,
          minScore,
        });

        if (!results.length) {
          return { messages, estimatedTokens: 0 };
        }

        const memoryText = results
          .map(
            (m) =>
              `- [${Math.round((m.similarity || 0) * 100)}%] ${m.content}`
          )
          .join("\n");

        const addition = `[Memory] Relevant context from past conversations:\n${memoryText}`;

        log(
          `[memory] Assembled ${results.length} memories for session ${sessionId}`
        );

        return {
          messages,
          estimatedTokens: Math.ceil(addition.length / 4),
          systemPromptAddition: addition,
        };
      } catch (err) {
        log(`[memory] Assemble failed: ${err.message}`);
        return { messages, estimatedTokens: 0 };
      }
    },

    /**
     * Called when the context window is full.
     * Run decay to clean up low-confidence memories.
     */
    async compact({ sessionId, force }) {
      try {
        const stats = await memory.decay(clientId);
        log(
          `[memory] Compact: ${stats.decayed} decayed, ${stats.evicted} evicted`
        );
        return { ok: true, compacted: stats.evicted > 0 };
      } catch (err) {
        log(`[memory] Compact failed: ${err.message}`);
        return { ok: false, compacted: false };
      }
    },

    /**
     * Called after a run completes. Run consolidation check.
     */
    async afterTurn({ sessionId }) {
      try {
        const consolidated = await memory.consolidate(clientId);
        if (consolidated.length) {
          log(
            `[memory] Consolidated ${consolidated.length} memories to semantic layer`
          );
        }
      } catch (err) {
        log(`[memory] AfterTurn failed: ${err.message}`);
      }
    },
  };
}
