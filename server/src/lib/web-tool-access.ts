/**
 * Web tools (webSearch, webFetch, webMap, webCrawl, ingestWebsite) make paid
 * calls to the open web on the key owner's credits. A public client key sits in
 * page source and its Origin check is advisory, so it must never become a free
 * web proxy: client keys reach web tools only with the explicit `web` scope
 * (opt-in, workspace-bound). Server keys keep them with `search`, and
 * `ingestWebsite` always needs `ingest` as well.
 */
export function apiKeyCanUseWebTools(key: { scopes: readonly string[]; keyType?: string; oauth?: { audience: string } }, ingest = false): boolean {
  if (!key.scopes.includes(ingest ? "ingest" : "search")) return false;
  // A CLI (REST-audience) OAuth token is a delegated credential: paid web
  // calls need their own `web` scope, granted explicitly at login.
  if (key.oauth?.audience === "api") return key.scopes.includes("web");
  return key.keyType !== "client" || key.scopes.includes("web");
}
