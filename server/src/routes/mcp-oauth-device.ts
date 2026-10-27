import { Hono, type Context } from "hono";

import { appDbPool } from "../lib/auth.js";
import { resolveBetterAuthSessionActor, type SessionRequestActor } from "../lib/request-actor.js";
import { requestIp } from "../lib/request-context.js";
import {
  apiResource,
  createGrant,
  DEVICE_ATTEMPT_WINDOW_MINUTES,
  DEVICE_BASE_SCOPES,
  deviceAttemptBudget,
  deviceAttemptsExhausted,
  deviceGlobalFrictionMs,
  deviceGrantScopes,
  findPendingDeviceRequest,
  formatUserCode,
  lockDeviceAttempts,
  mcpOrigin,
  normalizeUserCode,
  recordDeviceAttemptFailure,
  transaction,
} from "../services/mcp-oauth.js";

/**
 * Device verification page (RFC 8628 §3.3) at /oauth/mcp/device.
 *
 * - Requires a signed-in Better Auth session. A signed-out visitor gets a
 *   sign-in link that returns here; nothing about a code is looked up.
 * - There is no prefilled-code link (no verification_uri_complete): the user
 *   types the code their own terminal shows, so a phisher cannot hand a
 *   victim a one-click approval link (RFC 8628 §5.4).
 * - Every lookup, approval and denial runs in one transaction that takes a
 *   per-user advisory lock, checks the hard wrong-code budgets (per user and
 *   per IP) and records a miss, so concurrent guesses cannot race the lockout.
 *   Deployment-wide pressure only adds a delay and an alert, never a refusal.
 * - The confirmation shows the client, the audience, the signed-in account,
 *   the code, when the request was made and from which IP (next to the
 *   approver's own), and asks the user to match the code with their terminal.
 * - Device approvals grant only `search` and `read` by default. Any other
 *   requested scope (chat, ingest, web) is an unticked opt-in on the page.
 * - Approval is one-time: the row stops being pending, so a second approval
 *   (or a denial after approval) is refused.
 * - POSTs require the canonical Origin (an absent or `null` Origin is refused
 *   with an explanation); the page cannot be framed.
 */
export const deviceVerificationRoutes = new Hono();

const SCOPE_COPY: Record<string, string> = {
  search: "Search your documents and get cited passages",
  read: "Read document text, pages, files, runs and exports",
  chat: "Ask questions and get generated answers (spends your credits)",
  ingest: "Upload documents and ingest URLs, and reprocess, retag or delete documents (spends your credits)",
  web: "Use paid web search, fetch, map and crawl (spends your credits)",
};

const escapeHtml = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);

