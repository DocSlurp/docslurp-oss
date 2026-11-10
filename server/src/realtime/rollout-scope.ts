/** Server-owned rollout scope. Missing configuration permits the normal global
 * flags; a present but malformed value must never become a full rollout. */
export function realtimeCanaryOrgIds(): string[] | null {
  const raw = process.env.REALTIME_CANARY_ORG_IDS;
  if (raw === undefined) return null;
  const ids = raw.split(",").map(id => id.trim().toLowerCase());
  if (raw.length > 2048 || ids.length < 1 || ids.length > 16 || ids.some(id =>
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id))) {
    throw new Error("realtime_invalid_canary_scope");
  }
  return [...new Set(ids)];
}

export function realtimeCanaryOrgAllowed(orgId: string | null | undefined): boolean {
  const ids = realtimeCanaryOrgIds();
  return ids === null || !!orgId && ids.includes(orgId.toLowerCase());
}
