import { spawn } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { trustedUnixBinary, windowsSystemBinary } from "./credentials.js";

/**
 * OAuth 2.1 public-client flows for `docslurp login` against DocSlurp's
 * authorization server: authorization code with PKCE (S256) and a loopback
 * redirect on an ephemeral 127.0.0.1 port (RFC 8252 §7.3), and the device
 * authorization grant (RFC 8628) for headless machines. Tokens are bound to
 * the REST API resource `<origin>/v1` (RFC 8707). Token values are never
 * printed or put in error messages.
 */

export const CLI_CLIENT_ID = "docslurp-cli";
export const SUPPORTED_SCOPES = ["search", "chat", "read", "ingest", "web"] as const;
/** Least privilege: search and read document text. Add chat or ingest with --scopes. */
export const DEFAULT_SCOPES = ["search", "read"] as const;
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const LOGIN_TIMEOUT_MS = 5 * 60_000;

export class OAuthError extends Error {
  constructor(message: string, readonly code?: string) { super(message); }
}

export type AuthorizationServer = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  revocation_endpoint?: string;
  device_authorization_endpoint?: string;
};

export type TokenSet = { accessToken: string; refreshToken: string; expiresAt: string; scopes: string[] };

/** Server text is shown only as a short, single-line, printable description. */
const safeText = (value: unknown) => typeof value === "string" ? value.replace(/[^\x20-\x7e]/g, " ").slice(0, 200) : "";

export function parseScopes(value: unknown): string[] {
  const scopes = typeof value === "string" && value.trim()
    ? [...new Set(value.split(/[\s,]+/).filter(Boolean))]
    : [...DEFAULT_SCOPES];
  const unknown = scopes.filter((scope) => !(SUPPORTED_SCOPES as readonly string[]).includes(scope));
  if (unknown.length) throw new OAuthError(`Unknown scope ${unknown.join(", ")}. Supported scopes: ${SUPPORTED_SCOPES.join(", ")}.`);
  return scopes;
}

export const apiResourceFor = (issuer: string) => `${issuer}/v1`;

/** RFC 8414 discovery. The issuer must be the API origin, and every endpoint must live on it. */
export async function discover(apiUrl: string): Promise<AuthorizationServer> {
  const origin = new URL(apiUrl).origin;
  let response: Response;
  try {
    response = await fetch(`${origin}/.well-known/oauth-authorization-server`, { signal: AbortSignal.timeout(15_000), headers: { accept: "application/json" } });
  } catch {
    throw new OAuthError(`Could not reach ${origin}. Check DOCSLURP_URL or --api-url.`);
  }
  if (!response.ok) throw new OAuthError(`${origin} does not offer OAuth sign-in (HTTP ${response.status}). Use an API key instead.`);
  const metadata = await response.json().catch(() => null) as AuthorizationServer | null;
  if (!metadata || typeof metadata.issuer !== "string" || typeof metadata.authorization_endpoint !== "string" || typeof metadata.token_endpoint !== "string") {
    throw new OAuthError(`${origin} returned invalid OAuth metadata.`);
  }
  if (metadata.issuer !== origin) {
    throw new OAuthError(`The authorization server identifies as ${safeText(metadata.issuer)}, not ${origin}. Use --api-url ${safeText(metadata.issuer)}.`);
  }
  for (const endpoint of [metadata.authorization_endpoint, metadata.token_endpoint, metadata.revocation_endpoint, metadata.device_authorization_endpoint]) {
    if (endpoint !== undefined && new URL(endpoint).origin !== origin) throw new OAuthError(`OAuth metadata from ${origin} points to another origin; refusing it.`);
  }
  return metadata;
}

function pkcePair() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function tokenRequest(server: AuthorizationServer, values: Record<string, string>): Promise<{ ok: true; tokens: TokenSet } | { ok: false; error: string; description: string; status: number }> {
  let response: Response;
  try {
    response = await fetch(server.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ client_id: CLI_CLIENT_ID, resource: apiResourceFor(server.issuer), ...values }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    return { ok: false, error: "network_error", description: `Could not reach ${new URL(server.token_endpoint).origin}.`, status: 0 };
  }
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) return { ok: false, error: safeText(body.error) || "server_error", description: safeText(body.error_description), status: response.status };
  if (typeof body.access_token !== "string" || typeof body.refresh_token !== "string" || typeof body.expires_in !== "number" || String(body.token_type).toLowerCase() !== "bearer") {
    return { ok: false, error: "invalid_response", description: "The token response was malformed.", status: response.status };
  }
  return {
    ok: true,
    tokens: {
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      expiresAt: new Date(Date.now() + body.expires_in * 1000).toISOString(),
      scopes: typeof body.scope === "string" ? body.scope.split(" ").filter(Boolean) : [],
    },
  };
}

