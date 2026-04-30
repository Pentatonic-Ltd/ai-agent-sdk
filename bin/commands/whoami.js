import { readCredentials, pingTes } from "../lib/credentials.js";

/**
 * Run the SDK whoami command. Prints "logged in as X on tenant Y" or
 * "not logged in" / "creds invalid" depending on the state of
 * ~/.config/tes/credentials.json and a GraphQL ping.
 *
 * Originally named `status` in the design spec; renamed because the
 * corpus subcommand `tes status` already exists (shows tracked repos).
 * `whoami` matches the standard CLI convention for "who am I logged
 * in as" and avoids the conflict.
 */
export async function runWhoamiCommand(opts = {}) {
  const log = opts.log || ((m) => process.stdout.write(m + "\n"));
  const errLog = opts.errLog || ((m) => process.stderr.write(m + "\n"));

  const creds = await readCredentials();
  if (!creds) {
    log("");
    log("  Not logged in. Run `npx @pentatonic-ai/ai-agent-sdk login` to connect.");
    log("");
    return { exitCode: 1 };
  }

  const ping = await pingTes(creds);
  if (!ping.ok) {
    if (ping.status === 401) {
      errLog("  Credentials invalid (revoked or expired).");
      errLog("  Run `npx @pentatonic-ai/ai-agent-sdk login` to refresh.");
      return { exitCode: 2 };
    }
    errLog(`  Could not verify credentials: ${ping.error}`);
    return { exitCode: 3 };
  }

  log("");
  log(`  ✓ Logged in as ${ping.email || "(unknown email)"} on tenant \`${creds.clientId}\` (${ping.clientName})`);
  log(`  Endpoint: ${creds.endpoint}`);
  log("");
  return { exitCode: 0 };
}
