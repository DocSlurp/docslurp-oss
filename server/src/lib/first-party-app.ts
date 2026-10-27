import type { RequestActor, SessionRequestActor } from "./request-actor.js";

/**
 * The first-party DocSlurp app: a Better Auth cookie session resolved by
 * `sessionAuth` (which also enforces the CSRF origin check on mutations).
 * Settings tools and modes (proposeWorkspaceSettings, suggestions mode,
 * thread settings changed from chat messages, Apply) are only for this actor.
 * API keys of any type (server, client/publishable), MCP OAuth tokens and
 * capability tokens are never first-party, whatever the request claims, so a
 * customer cannot expose settings tools to its own end users. The signal comes
 * only from authentication, never from a request field.
 */
export function isFirstPartyAppActor(actor: RequestActor | null | undefined): actor is SessionRequestActor {
  return actor?.type === "session" && typeof actor.sessionId === "string" && actor.sessionId.length > 0;
}