export function openBrowser(url: string): void {
  if (process.env.DOCSLURP_NO_BROWSER === "1") return;
  // Absolute system paths only: never an `xdg-open` or `rundll32.exe` found through PATH or the working directory.
  const [command, args] = process.platform === "darwin" ? ["/usr/bin/open", [url]]
    : process.platform === "win32" ? [windowsSystemBinary("rundll32.exe"), ["url.dll,FileProtocolHandler", url]]
    : [trustedUnixBinary("xdg-open"), [url]];
  if (!command) return; // The printed URL is the fallback.
  try {
    const child = spawn(command as string, args as string[], { stdio: "ignore", detached: true, windowsHide: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // The printed URL is the fallback.
  }
}

const CALLBACK_PAGE = (title: string, detail: string) => `<!doctype html><html><head><meta charset="utf-8"><title>DocSlurp CLI</title></head>
<body style="font-family:system-ui,sans-serif;background:#07090d;color:#e8edf2;display:grid;place-items:center;min-height:100vh;margin:0">
<main style="max-width:28rem;padding:2rem;border:1px solid rgba(255,255,255,.12);border-radius:1rem"><h1 style="margin-top:0">${title}</h1><p>${detail}</p></main></body></html>`;

/**
 * Authorization code + PKCE with a one-shot loopback listener on 127.0.0.1.
 * A callback with the wrong `state`, a foreign `iss`, an error or no code ends
 * the login with a refusal (fail closed); the code is never exchanged.
 */
export async function loopbackLogin(server: AuthorizationServer, scopes: string[], options: { openBrowser: boolean; print: (line: string) => void }): Promise<TokenSet> {
  const { verifier, challenge } = pkcePair();
  const state = randomBytes(32).toString("base64url");
  const listener = createServer();
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => resolve());
  });
  const port = (listener.address() as AddressInfo).port;
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  try {
    const code = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new OAuthError("Timed out waiting for the browser sign-in. Run `docslurp login` again, or use `docslurp login --device`.")), LOGIN_TIMEOUT_MS);
      listener.on("request", (request, response) => {
        const url = new URL(request.url ?? "/", redirectUri);
        if (request.method !== "GET" || url.pathname !== "/callback") {
          response.writeHead(404).end();
          return;
        }
        const finish = (status: number, title: string, detail: string, error?: OAuthError) => {
          response.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" });
          response.end(CALLBACK_PAGE(title, detail));
          clearTimeout(timer);
          if (error) reject(error); else resolve(url.searchParams.get("code")!);
        };
        const returnedState = url.searchParams.get("state") ?? "";
        if (!sameSecret(returnedState, state)) {
          // A stray or forged callback (another tab, a local process): refuse it
          // and keep waiting for the one carrying our state. Its code is never used.
          response.writeHead(400, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" });
          response.end(CALLBACK_PAGE("Sign-in refused", "This response did not match the sign-in started by your terminal."));
          options.print("Ignored a sign-in response that did not match this login (wrong state); still waiting.");
          return;
        }
        const issuer = url.searchParams.get("iss");
        if (issuer !== null && issuer !== server.issuer) {
          finish(400, "Sign-in refused", "The response came from an unexpected server.", new OAuthError("Sign-in refused: the response came from an unexpected issuer.", "issuer_mismatch"));
          return;
        }
        const error = url.searchParams.get("error");
        if (error) {
          finish(400, "Sign-in cancelled", "You can close this tab.", new OAuthError(error === "access_denied" ? "Sign-in was denied in the browser." : `Sign-in failed: ${safeText(error)}.`, safeText(error)));
          return;
        }
        if (!url.searchParams.get("code")) {
          finish(400, "Sign-in failed", "No authorization code was returned.", new OAuthError("Sign-in failed: no authorization code was returned.", "missing_code"));
          return;
        }
        finish(200, "Signed in", "You can close this tab and return to your terminal.");
      });
      const authorize = new URL(server.authorization_endpoint);
      for (const [key, value] of Object.entries({
        client_id: CLI_CLIENT_ID, response_type: "code", redirect_uri: redirectUri,
        code_challenge: challenge, code_challenge_method: "S256", scope: scopes.join(" "),
        state, resource: apiResourceFor(server.issuer),
      })) authorize.searchParams.set(key, value);
      options.print(`Opening your browser to sign in. If it does not open, visit:\n\n  ${authorize.href}\n`);
      if (options.openBrowser) openBrowser(authorize.href);
    });
    const result = await tokenRequest(server, { grant_type: "authorization_code", code, redirect_uri: redirectUri, code_verifier: verifier });
    if (!result.ok) throw new OAuthError(`Sign-in failed: ${result.description || result.error}`, result.error);
    return result.tokens;
  } finally {
    listener.closeAllConnections?.();
    listener.close();
  }
}