function page(c: Context, title: string, body: string, status: 200 | 400 | 403 | 429 = 200) {
  c.header("Cache-Control", "no-store");
  c.header("X-Frame-Options", "DENY");
  // same-origin, not no-referrer: with no-referrer a browser sends `Origin: null`
  // on the form POST and the origin check below (and the app's CSRF guard) refuse it.
  c.header("Referrer-Policy", "same-origin");
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
label.opt{display:flex;gap:.5rem;align-items:flex-start;color:#cfd8e1;margin:.35rem 0}
.warn{color:#fdba74}
</style></head><body><main>${body}</main></body></html>`, status);
}

async function sessionOrSignIn(c: Context): Promise<SessionRequestActor | Response> {
  const actor = await resolveBetterAuthSessionActor(c.req.raw.headers);
  if (actor) return actor;
  // The app's sign-in page resumes /oauth/mcp/device after login (app lib/mcp-login-return.ts).
  const signIn = `/app/mcp/authorize?authorize=${encodeURIComponent("/oauth/mcp/device")}`;
  return page(c, "Sign in", `<h1>Sign in to connect a device</h1>
<p>Sign in to DocSlurp in this browser. You will come back here to enter the code shown in your terminal.</p>
<div class="row"><a href="${escapeHtml(signIn)}"><button class="primary" type="button">Sign in</button></a></div>`, 403);
}

function codeForm(message = "") {
  return `<h1>Connect a device</h1>
<p>Type the code shown by the DocSlurp CLI in your terminal.</p>
${message ? `<p class="error">${escapeHtml(message)}</p>` : ""}
<form method="post">
<input type="hidden" name="action" value="lookup">
<input type="text" name="user_code" value="" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="12" placeholder="XXXX-XXXX" required aria-label="Device code">
<div class="row"><button class="primary" type="submit">Continue</button></div>
</form>
<p class="meta">Only enter a code from a login you started yourself. Never enter a code someone sent you.</p>`;
}

function lockedPage(c: Context) {
  return page(c, "Too many attempts", `<h1>Too many attempts</h1>
<p>Too many codes were entered incorrectly. Wait ${DEVICE_ATTEMPT_WINDOW_MINUTES} minutes, then start a new login on your device.</p>`, 429);
}

function ago(date: Date): string {
  const minutes = Math.max(0, Math.round((Date.now() - date.getTime()) / 60_000));
  return minutes === 0 ? "just now" : `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
}

deviceVerificationRoutes.get("/", async (c) => {
  const actor = await sessionOrSignIn(c);
  if (actor instanceof Response) return actor;
  // Any user_code in the query is ignored: the code is always typed.
  return page(c, "Connect a device", codeForm());
});

type Outcome =
  | { kind: "locked" | "invalid" | "missing" | "organization" | "no_scopes" | "denied" | "approved" }
  | { kind: "confirm"; request: Record<string, any>; orgs: Array<{ id: string; name: string }> };

deviceVerificationRoutes.post("/", async (c) => {
  const origin = c.req.header("origin");
  if (origin !== mcpOrigin(c.req.url)) {
    return page(c, "Request refused", `<h1>Request refused</h1>
<p>${origin === undefined || origin === "null"
      ? "Your browser did not say which site sent this form, so it was refused. Open this page directly in your browser, not from another app or a privacy extension that strips it, and try again."
      : "This form was not sent from DocSlurp. Open the page directly in your browser and try again."}</p>`, 403);
  }
  const actor = await sessionOrSignIn(c);
  if (actor instanceof Response) return actor;
  const body = await c.req.parseBody({ all: true });
  const field = (name: string) => (Array.isArray(body[name]) ? (body[name] as unknown[])[0] : body[name]);
  const action = field("action") === "approve" || field("action") === "deny" ? field("action") as "approve" | "deny" : "lookup";
  const optIn = ([] as unknown[]).concat(body.optIn ?? []).filter((value): value is string => typeof value === "string");
  const orgIdField = field("orgId");
  const orgId = typeof orgIdField === "string" && orgIdField.length <= 200 ? orgIdField : null;
  const code = normalizeUserCode(field("user_code"));
  const ip = requestIp(c);
  // Deployment-wide guessing pressure adds a delay before any lookup (outside
  // the transaction, so no lock is held while waiting). It never refuses.
  if ((await deviceAttemptBudget(appDbPool, actor.userId, ip)).globalPressure) {
    await new Promise((resolve) => setTimeout(resolve, deviceGlobalFrictionMs()));
  }

  const outcome = await transaction(async (db): Promise<Outcome> => {
    await lockDeviceAttempts(db, actor.userId);
    if (await deviceAttemptsExhausted(db, actor.userId, ip)) return { kind: "locked" };
    const miss = async (kind: "invalid" | "missing"): Promise<Outcome> => {
      await recordDeviceAttemptFailure(db, actor.userId, ip);
      return (await deviceAttemptsExhausted(db, actor.userId, ip)) ? { kind: "locked" } : { kind };
    };
    if (!code) return await miss("invalid");
    const request = await findPendingDeviceRequest(db, code, action !== "lookup");
    if (!request) return await miss("missing");
    if (action === "lookup") {
      const orgs = (await db.query(
        "SELECT o.id, o.name FROM org_memberships m JOIN organizations o ON o.id=m.org_id WHERE m.user_id=$1 ORDER BY o.name",
        [actor.userId],
      )).rows as Array<{ id: string; name: string }>;
      return { kind: "confirm", request, orgs };
    }
    if (action === "deny") {
      await db.query("UPDATE mcp_oauth_device_codes SET denied_at=now(), user_id=$2 WHERE device_code_hash=$1", [request.device_code_hash, actor.userId]);
      return { kind: "denied" };
    }
    if (!orgId || !(await db.query("SELECT 1 FROM org_memberships WHERE org_id=$1 AND user_id=$2", [orgId, actor.userId])).rowCount)
      return { kind: "organization" };
    const scopes = deviceGrantScopes(request.scopes as string[], optIn);
    if (!scopes.length) return { kind: "no_scopes" };
    const grantId = await createGrant(db, { clientId: request.client_id, userId: actor.userId, orgId, resource: request.resource, scopes, url: c.req.url });
    await db.query("UPDATE mcp_oauth_device_codes SET approved_at=now(), user_id=$2, grant_id=$3 WHERE device_code_hash=$1", [request.device_code_hash, actor.userId, grantId]);
    return { kind: "approved" };
  });

  switch (outcome.kind) {
    case "locked": return lockedPage(c);
    case "invalid": return page(c, "Connect a device", codeForm("That code is not valid. Codes are 8 letters and digits, like WDJB-MJHT."), 400);
    case "missing": return page(c, "Connect a device", codeForm("That code is not recognised, has expired or was already used."), 400);
    case "organization": return page(c, "Connect a device", codeForm("Choose an organization you belong to, then enter the code again."), 400);
    case "no_scopes": return page(c, "Connect a device", codeForm("Choose at least one permission, then enter the code again."), 400);
    case "denied": return page(c, "Request denied", "<h1>Request denied</h1><p>The device was not connected. You can close this tab.</p>");
    case "approved": return page(c, "Device connected", "<h1>Device connected</h1><p>Return to your terminal; the DocSlurp CLI finishes signing in on its own. You can close this tab.</p>");
  }

  const { request, orgs } = outcome;
  const requested = request.scopes as string[];
  const base = requested.filter((scope) => (DEVICE_BASE_SCOPES as readonly string[]).includes(scope));
  const extras = requested.filter((scope) => !(DEVICE_BASE_SCOPES as readonly string[]).includes(scope));
  const audience = request.resource === apiResource(c.req.url) ? "the DocSlurp API (REST and MCP)" : "DocSlurp MCP tools";
  const created = new Date(request.created_at);
  const minutes = Math.max(1, Math.round((new Date(request.expires_at).getTime() - Date.now()) / 60_000));
  const requesterIp = typeof request.requester_ip === "string" && request.requester_ip ? request.requester_ip : "unknown";
  return page(c, "Approve device", `<h1>Connect ${escapeHtml(request.client_name)}?</h1>
${request.first_party ? `<span class="badge">First-party DocSlurp client</span>` : ""}
<p>Check that this code matches the one in <strong>your own</strong> terminal:</p>
<div class="code">${escapeHtml(formatUserCode(code!))}</div>
<p class="meta">Requested ${escapeHtml(ago(created))} (${escapeHtml(created.toISOString().replace("T", " ").slice(0, 16))} UTC) from IP <strong>${escapeHtml(requesterIp)}</strong>. Your IP: ${escapeHtml(ip ?? "unknown")}.</p>
${requesterIp !== "unknown" && ip && requesterIp !== ip ? `<p class="warn">The request came from a different network than this browser. That is normal over SSH; if you did not just run <code>docslurp login --device</code>, deny it.</p>` : ""}
<p>It will be able to use ${escapeHtml(audience)} as <strong>${escapeHtml(actor.user.email || actor.user.name)}</strong>:</p>
<form method="post">
<ul>${base.map((scope) => `<li>${escapeHtml(SCOPE_COPY[scope] ?? scope)}</li>`).join("") || "<li>Nothing unless you tick an option below</li>"}</ul>
${extras.length ? `<p class="meta">It also asked for these. They are off unless you tick them:</p>
${extras.map((scope) => `<label class="opt"><input type="checkbox" name="optIn" value="${escapeHtml(scope)}"> <span>${escapeHtml(SCOPE_COPY[scope] ?? scope)}</span></label>`).join("")}` : ""}
<p class="meta">It can never change workspace settings, manage your organization or create API keys.</p>
<input type="hidden" name="user_code" value="${escapeHtml(formatUserCode(code!))}">
<label class="meta" for="org">Organization</label>
<select id="org" name="orgId">${orgs.map((org) => `<option value="${escapeHtml(org.id)}">${escapeHtml(org.name)}</option>`).join("")}</select>
<div class="row"><button class="primary" name="action" value="approve" type="submit">Approve</button><button class="secondary" name="action" value="deny" type="submit">Deny</button></div>
</form>
<p class="meta">This request expires in about ${minutes} minute${minutes === 1 ? "" : "s"}. You can revoke access later from your account.</p>`);
});
