import { env } from "../config.js";
import { FILE_TOKEN_TTL_SECONDS, FILE_TOKEN_WINDOW_SECONDS, sealFileToken, type FileTokenBinding } from "./file-tokens.js";
import { FILE_PROXY_PREFIX } from "./file-token-path.js";
import { currentRequestApiKeyId, currentRequestSessionId, currentRequestUserId } from "./request-context.js";

export { FILE_PROXY_PREFIX };

export interface FileUrl {
  url: string;
  expiresAt: string;
}

/** Filename for Content-Disposition and the URL suffix: a plain basename, no path or control characters. */
export function safeFileName(name: string | null | undefined, uri: string): string {
  const base = (name?.trim() || uri.split("/").pop() || "file").split(/[\\/]/).pop() ?? "file";
  const cleaned = base.replace(/[^A-Za-z0-9._ -]+/g, "-").replace(/^[.\s-]+/, "").slice(0, 120).trim();
  return cleaned || "file";
}

/**
 * A proxy URL for one artifact, issued to the authenticated caller of the
 * current request and bound to its session or API key. Storage is never
 * exposed. Browser sessions get a same-origin path, so the cookie that the
 * token is bound to travels with it. API keys get an absolute URL, fetched
 * with the same bearer key.
 *
 * Callers must have authorized the artifact already; the proxy checks again.
 */
export function fileUrlForArtifact(uri: string, filename?: string | null, nowMs = Date.now()): FileUrl {
  const userId = currentRequestUserId();
  const sessionId = currentRequestSessionId();
  const apiKeyId = currentRequestApiKeyId();
  const bind: FileTokenBinding | null = apiKeyId ? `k:${apiKeyId}` : sessionId ? `s:${sessionId}` : null;
  if (!userId || !bind) {
    // Never mint an unbound capability (background job, missing actor).
    throw new Error("File URLs can only be issued inside an authenticated request");
  }

  const exp = Math.ceil((Math.floor(nowMs / 1000) + FILE_TOKEN_TTL_SECONDS) / FILE_TOKEN_WINDOW_SECONDS) * FILE_TOKEN_WINDOW_SECONDS;
  const name = safeFileName(filename, uri);
  const token = sealFileToken({ uri, sub: userId, bind, exp, name });
  const path = `${FILE_PROXY_PREFIX}/${token}/${encodeURIComponent(name)}`;
  return {
    url: apiKeyId ? `${env.apiUrl.replace(/\/$/, "")}${path}` : path,
    expiresAt: new Date(exp * 1000).toISOString()
  };
}

