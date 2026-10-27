import { HTTPException } from "hono/http-exception";

import { apiError } from "@docslurp/shared";

import { sealedTokenFamily } from "./capability-tokens.js";
import type { RequestActor } from "./request-actor.js";

/**
 * Chat session grants for browser (client) API keys.
 *
 * Every visitor of a publishable key shares the key owner's identity, so a
 * chat `sessionId` alone would let anyone who learns it read or continue that
 * conversation. For these keys the server returns a sealed `sessionToken` with
 * each answer, bound to the key, the workspace and the session, with an
 * expiry; continuing a session requires it (see chatSessionForRequest). Server keys and app
 * sessions are unchanged: the session id is checked against their own user.
 */
const family = sealedTokenFamily("chat-session-grant:v1");
/** Request header for the grant on GET /v1/search/chat/stream, so it never sits in a URL. */
export const CHAT_SESSION_TOKEN_HEADER = "X-DocSlurp-Chat-Session-Token";
export const CHAT_SESSION_TOKEN_TTL_SECONDS = 24 * 60 * 60;

export function requiresChatSessionToken(actor: RequestActor | null | undefined): actor is Extract<RequestActor, { type: "apiKey" }> {
  return actor?.type === "apiKey" && actor.apiKey.keyType !== "server";
}

export function sealChatSessionToken(args: { keyId: string; workspaceId: string; sessionId: string; nowMs?: number }): string {
  const exp = Math.floor((args.nowMs ?? Date.now()) / 1000) + CHAT_SESSION_TOKEN_TTL_SECONDS;
  return family.seal({ v: 1, keyId: args.keyId, workspaceId: args.workspaceId, sessionId: args.sessionId, exp });
}

export type ChatSessionTokenRefusal = "missing" | "invalid" | "expired" | "scope";

/** Why a token does not grant this key, workspace and session; null when it does. */
export function chatSessionTokenRefusal(token: string | null | undefined, expected: { keyId: string; workspaceId: string; sessionId: string }, nowMs = Date.now()): ChatSessionTokenRefusal | null {
  if (!token) return "missing";
  const claims = family.open(token);
  if (!claims || claims.v !== 1 || typeof claims.exp !== "number") return "invalid";
  if (claims.exp * 1000 <= nowMs) return "expired";
  if (claims.keyId !== expected.keyId || claims.workspaceId !== expected.workspaceId || claims.sessionId !== expected.sessionId) return "scope";
  return null;
}

/** 403 `chat_session_forbidden`; Hono renders it, before any history is read. */
export class ChatSessionForbiddenError extends HTTPException {
  readonly code = "chat_session_forbidden";
  constructor(readonly reason: ChatSessionTokenRefusal) {
    super(403, {
      message: "This conversation can't be continued with this request",
      res: Response.json(apiError("chat_session_forbidden", "This conversation can't be continued with this request", { category: reason }), { status: 403 }),
    });
  }
}

/**
 * The session a browser-key request may continue. A `sessionId` with a valid
 * grant continues it. A `sessionId` with no grant (widgets deployed before
 * grants existed) or an expired one starts a fresh session instead: its
 * history is never read, and the answer carries a new grant. A tampered grant,
 * or one for another key, workspace or session, is refused (403
 * `chat_session_forbidden`). Server keys and app sessions keep the session id
 * as sent; it is checked against their own user.
 */
export function chatSessionForRequest(actor: RequestActor | null | undefined, args: { workspaceId: string; sessionId?: string | null; sessionToken?: string | null }): string | undefined {
  const sessionId = args.sessionId ?? undefined;
  if (!requiresChatSessionToken(actor) || !sessionId) return sessionId;
  const refusal = chatSessionTokenRefusal(args.sessionToken, { keyId: actor.apiKey.keyId, workspaceId: args.workspaceId, sessionId });
  if (refusal === null) return sessionId;
  if (refusal === "missing" || refusal === "expired") return undefined;
  throw new ChatSessionForbiddenError(refusal);
}
