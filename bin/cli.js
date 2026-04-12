#!/usr/bin/env node

import { createInterface } from "readline";
import { execFileSync } from "child_process";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const DEFAULT_ENDPOINT = "https://api.pentatonic.com";

function parseArgs() {
  const args = process.argv.slice(2);
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--endpoint" && args[i + 1]) {
      flags.endpoint = args[i + 1];
      i++;
    } else if (args[i].startsWith("--endpoint=")) {
      flags.endpoint = args[i].split("=")[1];
    } else if (!args[i].startsWith("--")) {
      flags.command = args[i];
    }
  }
  return flags;
}
const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 300000; // 5 minutes

let rl = createInterface({ input: process.stdin, output: process.stdout });

function ask(question) {
  return new Promise((resolve) => rl.question(question, resolve));
}

function askSecret(question) {
  return new Promise((resolve) => {
    // Close readline so it stops echoing input
    rl.close();

    process.stdout.write(question);
    const stdin = process.stdin;
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();

    let input = "";
    const onData = (ch) => {
      const c = ch.toString();
      if (c === "\n" || c === "\r") {
        stdin.removeListener("data", onData);
        if (stdin.isTTY) stdin.setRawMode(false);
        stdin.pause();
        process.stdout.write("\n");
        // Recreate readline for subsequent prompts
        rl = createInterface({ input: process.stdin, output: process.stdout });
        resolve(input);
      } else if (c === "\u007f" || c === "\b") {
        if (input.length > 0) {
          input = input.slice(0, -1);
          process.stdout.write("\b \b");
        }
      } else if (c === "\u0003") {
        process.exit(1);
      } else {
        input += c;
        process.stdout.write("*");
      }
    };
    stdin.on("data", onData);
  });
}

function askChoice(question, choices) {
  return new Promise((resolve) => {
    const choiceStr = choices.map((c, i) => `  ${i + 1}) ${c}`).join("\n");
    process.stdout.write(`${question}\n${choiceStr}\n`);
    rl.question("? Choice: ", (answer) => {
      const idx = parseInt(answer, 10) - 1;
      if (idx >= 0 && idx < choices.length) {
        resolve(choices[idx]);
      } else {
        const match = choices.find(
          (c) => c.toLowerCase() === answer.trim().toLowerCase()
        );
        resolve(match || choices[0]);
      }
    });
  });
}

function spinner(text) {
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let i = 0;
  const id = setInterval(() => {
    process.stdout.write(`\r${frames[i++ % frames.length]} ${text}`);
  }, 80);
  return {
    stop(result) {
      clearInterval(id);
      process.stdout.write(`\r✓ ${result}\n`);
    },
    fail(msg) {
      clearInterval(id);
      process.stdout.write(`\r✗ ${msg}\n`);
    },
  };
}

async function httpPost(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  return { status: response.status, ok: response.ok, data };
}

async function graphql(endpoint, token, query, variables) {
  const response = await fetch(`${endpoint}/api/graphql`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ query, variables }),
  });
  const data = await response.json();
  if (data.errors?.length) {
    throw new Error(data.errors[0].message);
  }
  return data.data;
}

