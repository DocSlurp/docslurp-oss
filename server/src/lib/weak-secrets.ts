/** Development and example values that production refuses for any secret (config.ts, estimate-signing-key.ts). */
export const WEAK_SECRET_VALUES: ReadonlySet<string> = new Set([
  "docslurp",
  "minioadmin",
  "metrics-secret",
  "dev-secret-change-me",
  "dev-oauth-key-change-me",
  "testtest",
  "password",
  "changeme",
]);
