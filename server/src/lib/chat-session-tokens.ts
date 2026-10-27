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
 * expiry; continuing a session requires it. Tampered, expired, other-key,
 * other-workspace and other-session tokens are refused. Server keys and app
 * sessions are unchanged: the session id is checked against their own user.
 */
const family = sealedTokenFamily("chat-session-grant:v1");
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
 * The continuation check for one request: a browser key that names a
 * sessionId must hold a matching grant. Throws ChatSessionForbiddenError.
 */
export function assertChatSessionGrant(actor: RequestActor | null | undefined, args: { workspaceId: string; sessionId?: string | null; sessionToken?: string | null }): void {
  if (!requiresChatSessionToken(actor) || !args.sessionId) return;
  const refusal = chatSessionTokenRefusal(args.sessionToken, { keyId: actor.apiKey.keyId, workspaceId: args.workspaceId, sessionId: args.sessionId });
  if (refusal) throw new ChatSessionForbiddenError(refusal);
}
