import { Hono, type Context } from "hono";

import { appDbPool } from "../lib/auth.js";
import { resolveBetterAuthSessionActor, type SessionRequestActor } from "../lib/request-actor.js";
import {
  apiResource,
  createGrant,
  DEVICE_ATTEMPT_WINDOW_MINUTES,
  deviceAttemptsExhausted,
  findPendingDeviceRequest,
  formatUserCode,
  mcpOrigin,
  normalizeUserCode,
  recordDeviceAttemptFailure,
  transaction,
} from "../services/mcp-oauth.js";

/**
 * Device verification page (RFC 8628 §3.3) at /oauth/mcp/device.
 *
 * - Requires a signed-in Better Auth session. A signed-out visitor is told to
 *   sign in; nothing about the code is looked up.
 * - A `user_code` in the link only prefills the form. The code is looked up
 *   only on an explicit POST, and every miss counts against the user's
 *   lockout budget (DEVICE_MAX_FAILED_ATTEMPTS per window), so the page cannot be used to
 *   enumerate codes. Approve and deny re-check the code and count too.
 * - The confirmation shows the client, the audience, the scopes, the signed-in
 *   account and the code, and asks the user to match the code with the one in
 *   their terminal (RFC 8628 §5.4: remote phishing).
 * - Approval is one-time: the row stops being pending, so a second approval
 *   (or a denial after approval) is refused.
 * - POSTs require the canonical Origin; the page cannot be framed.
 */
export const deviceVerificationRoutes = new Hono();

const SCOPE_COPY: Record<string, string> = {
  search: "Search your documents and get cited passages",
  chat: "Ask questions and get generated answers (uses your credits)",
  read: "Read document text, pages, files and runs",
  ingest: "Upload documents, ingest URLs and reprocess or delete documents (uses your credits)",
};

const escapeHtml = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);

