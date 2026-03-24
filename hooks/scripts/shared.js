/**
 * Shared utilities for TES hook scripts.
 * Config loading, event emission, and turn state management.
 */

import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir, tmpdir } from "os";

// --- Config ---

export function loadConfig() {
  const candidates = [
    join(homedir(), ".claude", "tes-memory.local.md"),
    join(homedir(), ".claude-pentatonic", "tes-memory.local.md"),
  ];
  if (process.env.CLAUDE_CONFIG_DIR) {
    candidates.unshift(
      join(process.env.CLAUDE_CONFIG_DIR, "tes-memory.local.md")
    );
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

// --- Event Emission ---

const CREATE_MODULE_EVENT_MUTATION = `
  mutation CreateModuleEvent($moduleId: String!, $input: ModuleEventInput!) {
    createModuleEvent(moduleId: $moduleId, input: $input) { success eventId }
  }
`;

/**
 * Emit an event via the createModuleEvent mutation.
 * @param {object} config - TES config from tes-memory.local.md
 * @param {string} moduleId - Target module (e.g., "deep-memory", "conversation-analytics")
 * @param {string} eventType - Event type (must be in module's allowlist)
 * @param {string} entityId - Entity ID (e.g., session ID)
 * @param {object} attributes - Event attributes
 */
export async function emitModuleEvent(config, moduleId, eventType, entityId, attributes) {
  const headers = {
    "Content-Type": "application/json",
    "x-client-id": config.tes_client_id,
  };

  if (config.tes_api_key.startsWith("tes_")) {
    headers["Authorization"] = `Bearer ${config.tes_api_key}`;
  } else {
    headers["x-service-key"] = config.tes_api_key;
  }

  const response = await fetch(`${config.tes_endpoint}/api/graphql`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      query: CREATE_MODULE_EVENT_MUTATION,
      variables: {
        moduleId,
        input: {
          eventType,
          data: {
            entity_id: entityId,
            attributes: {
              ...attributes,
              source: "claude-code-plugin",
              user_id: config.tes_user_id || undefined,
            },
          },
        },
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`TES API error: ${response.status}`);
  }

  return response.json();
}

// --- Turn State (temp file per session) ---

function turnStatePath(sessionId) {
  const dir = join(tmpdir(), "tes-claude-code");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return join(dir, `turn-${sessionId}.json`);
}

export function readTurnState(sessionId) {
  const path = turnStatePath(sessionId);
  if (!existsSync(path)) {
    return { tool_calls: [], turn_number: 0 };
  }
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return { tool_calls: [], turn_number: 0 };
  }
}

export function writeTurnState(sessionId, state) {
  writeFileSync(turnStatePath(sessionId), JSON.stringify(state));
}

export function clearTurnState(sessionId) {
  const path = turnStatePath(sessionId);
  if (existsSync(path)) {
    unlinkSync(path);
  }
}

// --- Stdin helper ---

export function readStdin() {
  try {
    return JSON.parse(readFileSync(0, "utf-8"));
  } catch {
    // Fallback: stdin may not be available in some hook contexts
    return {};
  }
}
