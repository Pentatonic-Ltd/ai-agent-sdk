import { mkdir, writeFile, readFile, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Resolve the path to ~/.config/tes/credentials.json (or the
 * XDG_CONFIG_HOME equivalent).
 *
 * Same path the corpus CLI already uses — single source of truth for
 * the SDK's tenant config across login and ingest commands.
 */
export function credentialsPath() {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "tes", "credentials.json");
}

/**
 * Persist tenant credentials to ~/.config/tes/credentials.json with
 * mode 0600. Overwrites any existing file (login = re-auth).
 *
 * @param {object} creds
 * @param {string} creds.endpoint - e.g. https://tes-demo.api.pentatonic.com
 * @param {string} creds.clientId - tenant slug
 * @param {string} creds.apiKey   - the long-lived tes_* token
 */
export async function writeCredentials({ endpoint, clientId, apiKey }) {
  if (!endpoint || !clientId || !apiKey) {
    throw new Error("writeCredentials: endpoint, clientId, apiKey all required");
  }
  const path = credentialsPath();
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(
    path,
    JSON.stringify({ endpoint, clientId, apiKey }, null, 2) + "\n",
    { mode: 0o600 }
  );
  // mkdir + writeFile race can leave a transient wider mode on some
  // filesystems; chmod after to be sure.
  await chmod(path, 0o600);
}

/**
 * Read existing credentials. Returns null if the file is absent or
 * unreadable.
 */
export async function readCredentials() {
  const path = credentialsPath();
  if (!existsSync(path)) return null;
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed.endpoint || !parsed.clientId || !parsed.apiKey) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Ping TES with the stored credentials. Returns { ok, email, clientName }
 * on success or { ok: false, status, error } on failure.
 *
 * Used by `status` to surface "logged in as / creds invalid" messages.
 */
export async function pingTes(creds) {
  if (!creds) return { ok: false, error: "no credentials" };
  const query = `{ me { email } client(id: "${creds.clientId}") { name } }`;
  try {
    const res = await fetch(`${creds.endpoint}/api/graphql`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${creds.apiKey}`,
        "x-client-id": creds.clientId,
      },
      body: JSON.stringify({ query }),
    });
    if (res.status === 401) {
      return { ok: false, status: 401, error: "credentials invalid" };
    }
    if (!res.ok) {
      return { ok: false, status: res.status, error: await res.text() };
    }
    const body = await res.json();
    if (body.errors?.length) {
      return { ok: false, error: body.errors[0].message };
    }
    return {
      ok: true,
      email: body.data?.me?.email || null,
      clientName: body.data?.client?.name || creds.clientId,
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