function page(c: Context, title: string, body: string, status: 200 | 400 | 403 | 429 = 200) {
  c.header("Cache-Control", "no-store");
  c.header("X-Frame-Options", "DENY");
  c.header("Referrer-Policy", "no-referrer");
  c.header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
  return c.html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>DocSlurp · ${escapeHtml(title)}</title>
<style>
:root{color-scheme:dark}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:radial-gradient(ellipse at top,#0f2a2c 0,#07090d 60%);color:#e8edf2;font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
main{width:min(30rem,92vw);padding:2rem;border:1px solid rgba(255,255,255,.1);border-radius:1.25rem;background:rgba(14,18,24,.78);box-shadow:0 0 80px rgba(45,212,191,.08)}
h1{margin:0 0 .75rem;font-size:1.5rem;letter-spacing:-.02em}
p{color:#aab4bf;margin:.5rem 0}
.code{font:600 1.75rem/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.2em;color:#5eead4;text-align:center;padding:1rem;border:1px dashed rgba(94,234,212,.4);border-radius:.75rem;margin:1rem 0}
input[type=text]{width:100%;box-sizing:border-box;font:600 1.4rem ui-monospace,monospace;letter-spacing:.2em;text-transform:uppercase;text-align:center;padding:.75rem;border-radius:.75rem;border:1px solid rgba(255,255,255,.18);background:#0b0f14;color:#e8edf2}
select{width:100%;padding:.6rem;border-radius:.6rem;background:#0b0f14;color:#e8edf2;border:1px solid rgba(255,255,255,.18)}
button{font:600 15px system-ui,sans-serif;padding:.7rem 1.2rem;border-radius:.75rem;border:0;cursor:pointer}
.primary{background:#2dd4bf;color:#04201d}.secondary{background:rgba(255,255,255,.08);color:#e8edf2}
.row{display:flex;gap:.75rem;margin-top:1.25rem}
ul{padding-left:1.1rem;color:#cfd8e1}li{margin:.25rem 0}
.meta{font-size:13px;color:#8995a1}.badge{display:inline-block;font-size:12px;padding:.1rem .5rem;border-radius:99px;background:rgba(167,139,250,.15);color:#c4b5fd}
.error{color:#fda4af}
</style></head><body><main>${body}</main></body></html>`, status);
}

async function sessionOrSignIn(c: Context): Promise<SessionRequestActor | Response> {
  const actor = await resolveBetterAuthSessionActor(c.req.raw.headers);
  if (actor) return actor;
  return page(c, "Sign in", `<h1>Sign in to connect a device</h1>
<p>Sign in to DocSlurp in this browser, then open this page again and enter the code shown in your terminal.</p>
<div class="row"><a href="/app/sign-in"><button class="primary" type="button">Sign in</button></a></div>`, 403);
}

function codeForm(prefill: string, message = "") {
  return `<h1>Connect a device</h1>
<p>Enter the code shown by the DocSlurp CLI on your other device.</p>
${message ? `<p class="error">${escapeHtml(message)}</p>` : ""}
<form method="post">
<input type="hidden" name="action" value="lookup">
<input type="text" name="user_code" value="${escapeHtml(prefill)}" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="12" placeholder="XXXX-XXXX" required aria-label="Device code">
<div class="row"><button class="primary" type="submit">Continue</button></div>
</form>
<p class="meta">Only continue with a code you started yourself. Never enter a code someone sent you.</p>`;
}

function lockedPage(c: Context) {
  return page(c, "Too many attempts", `<h1>Too many attempts</h1>
<p>Too many codes were entered incorrectly. Wait ${DEVICE_ATTEMPT_WINDOW_MINUTES} minutes, then start a new login on your device.</p>`, 429);
}

const sameOrigin = (c: Context) => c.req.header("origin") === mcpOrigin(c.req.url);

deviceVerificationRoutes.get("/", async (c) => {
  const actor = await sessionOrSignIn(c);
  if (actor instanceof Response) return actor;
  // The link's code is only a prefill; nothing is looked up until the user submits it.
  const prefill = normalizeUserCode(c.req.query("user_code"));
  return page(c, "Connect a device", codeForm(prefill ? formatUserCode(prefill) : ""));
});

deviceVerificationRoutes.post("/", async (c) => {
  if (!sameOrigin(c)) return page(c, "Forbidden", "<h1>Request refused</h1><p>Open the link from your terminal again.</p>", 403);
  const actor = await sessionOrSignIn(c);
  if (actor instanceof Response) return actor;
  const body = await c.req.parseBody();
  const action = body.action === "approve" || body.action === "deny" ? body.action : "lookup";

  if (await deviceAttemptsExhausted(appDbPool, actor.userId)) return lockedPage(c);
  const code = normalizeUserCode(body.user_code);
  const miss = async (message: string) => {
    await recordDeviceAttemptFailure(appDbPool, actor.userId);
    if (await deviceAttemptsExhausted(appDbPool, actor.userId)) return lockedPage(c);
    return page(c, "Connect a device", codeForm("", message), 400);
  };
  if (!code) return await miss("That code is not valid. Codes are 8 letters and digits, like WDJB-MJHT.");

  if (action === "lookup") {
    const request = await findPendingDeviceRequest(appDbPool, code);
    if (!request) return await miss("That code is not recognised, has expired or was already used.");
    const orgs = (await appDbPool.query(
      "SELECT o.id, o.name FROM org_memberships m JOIN organizations o ON o.id=m.org_id WHERE m.user_id=$1 ORDER BY o.name",
      [actor.userId],
    )).rows as Array<{ id: string; name: string }>;
    const scopes = (request.scopes as string[]).map((scope) => `<li>${escapeHtml(SCOPE_COPY[scope] ?? scope)}</li>`).join("");
    const withheld = Object.keys(SCOPE_COPY).filter((scope) => !(request.scopes as string[]).includes(scope));
    const audience = request.resource === apiResource(c.req.url) ? "the DocSlurp API (REST and MCP)" : "DocSlurp MCP tools";
    const minutes = Math.max(1, Math.round((new Date(request.expires_at).getTime() - Date.now()) / 60_000));
    return page(c, "Approve device", `<h1>Connect ${escapeHtml(request.client_name)}?</h1>
${request.first_party ? `<span class="badge">First-party DocSlurp client</span>` : ""}
<p>Check that this code matches the one in your terminal:</p>
<div class="code">${escapeHtml(formatUserCode(code))}</div>
<p>It will be able to use ${escapeHtml(audience)} as <strong>${escapeHtml(actor.user.email || actor.user.name)}</strong>:</p>
<ul>${scopes}</ul>
${withheld.length ? `<p class="meta">Not granted: ${escapeHtml(withheld.join(", "))}. It can never change workspace settings or manage your organization.</p>` : `<p class="meta">It can never change workspace settings or manage your organization.</p>`}
<form method="post">
<input type="hidden" name="user_code" value="${escapeHtml(formatUserCode(code))}">
<label class="meta" for="org">Organization</label>
<select id="org" name="orgId">${orgs.map((org) => `<option value="${escapeHtml(org.id)}">${escapeHtml(org.name)}</option>`).join("")}</select>
<div class="row"><button class="primary" name="action" value="approve" type="submit">Approve</button><button class="secondary" name="action" value="deny" type="submit">Deny</button></div>
</form>
<p class="meta">This request expires in about ${minutes} minute${minutes === 1 ? "" : "s"}. You can revoke access later from your account.</p>`);
  }

  const orgId = typeof body.orgId === "string" && body.orgId.length <= 200 ? body.orgId : null;
  const outcome = await transaction(async (db) => {
    const request = await findPendingDeviceRequest(db, code, true);
    if (!request) return "missing" as const;
    if (action === "deny") {
      await db.query("UPDATE mcp_oauth_device_codes SET denied_at=now(), user_id=$2 WHERE device_code_hash=$1", [request.device_code_hash, actor.userId]);
      return "denied" as const;
    }
    if (!orgId || !(await db.query("SELECT 1 FROM org_memberships WHERE org_id=$1 AND user_id=$2", [orgId, actor.userId])).rowCount)
      return "organization" as const;
    const grantId = await createGrant(db, { clientId: request.client_id, userId: actor.userId, orgId, resource: request.resource, scopes: request.scopes, url: c.req.url });
    await db.query("UPDATE mcp_oauth_device_codes SET approved_at=now(), user_id=$2, grant_id=$3 WHERE device_code_hash=$1", [request.device_code_hash, actor.userId, grantId]);
    return "approved" as const;
  });
  if (outcome === "missing") return await miss("That code is not recognised, has expired or was already used.");
  if (outcome === "organization") return page(c, "Connect a device", codeForm(formatUserCode(code), "Choose an organization you belong to."), 400);
  if (outcome === "denied") return page(c, "Request denied", "<h1>Request denied</h1><p>The device was not connected. You can close this tab.</p>");
  return page(c, "Device connected", "<h1>Device connected</h1><p>Return to your terminal; the DocSlurp CLI finishes signing in on its own. You can close this tab.</p>");
});
