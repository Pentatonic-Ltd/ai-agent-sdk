import { generatePKCE } from "../lib/pkce.js";
import { startCallbackServer } from "../lib/callback-server.js";
import { writeCredentials } from "../lib/credentials.js";
import { hostname } from "node:os";
import { execFileSync } from "node:child_process";
import { Buffer } from "node:buffer";

/**
 * Run the SDK login flow.
 *
 * Steps: PKCE → start localhost server → open browser → wait for code
 *        → exchange code for access_token → mint tes_* via GraphQL
 *        → write credentials.
 *
 * Exits non-zero (and returns { exitCode }) on any failure rather than
 * throwing — caller (cli.js) maps exitCode to process.exit().
 *
 * @param {object} opts
 * @param {string} opts.endpoint    - e.g. https://api.pentatonic.com
 * @param {Function} [opts.openBrowser] - injectable for tests
 * @param {Function} [opts.log]     - injectable for tests
 * @param {Function} [opts.errLog]  - injectable for tests
 */
export async function runLoginCommand(opts = {}) {
  const endpoint = opts.endpoint;
  const log = opts.log || ((msg) => process.stdout.write(msg + "\n"));
  const errLog = opts.errLog || ((msg) => process.stderr.write(msg + "\n"));
  const openBrowser = opts.openBrowser || defaultOpenBrowser;

  if (!endpoint) {
    errLog("Error: endpoint is required");
    return { exitCode: 1 };
  }

  const { verifier, challenge, state } = generatePKCE();

  let server;
  try {
    server = await startCallbackServer({
      ports: [14171, 14172, 14173, 0],
      state,
      timeoutMs: 5 * 60_000,
    });
  } catch (err) {
    errLog(`Failed to start localhost callback listener: ${err.message}`);
    return { exitCode: 2 };
  }

  const initUrl = new URL(`${endpoint}/cli-init`);
  initUrl.searchParams.set("cb", `http://localhost:${server.port}/callback`);
  initUrl.searchParams.set("state", state);
  initUrl.searchParams.set("code_challenge", challenge);
  initUrl.searchParams.set("code_challenge_method", "S256");

  log("");
  log("  Hosted TES Setup");
  log(`  Opening ${initUrl.toString()} in your browser…`);
  log(`  Listening on http://localhost:${server.port} for the callback (5 min timeout)`);

  try {
    openBrowser(initUrl.toString());
  } catch (err) {
    log(`  (Could not auto-open browser: ${err.message})`);
    log(`  Please open this URL manually:`);
    log(`    ${initUrl.toString()}`);
  }

  let callback;
  try {
    callback = await server.result;
  } catch (err) {
    errLog(`Login failed: ${err.message}`);
    return { exitCode: 3 };
  }

  // Exchange code for access_token at /oauth/token. The CLI POSTs to
  // the same platform-level endpoint it was given — /oauth/token
  // validates the verifier against the code regardless of which
  // tenant subdomain issued it.
  let accessToken;
  try {
    const tokenRes = await fetch(`${endpoint}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: callback.code,
        redirect_uri: `http://localhost:${server.port}/callback`,
        code_verifier: verifier,
      }).toString(),
    });
    if (!tokenRes.ok) {
      const body = await tokenRes.json().catch(() => ({}));
      // Surface error_description if present — `invalid_grant` alone
      // is ambiguous (could be expired code, PKCE mismatch, redirect_uri
      // mismatch, replay, etc.). The description names the actual cause.
      const detail = body.error_description
        ? `${body.error}: ${body.error_description}`
        : body.error || "unknown";
      errLog(`Token exchange failed (${tokenRes.status}): ${detail}`);
      return { exitCode: 4 };
    }
    const tokenBody = await tokenRes.json();
    accessToken = tokenBody.access_token;
    if (!accessToken) {
      errLog("Token exchange returned no access_token");
      return { exitCode: 4 };
    }
  } catch (err) {
    errLog(`Token exchange request failed: ${err.message}`);
    return { exitCode: 4 };
  }

  // Decode JWT claims (unverified) to extract clientId. The token came
  // from /oauth/token over TLS so it's trusted; verification happens
  // server-side on every subsequent API call.
  const claims = decodeJwtClaims(accessToken);
  const clientId = claims?.client_id || claims?.clientId;
  if (!clientId) {
    errLog("Access token missing clientId claim");
    return { exitCode: 5 };
  }

  // Mint long-lived tes_* via GraphQL.
  let plainTextToken;
  try {
    const graphqlRes = await fetch(`${endpoint}/api/graphql`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
        "x-client-id": clientId,
      },
      body: JSON.stringify({
        query: `mutation Mint($clientId: String!, $input: CreateApiTokenInput!) {
          createClientApiToken(clientId: $clientId, input: $input) {
            success
            plainTextToken
          }
        }`,
        variables: {
          clientId,
          input: {
            name: `ai-events-sdk · ${hostname()}`,
            role: "agent-events",
          },
        },
      }),
    });
    const body = await graphqlRes.json();
    if (body.errors?.length) {
      errLog(`API key mint failed: ${body.errors[0].message}`);
      return { exitCode: 6 };
    }
    plainTextToken = body?.data?.createClientApiToken?.plainTextToken;
    if (!plainTextToken) {
      errLog("API key mint returned no plainTextToken");
      return { exitCode: 6 };
    }
  } catch (err) {
    errLog(`API key mint request failed: ${err.message}`);
    return { exitCode: 6 };
  }

  // Write the long-lived credentials. Endpoint becomes the tenant
  // subdomain so subsequent SDK calls hit the right OAuth realm.
  const tenantEndpoint =
    endpoint === "https://api.pentatonic.com"
      ? `https://${clientId}.api.pentatonic.com`
      : endpoint;

  await writeCredentials({
    endpoint: tenantEndpoint,
    clientId,
    apiKey: plainTextToken,
  });

  log("");
  log(`  ✓ Connected as ${claims.email || "user"} on tenant \`${clientId}\``);
  log(`  ✓ Credentials written to ~/.config/tes/credentials.json`);
  log("");
  log("  Install the Pentatonic TES plugin to start capturing context:");
  log("");
  log("    Claude Code:");
  log("      /plugin marketplace add Pentatonic-Ltd/ai-agent-sdk");
  log("      /plugin install tes-memory@pentatonic-ai");
  log("");
  log("    OpenClaw:");
  log("      openclaw plugins install @pentatonic-ai/openclaw-memory-plugin");
  log("");
  log("  Already installed the plugin? Reload now to refresh the credentials.");
  log("");

  return { exitCode: 0, clientId };
}

/**
 * `init` alias — deprecated for one major release. Emits a stderr
 * warning then delegates to runLoginCommand. Removed in the next
 * major version.
 */
export async function runInitAlias(opts = {}) {
  const errLog = opts.errLog || ((m) => process.stderr.write(m + "\n"));
  errLog("  Notice: `init` is deprecated, use `login` instead. (This alias will be removed in the next major release.)");
  return runLoginCommand(opts);
}

function defaultOpenBrowser(url) {
  const opener =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "start"
        : "xdg-open";
  execFileSync(opener, [url], { stdio: "ignore" });
}

function decodeJwtClaims(jwt) {
  try {
    const [, payload] = jwt.split(".");
    const json = Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    return JSON.parse(json);
  } catch {
    return null;
  }
}