function toClientId(companyName) {
  return companyName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

async function setupLocalMemory() {
  console.log(`\n  @pentatonic/memory — Local Setup\n`);

  // Check Docker
  try {
    execFileSync("docker", ["info"], { stdio: "pipe" });
  } catch {
    console.error("  Error: Docker is required. Install it from https://docker.com\n");
    process.exit(1);
  }

  const memoryDir = new URL("../packages/memory", import.meta.url).pathname;

  // Start infrastructure
  const infraSpinner = spinner("Starting PostgreSQL + Ollama...");
  try {
    execFileSync("docker", ["compose", "up", "-d", "postgres", "ollama"], {
      cwd: memoryDir,
      stdio: "pipe",
    });
    infraSpinner.stop("PostgreSQL + Ollama running!");
  } catch (err) {
    infraSpinner.fail(`Failed to start: ${err.message}`);
    process.exit(1);
  }

  // Pull models
  const embModel = process.env.EMBEDDING_MODEL || "nomic-embed-text";
  const llmModel = process.env.LLM_MODEL || "llama3.2:3b";

  const embSpinner = spinner(`Pulling ${embModel}...`);
  try {
    execFileSync("docker", ["compose", "exec", "ollama", "ollama", "pull", embModel], {
      cwd: memoryDir,
      stdio: "pipe",
    });
    embSpinner.stop(`${embModel} ready!`);
  } catch {
    embSpinner.fail(`Failed to pull ${embModel}. Run manually: docker compose exec ollama ollama pull ${embModel}`);
  }

  const llmSpinner = spinner(`Pulling ${llmModel}...`);
  try {
    execFileSync("docker", ["compose", "exec", "ollama", "ollama", "pull", llmModel], {
      cwd: memoryDir,
      stdio: "pipe",
    });
    llmSpinner.stop(`${llmModel} ready!`);
  } catch {
    llmSpinner.fail(`Failed to pull ${llmModel}. Run manually: docker compose exec ollama ollama pull ${llmModel}`);
  }

  // Write local config
  const configDir = join(homedir(), ".claude-pentatonic");
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }

  const configPath = join(configDir, "tes-memory.local.md");
  writeFileSync(
    configPath,
    `---
mode: local
memory_url: http://localhost:3333
---
`
  );

  console.log(`\n  Config written to ${configPath}`);

  // Start memory server
  console.log("\n  Starting memory server...");
  const serverPath = join(memoryDir, "src", "server.js");

  console.log(`
  Memory server: http://localhost:3333

  To connect Claude Code:
    claude mcp add pentatonic-memory \\
      -e DATABASE_URL=postgres://memory:memory@localhost:5433/memory \\
      -e EMBEDDING_URL=http://localhost:11435/v1 \\
      -e EMBEDDING_MODEL=${embModel} \\
      -e LLM_URL=http://localhost:11435/v1 \\
      -e LLM_MODEL=${llmModel} \\
      -- node ${serverPath}

  Hooks are auto-configured to use local memory.
  You're ready!
`);

  rl.close();
}

