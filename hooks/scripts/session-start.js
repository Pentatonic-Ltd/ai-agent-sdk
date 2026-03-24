#!/usr/bin/env node

/**
 * SessionStart hook — emits a SESSION_START event to TES
 * and pre-fetches recent memories for context.
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

function loadConfig() {
  const candidates = [
    join(homedir(), ".claude", "tes-memory.local.md"),
    join(homedir(), ".claude-pentatonic", "tes-memory.local.md"),
  ];
  if (process.env.CLAUDE_CONFIG_DIR) {
    candidates.unshift(join(process.env.CLAUDE_CONFIG_DIR, "tes-memory.local.md"));
  }
  const configPath = candidates.find((p) => existsSync(p));
  if (!configPath) return null;

  const content = readFileSync(configPath, "utf-8");
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;

  const config = {};
  for (const line of match[1].split("\n")) {
    const [key, ...rest] = line.split(":");
    if (key && rest.length) {
      config[key.trim()] = rest.join(":").trim();
    }
  }
  return config;
}

async function main() {
  const config = loadConfig();
  if (!config?.tes_endpoint || !config?.tes_api_key) {
    // Not configured — silently skip
    process.exit(0);
  }

  const headers = {
    "Content-Type": "application/json",
    "x-client-id": config.tes_client_id,
  };

  if (config.tes_api_key.startsWith("tes_")) {
    headers["Authorization"] = `Bearer ${config.tes_api_key}`;
  } else {
    headers["x-service-key"] = config.tes_api_key;
  }

  try {
    // Emit SESSION_START event
    await fetch(`${config.tes_endpoint}/api/graphql`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        query: `mutation EmitEvent($input: EventInput!) {
          emitEvent(input: $input) { success eventId }
        }`,
        variables: {
          input: {
            eventType: "SESSION_START",
            entityType: "conversation",
            data: {
              entity_id: `claude-code-${Date.now()}`,
              attributes: {
                source: "claude-code-plugin",
                userId: config.tes_user_id || undefined,
                cwd: process.cwd(),
              },
            },
          },
        },
      }),
    });
  } catch {
    // Non-fatal — don't block session start
  }
}

main();
