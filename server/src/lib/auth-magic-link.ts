import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { magicLink } from "better-auth/plugins";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { safeRedirectPath } from "./safe-redirect.js";

export const MAGIC_LINK_SECONDS = 300;

/** Only app-owned destinations; never forward a token to another auth/API endpoint. */
export function magicLinkCallback(value: unknown): string {
  if (value === undefined) return "/app";
  const path = safeRedirectPath(value, "");
  if (!path || !(path === "/app" || path.startsWith("/app/") || path.startsWith("/app?") || path.startsWith("/app#"))) {
    throw new APIError("BAD_REQUEST", { code: "INVALID_CALLBACK_URL", message: "Choose an app page to continue." });
  }
  return path;
}

export function magicLinkLandingUrl(url: string): string {
  const native = new URL(url);
  const landing = new URL("/auth/magic-link", native.origin);
  landing.hash = new URLSearchParams({ token: native.searchParams.get("token") ?? "", callbackURL: magicLinkCallback(native.searchParams.get("callbackURL") ?? undefined) }).toString();
  return landing.toString();
}

export function docslurpMagicLinkPlugin(send: (args: { email: string; url: string }) => Promise<void>) {
  const plugin = magicLink({ expiresIn: MAGIC_LINK_SECONDS, storeToken: "hashed", disableSignUp: true,
    rateLimit: { window: 60, max: 3 },
    sendMagicLink: async ({ email, url }) => send({ email, url: magicLinkLandingUrl(url) }),
  });
  // Pinned Better Auth 1.7.14's router omits SERVER_ONLY endpoints while
  // auth.api still dispatches all hooks. Fail startup if that endpoint changes.
  const verify = plugin.endpoints.magicLinkVerify;
  if (plugin.version !== "1.7.14" || verify.path !== "/magic-link/verify" || verify.options.method !== "GET" || !verify.options.metadata) {
    throw new Error("Review Better Auth magic-link verification before upgrading");
  }
  Object.assign(verify.options.metadata, { SERVER_ONLY: true });
  return Object.assign(plugin, { hooks: { before: [{
    matcher: (ctx: { path?: string }) => ctx.path === "/sign-in/magic-link" || ctx.path === "/magic-link/verify",
    handler: createAuthMiddleware(async ctx => {
      const input = ctx.path === "/sign-in/magic-link" ? ctx.body : ctx.query;
      for (const key of ["callbackURL", "newUserCallbackURL", "errorCallbackURL"] as const) {
        if (input?.[key] !== undefined) magicLinkCallback(input[key]);
      }
      ctx.setHeader("cache-control", "no-store");
      if (input?.callbackURL === undefined) {
        return { context: { [ctx.path === "/sign-in/magic-link" ? "body" : "query"]: { ...input, callbackURL: "/app" } } };
      }
    }),
  }] } });
}

/** Independent of optional API limits; atomic shared-database budget, including unknown addresses. */
export async function consumeMagicLinkConfirmation(pool: Pick<Pool, "query">, address: string | null): Promise<boolean> {
  const key = `magic-confirm:${createHash("sha256").update(address ?? "unknown").digest("hex")}`;
  const now = Date.now();
  const { rows } = await pool.query<{ count: number }>(`insert into "rateLimit" (id,key,count,"lastRequest") values($1,$1,1,$2)
    on conflict(key) do update set
      count = case when "rateLimit"."lastRequest" <= $2 - 60000 then 1 else least("rateLimit".count + 1, 11) end,
      "lastRequest" = case when "rateLimit"."lastRequest" <= $2 - 60000 then $2 else "rateLimit"."lastRequest" end
    returning count`, [key, now]);
  return rows.length === 1 && rows[0]!.count <= 10;
}

type NativeVerify = (input: { query: { token: string; callbackURL: string; newUserCallbackURL: string; errorCallbackURL: string }; headers: Headers; asResponse: true }) => Promise<Response>;

/** A scanner cannot redeem a link: only an explicit app-origin JSON POST calls native verification. */
export async function confirmMagicLink(request: Request, verify: NativeVerify, trustedOrigin: (origin: string) => Promise<boolean>): Promise<Response> {
  const json = (body: unknown, status = 200, extra?: Headers) => {
    const headers = new Headers({ "content-type": "application/json", "cache-control": "no-store", "referrer-policy": "no-referrer" });
    for (const cookie of extra?.getSetCookie() ?? []) headers.append("set-cookie", cookie);
    return new Response(JSON.stringify(body), { status, headers });
  };
  const origin = request.headers.get("origin");
  if (!origin || !await trustedOrigin(origin)) return json({ code: "INVALID_ORIGIN", message: "Open this link in the app to continue." }, 403);
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") return json({ code: "INVALID_REQUEST", message: "The sign-in request is invalid." }, 400);
  const length = Number(request.headers.get("content-length"));
  if (Number.isFinite(length) && length > 4096) return json({ code: "INVALID_REQUEST", message: "The sign-in request is invalid." }, 400);
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  if (reader) {
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > 4096) {
          await reader.cancel();
          return json({ code: "INVALID_REQUEST", message: "The sign-in request is invalid." }, 400);
        }
        chunks.push(part.value);
      }
    } finally { reader.releaseLock(); }
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  let input: { token?: unknown; callbackURL?: unknown };
  try { input = JSON.parse(raw); } catch { return json({ code: "INVALID_REQUEST", message: "The sign-in request is invalid." }, 400); }
  if (!input || typeof input !== "object" || Array.isArray(input) || typeof input.token !== "string" || !/^[a-zA-Z]{32}$/.test(input.token)) {
    return json({ code: "MAGIC_LINK_INVALID_OR_EXPIRED", message: "This sign-in link is invalid or has expired. Request a new link." }, 400);
  }
  let callback: string;
  try { callback = magicLinkCallback(input.callbackURL); } catch { return json({ code: "INVALID_CALLBACK_URL", message: "Choose an app page to continue." }, 400); }
  const response = await verify({ headers: request.headers, asResponse: true,
    query: { token: input.token, callbackURL: callback, newUserCallbackURL: callback, errorCallbackURL: "/app/sign-in" } });
  const location = response.headers.get("location");
  if (location) {
    const target = new URL(location, request.url);
    if (target.searchParams.has("error")) return json({ code: "MAGIC_LINK_INVALID_OR_EXPIRED", message: "This sign-in link is invalid or has expired. Request a new link." }, 400, response.headers);
    // Native MFA may redirect to /app/sign-in; destinations stay app-owned.
    let redirectTo: string;
    try { redirectTo = magicLinkCallback(`${target.pathname}${target.search}${target.hash}`); }
    catch { return json({ code: "SIGN_IN_UNAVAILABLE", message: "Sign-in could not finish. Request a new link." }, 400, response.headers); }
    return json({ redirectTo }, 200, response.headers);
  }
  const refusal = await response.json().catch(() => null) as { code?: unknown } | null;
  if (refusal?.code === "SSO_REQUIRED") return json({ code: "SSO_REQUIRED", message: "Your organization requires company sign-in (SSO)." }, 403, response.headers);
  return json({ code: "SIGN_IN_UNAVAILABLE", message: "Sign-in could not finish. Request a new link." }, response.status >= 400 ? response.status : 400, response.headers);
}
