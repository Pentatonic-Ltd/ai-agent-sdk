#!/usr/bin/env node

import { createInterface } from "readline";
import { execFileSync } from "child_process";

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

async function main() {
  const flags = parseArgs();
  const TES_ENDPOINT = flags.endpoint || DEFAULT_ENDPOINT;

  if (flags.command !== "init") {
    console.log(`
@pentatonic-ai/agent-events

Usage:
  npx @pentatonic-ai/agent-events init                    Set up account and install SDK
  npx @pentatonic-ai/agent-events init --endpoint URL     Use a custom TES endpoint

For docs, see https://api.pentatonic.com
    `);
    process.exit(0);
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

        if (isPending) {
          enrollSpinner.stop("Enrollment already pending — waiting for verification.");
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
        "Verification timed out. Run `npx @pentatonic-ai/agent-events init` again — it will resume where you left off."
      );
      process.exit(1);
    }
  }

  // Generate API key
  const keySpinner = spinner("Generating API key...");
  try {
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
          role: "service-account",
        },
      }
    );

    const apiKey = result.createClientApiToken.plainTextToken;
    keySpinner.stop("API key generated!");

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
    const installSpinner = spinner(
      "Installing @pentatonic-ai/agent-events..."
    );
    try {
      execFileSync("npm", ["install", "@pentatonic-ai/agent-events"], {
        stdio: "pipe",
      });
      installSpinner.stop("@pentatonic-ai/agent-events installed!");
    } catch {
      installSpinner.fail(
        "Install failed. Run manually: npm install @pentatonic-ai/agent-events"
      );
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
