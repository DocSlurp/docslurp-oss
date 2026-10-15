import { createHmac } from "node:crypto";
import { serialize, type CookieOptions } from "hono/utils/cookie";

/** Where a signed-in browser lands. Mirrors the app's `APP_ROOT_PATH`. */
export const AUTH_APP_ROOT_PATH = "/app";

interface PasswordAccountRecord {
  providerId: string;
  password?: string | null;
}

interface AuthSessionCookieAttributes {
  domain?: string;
  expires?: Date;
  httpOnly: boolean;
  maxAge?: number;
  path: string;
  secure: boolean;
  sameSite: "Strict" | "Lax" | "None" | "strict" | "lax" | "none";
  partitioned?: boolean;
}

/** The slice of Better Auth's context the seed sign-in route relies on. */
export interface AuthFallbackContextShape {
  secret: string;
  sessionConfig: { expiresIn: number };
  authCookies: {
    sessionToken: {
      name: string;
      attributes: AuthSessionCookieAttributes;
    };
  };
  password: {
    verify: (args: { hash: string; password: string }) => Promise<boolean>;
  };
  internalAdapter: {
    findUserByEmail: (
      email: string,
      options: { includeAccounts: boolean }
    ) => Promise<{
      user: { id: string };
      accounts: PasswordAccountRecord[];
    } | null>;
    createSession: (userId: string) => Promise<{ token: string } | null>;
  };
}

export function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

export function normalizeRedirectTarget(value: FormDataEntryValue | string | null | undefined): string {
  if (typeof value !== "string") return AUTH_APP_ROOT_PATH;
  const trimmed = value.trim();
  if (!trimmed.startsWith("/") || trimmed.startsWith("//")) return AUTH_APP_ROOT_PATH;
  return trimmed;
}

export function buildAuthFailureUrl(requestUrl: string, error: string, email?: string): URL {
  const url = new URL(AUTH_APP_ROOT_PATH, requestUrl);
  url.searchParams.set("authError", error);
  if (email?.trim()) url.searchParams.set("authEmail", email.trim());
  return url;
}

function normalizeSameSite(value: AuthSessionCookieAttributes["sameSite"]): CookieOptions["sameSite"] {
  const lower = value.toLowerCase();
  return lower === "strict" ? "Strict" : lower === "none" ? "None" : "Lax";
}

/**
 * The `Set-Cookie` value for a session cookie signed the way Better Auth signs
 * it (`token.base64(hmac-sha256(secret, token))`, URI-encoded), carrying the
 * attributes Better Auth configured for its own session cookie.
 */
export function signedSessionCookie(authContext: AuthFallbackContextShape, sessionToken: string): string {
  const signature = createHmac("sha256", authContext.secret).update(sessionToken).digest("base64");
  const { name, attributes } = authContext.authCookies.sessionToken;
  return serialize(name, `${sessionToken}.${signature}`, {
    domain: attributes.domain,
    expires: attributes.expires,
    httpOnly: attributes.httpOnly,
    path: attributes.path,
    secure: attributes.secure,
    partitioned: attributes.partitioned,
    sameSite: normalizeSameSite(attributes.sameSite),
    maxAge: authContext.sessionConfig.expiresIn
  } as CookieOptions);
}

/**
 * Form posts must come from this origin. This is the same rule the app applies
 * to browser forms, repeated here so standalone `dev:api` is not weaker.
 */
export function isForbiddenFormRequest(request: Request): boolean {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return false;
  if (request.headers.get("origin") === new URL(request.url).origin) return false;
  const contentType = request.headers.get("content-type");
  return !contentType || ["application/x-www-form-urlencoded", "multipart/form-data", "text/plain"]
    .some((type) => contentType.toLowerCase().includes(type));
}
