#!/usr/bin/env node

import { createInterface } from "readline";
import { execFileSync } from "child_process";

const TES_ENDPOINT = "https://api.pentatonic.com";
const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 300000; // 5 minutes

const rl = createInterface({ input: process.stdin, output: process.stdout });

function ask(question) {
  return new Promise((resolve) => rl.question(question, resolve));
}

function askSecret(question) {
  return new Promise((resolve) => {
    process.stdout.write(question);
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    if (stdin.isTTY) stdin.setRawMode(true);

    let input = "";
    const onData = (ch) => {
      const c = ch.toString();
      if (c === "\n" || c === "\r") {
        stdin.removeListener("data", onData);
        if (stdin.isTTY) stdin.setRawMode(wasRaw);
        process.stdout.write("\n");
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
  const command = process.argv[2];

  if (command !== "init") {
    console.log(`
@pentatonic/ai-events-sdk

Usage:
  npx @pentatonic/ai-events-sdk init    Set up account and install SDK

For docs, see https://api.pentatonic.com
    `);
    process.exit(0);
  }

  console.log("\n  Welcome to Pentatonic AI Events SDK\n");

  // Collect info
  const email = await ask("? Email: ");
  const companyName = await ask("? Company name: ");
  const password = await askSecret("? Password: ");
  const region = await askChoice("? Region:", ["EU", "US"]);

  const clientId = toClientId(companyName);

  // Submit enrollment
  const enrollSpinner = spinner("Creating account...");
  try {
    const { ok, data } = await httpPost(
      `${TES_ENDPOINT}/api/enrollment/submit`,
      {
        clientId,
        companyName,
        industryType: "technology",
        authProvider: "native",
        adminEmail: email,
        adminPassword: password,
        region: region.toLowerCase(),
      }
    );

    if (!ok) {
      enrollSpinner.fail(data.message || "Enrollment failed");
      process.exit(1);
    }

    enrollSpinner.stop("Account created! Check your email to verify.");
  } catch (err) {
    enrollSpinner.fail(`Failed to connect: ${err.message}`);
    process.exit(1);
  }

  // Poll for verification
  console.log("\n  Waiting for email verification...");
  console.log("  (Check your inbox and click the verification link)\n");

  const pollSpinner = spinner("Waiting for verification...");
  const startTime = Date.now();
  let accessToken = null;

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
      "Verification timed out. Verify your email and run `npx @pentatonic/ai-events-sdk init` again."
    );
    process.exit(1);
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
    console.log("\n  Add these to your environment:\n");
    console.log(`  TES_ENDPOINT=${TES_ENDPOINT}`);
    console.log(`  TES_CLIENT_ID=${clientId}`);
    console.log(`  TES_API_KEY=${apiKey}`);
    console.log("");

    // Install SDK
    const installSpinner = spinner(
      "Installing @pentatonic/ai-events-sdk..."
    );
    try {
      execFileSync("npm", ["install", "@pentatonic/ai-events-sdk"], {
        stdio: "pipe",
      });
      installSpinner.stop("@pentatonic/ai-events-sdk installed!");
    } catch {
      installSpinner.fail(
        "Install failed. Run manually: npm install @pentatonic/ai-events-sdk"
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