/** RFC 8628 device flow: print the code, then poll at the server's interval (plus 5 s on slow_down) until approval or expiry. */
export async function deviceLogin(server: AuthorizationServer, scopes: string[], options: { print: (line: string) => void; sleep?: (ms: number) => Promise<void> }): Promise<TokenSet> {
  if (!server.device_authorization_endpoint) throw new OAuthError("This DocSlurp server does not support `docslurp login --device`.");
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  let response: Response;
  try {
    response = await fetch(server.device_authorization_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ client_id: CLI_CLIENT_ID, scope: scopes.join(" "), resource: apiResourceFor(server.issuer) }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new OAuthError(`Could not reach ${server.issuer}.`);
  }
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new OAuthError(`Device sign-in failed: ${safeText(body.error_description) || safeText(body.error) || `HTTP ${response.status}`}`);
  const { device_code: deviceCode, user_code: userCode, verification_uri: verificationUri } = body;
  if (typeof deviceCode !== "string" || typeof userCode !== "string" || typeof verificationUri !== "string") throw new OAuthError("The device authorization response was malformed.");
  // Only ever send the user to the issuer's own verification page.
  if (new URL(verificationUri).origin !== server.issuer) throw new OAuthError("The device verification page is not on the DocSlurp server; refusing it.");
  let interval = Math.max(1, Number(body.interval) || 5) * 1000;
  const deadline = Date.now() + Math.max(30, Number(body.expires_in) || 600) * 1000;
  options.print(`To sign in, open this page on any device:\n\n  ${verificationUri}\n\nand enter the code:\n\n  ${safeText(userCode)}\n\nWaiting for approval (expires in ${Math.round((deadline - Date.now()) / 60_000)} minutes)...`);
  while (Date.now() < deadline) {
    await sleep(interval);
    const result = await tokenRequest(server, { grant_type: DEVICE_GRANT, device_code: deviceCode });
    if (result.ok) return result.tokens;
    if (result.error === "authorization_pending" || result.error === "network_error") continue;
    if (result.error === "slow_down") { interval += 5000; continue; }
    if (result.error === "expired_token") break;
    if (result.error === "access_denied") throw new OAuthError("Sign-in was denied.", "access_denied");
    throw new OAuthError(`Device sign-in failed: ${result.description || result.error}`, result.error);
  }
  throw new OAuthError("The device code expired before it was approved. Run `docslurp login --device` again.", "expired_token");
}

export async function refreshTokens(server: AuthorizationServer, refreshToken: string): Promise<{ ok: true; tokens: TokenSet } | { ok: false; error: string; description: string; status: number }> {
  return await tokenRequest(server, { grant_type: "refresh_token", refresh_token: refreshToken });
}

/** RFC 7009 revocation of the refresh token, which revokes the whole grant. */
export async function revokeToken(server: AuthorizationServer, token: string): Promise<void> {
  if (!server.revocation_endpoint) throw new OAuthError("This DocSlurp server has no revocation endpoint.");
  let response: Response;
  try {
    response = await fetch(server.revocation_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: CLI_CLIENT_ID, token, token_type_hint: "refresh_token" }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new OAuthError(`Could not reach ${server.issuer} to revoke the login.`);
  }
  if (!response.ok) throw new OAuthError(`The server refused the revocation (HTTP ${response.status}).`);
}