async function main() {
  const flags = parseArgs();
  const TES_ENDPOINT = flags.endpoint || DEFAULT_ENDPOINT;

  if (flags.command === "memory") {
    await setupLocalMemory();
    return;
  }

  if (flags.command !== "init") {
    console.log(`
@pentatonic-ai/ai-agent-sdk

Usage:
  npx @pentatonic-ai/ai-agent-sdk init                    Set up hosted TES account
  npx @pentatonic-ai/ai-agent-sdk memory                  Set up local memory stack
  npx @pentatonic-ai/ai-agent-sdk init --endpoint URL     Use a custom TES endpoint

For docs, see https://api.pentatonic.com
    `);
    process.exit(0);
  }

  const isLocal = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(TES_ENDPOINT);
  if (!TES_ENDPOINT.startsWith("https://") && !isLocal) {
    console.error(`\n  Error: endpoint must use https:// (http:// is only allowed for localhost)\n`);
    process.exit(1);
  }

  console.log(`\n  Welcome to Pentatonic AI Events SDK`);
  if (TES_ENDPOINT !== DEFAULT_ENDPOINT) {
    console.log(`  Using endpoint: ${TES_ENDPOINT}`);
  }
  console.log("");

  // Collect info
  const email = await ask("? Email: ");
  const clientId = toClientId(await ask("? Client ID: "));
  const password = await askSecret("? Password: ");
  const region = await askChoice("? Region:", ["EU", "US"]);

  // Try login first — account may already be verified from a previous run
  let accessToken = null;
  const loginSpinner = spinner("Checking for existing account...");
  try {
    const { ok, data } = await httpPost(
      `${TES_ENDPOINT}/api/enrollment/login`,
      { email, password, clientId }
    );
    if (ok && data.tokens?.accessToken) {
      accessToken = data.tokens.accessToken;
      loginSpinner.stop("Account already verified!");
    } else {
      loginSpinner.stop("No existing account found.");
    }
  } catch {
    loginSpinner.stop("No existing account found.");
  }

  // If not already verified, submit enrollment
  if (!accessToken) {
    const enrollSpinner = spinner("Creating account...");
    try {
      const { ok, data } = await httpPost(
        `${TES_ENDPOINT}/api/enrollment/submit`,
        {
          clientId,
          companyName: clientId,
          industryType: "technology",
          authProvider: "native",
          adminEmail: email,
          adminPassword: password,
          region: region.toLowerCase(),
        }
      );

      if (!ok) {
        const errors = data.errors || {};
        const isPending =
          errors.clientId?.includes("already pending") ||
          errors.adminEmail?.includes("already has a pending");
        const isAlreadyRegistered =
          errors.clientId?.includes("already registered");

        if (isPending) {
          enrollSpinner.stop("Enrollment already pending — waiting for verification.");
        } else if (isAlreadyRegistered) {
          enrollSpinner.fail(
            "This client ID is already registered.\n" +
            "  If you belong to this organization, ask your admin to invite you.\n" +
            "  Then run this command again — it will log you in automatically."
          );
          process.exit(1);
        } else {
          enrollSpinner.fail(
            data.message || Object.values(errors).join(", ") || "Enrollment failed"
          );
          process.exit(1);
        }
      } else {
        enrollSpinner.stop("Account created! Check your email to verify.");
      }
    } catch (err) {
      enrollSpinner.fail(`Failed to connect: ${err.message}`);
      process.exit(1);
    }

    // Poll for verification
    console.log("\n  Waiting for email verification...");
    console.log("  (Check your inbox and click the verification link)\n");

    const pollSpinner = spinner("Waiting for verification...");
    const startTime = Date.now();

    while (Date.now() - startTime < POLL_TIMEOUT_MS) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

      try {
        const { ok, data } = await httpPost(
          `${TES_ENDPOINT}/api/enrollment/login`,
          { email, password, clientId }
        );

        if (ok && data.tokens?.accessToken) {
          accessToken = data.tokens.accessToken;
          pollSpinner.stop("Email verified!");
          break;
        }
      } catch {
        // Not verified yet, keep polling
      }
    }

    if (!accessToken) {
      pollSpinner.fail(
        "Verification timed out. Run `npx @pentatonic-ai/ai-agent-sdk init` again — it will resume where you left off."
      );
      process.exit(1);
    }
  }

  // Get API key — use the service token created during enrollment,
  // or create a new one if not available (e.g., existing account login)
  const keySpinner = spinner("Getting API key...");
  try {
    let apiKey;

    // Try to retrieve the enrollment service token first (created during verification)
    try {
      const tokenRes = await fetch(
        `${TES_ENDPOINT}/api/enrollment/service-token?client_id=${clientId}`
      );
      if (tokenRes.ok) {
        const tokenData = await tokenRes.json();
        if (tokenData.token) {
          apiKey = tokenData.token;
        }
      }
    } catch {
      // Service token not available, will create one
    }

    // Fallback: create a new token via GraphQL
    if (!apiKey) {
      const result = await graphql(
        TES_ENDPOINT,
        accessToken,
        `mutation CreateApiToken($clientId: String!, $input: CreateApiTokenInput!) {
          createClientApiToken(clientId: $clientId, input: $input) {
            success
            plainTextToken
          }
        }`,
        {
          clientId,
          input: {
            name: "ai-events-sdk",
            role: "agent-events",
          },
        }
      );
      apiKey = result.createClientApiToken.plainTextToken;
    }

    keySpinner.stop("API key ready!");

    // Print credentials
    const clientEndpoint =
      TES_ENDPOINT === DEFAULT_ENDPOINT
        ? `https://${clientId}.api.pentatonic.com`
        : TES_ENDPOINT;

    console.log("\n  Add these to your environment:\n");
    console.log(`  TES_ENDPOINT=${clientEndpoint}`);
    console.log(`  TES_CLIENT_ID=${clientId}`);
    console.log(`  TES_API_KEY=${apiKey}`);
    console.log("");

    // Install SDK
    const installChoice = await askChoice("Install SDK:", [
      "npm install @pentatonic-ai/ai-agent-sdk",
      "pip install pentatonic-ai-agent-sdk",
      "Skip — I'll install manually",
    ]);

    if (installChoice.startsWith("npm")) {
      const installSpinner = spinner("Installing @pentatonic-ai/ai-agent-sdk...");
      try {
        execFileSync("npm", ["install", "@pentatonic-ai/ai-agent-sdk"], { stdio: "pipe" });
        installSpinner.stop("@pentatonic-ai/ai-agent-sdk installed!");
      } catch {
        installSpinner.fail("Install failed. Run manually: npm install @pentatonic-ai/ai-agent-sdk");
      }
    } else if (installChoice.startsWith("pip")) {
      const installSpinner = spinner("Installing pentatonic-ai-agent-sdk...");
      try {
        execFileSync("pip", ["install", "pentatonic-ai-agent-sdk"], { stdio: "pipe" });
        installSpinner.stop("pentatonic-ai-agent-sdk installed!");
      } catch {
        installSpinner.fail("Install failed. Run manually: pip install pentatonic-ai-agent-sdk");
      }
    } else {
      console.log("\n  Install later with:");
      console.log("    npm install @pentatonic-ai/ai-agent-sdk");
      console.log("    pip install pentatonic-ai-agent-sdk");
    }

    console.log("  You're ready! See docs at https://api.pentatonic.com\n");
  } catch (err) {
    keySpinner.fail(`Failed to generate key: ${err.message}`);
    process.exit(1);
  }

  rl.close();
}

main().catch((err) => {
  console.error(`\n  Error: ${err.message}\n`);
  process.exit(1);
});
