import { createServer } from "node:http";
import { URL } from "node:url";

const SUCCESS_HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Connected</title>
<style>body{font-family:system-ui,sans-serif;max-width:480px;margin:80px auto;padding:24px;color:#1a1a1a;line-height:1.5}h1{font-size:1.4em}</style>
</head><body>
<h1>✓ Connected</h1>
<p>The CLI now has a token. You can close this tab.</p>
</body></html>`;

const ERROR_HTML = (msg) => `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Error</title></head><body>
<h1>Connection failed</h1><p>${msg.replace(/</g, "&lt;")}</p>
<p>Return to the terminal and re-run the command.</p>
</body></html>`;

/**
 * Start an HTTP server that listens for the OAuth localhost callback.
 *
 * Returns:
 *   - port (number): the bound port (resolved before any callback hits)
 *   - result (Promise<{code, state}>): resolves on first valid /callback
 *     hit; rejects on state mismatch, malformed query, or timeout.
 *   - cancel (function): close the server early without resolving.
 *
 * The server serves a tiny "you can close this tab" HTML page on the
 * successful callback and closes itself after sending the response.
 *
 * @param {object} opts
 * @param {number[]} opts.ports - Ordered list of ports to try; 0 means
 *   "let the OS pick". The first port that binds wins.
 * @param {string} opts.state - The expected state value; callback must
 *   carry exactly this for resolution to fire.
 * @param {number} [opts.timeoutMs=300000] - Default 5 min.
 */
export async function startCallbackServer({ ports, state, timeoutMs = 300_000 }) {
  if (!Array.isArray(ports) || ports.length === 0) {
    throw new Error("startCallbackServer: ports[] required");
  }
  if (typeof state !== "string" || state.length === 0) {
    throw new Error("startCallbackServer: state required");
  }

  const server = createServer();
  await tryBind(server, ports);
  const boundPort = server.address().port;

  let resolveResult, rejectResult;
  const result = new Promise((res, rej) => {
    resolveResult = res;
    rejectResult = rej;
  });
  // Attach a no-op catch so cancelling without awaiting result doesn't
  // raise an unhandled-rejection (kills the Node process under
  // --unhandled-rejections=strict, the default in modern Node). Real
  // callers can still attach .catch() later — promises support multiple
  // handlers and only the LAST unhandled state matters.
  result.catch(() => {});

  const timer = setTimeout(() => {
    rejectResult(new Error(`Login timed out after ${Math.round(timeoutMs / 1000)}s`));
    server.close();
  }, timeoutMs);

  server.on("request", (req, res) => {
    try {
      const url = new URL(req.url, `http://localhost:${boundPort}`);
      if (url.pathname !== "/callback") {
        res.writeHead(404).end("Not Found");
        return;
      }
      const code = url.searchParams.get("code");
      const gotState = url.searchParams.get("state");
      if (!code || !gotState) {
        res.writeHead(400, { "Content-Type": "text/html" }).end(ERROR_HTML("Missing code or state"));
        rejectResult(new Error("Callback missing code or state"));
        clearTimeout(timer);
        server.close();
        return;
      }
      if (gotState !== state) {
        res.writeHead(400, { "Content-Type": "text/html" }).end(ERROR_HTML("State mismatch"));
        rejectResult(new Error("Callback state mismatch (CSRF / replay protection)"));
        clearTimeout(timer);
        server.close();
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(SUCCESS_HTML);
      resolveResult({ code, state: gotState });
      clearTimeout(timer);
      server.close();
    } catch (err) {
      rejectResult(err);
      clearTimeout(timer);
      try { res.writeHead(500).end(); } catch {}
      server.close();
    }
  });

  return {
    port: boundPort,
    result,
    cancel() {
      clearTimeout(timer);
      try { rejectResult(new Error("cancelled")); } catch {}
      server.close();
    },
  };
}

function tryBind(server, ports) {
  return new Promise((resolve, reject) => {
    const tryNext = (i) => {
      if (i >= ports.length) {
        reject(new Error(`Could not bind to any of ports: ${ports.join(", ")}`));
        return;
      }
      const onError = (err) => {
        server.removeListener("listening", onListening);
        if (err.code === "EADDRINUSE" || err.code === "EACCES") {
          tryNext(i + 1);
        } else {
          reject(err);
        }
      };
      const onListening = () => {
        server.removeListener("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(ports[i], "127.0.0.1");
    };
    tryNext(0);
  });
}
