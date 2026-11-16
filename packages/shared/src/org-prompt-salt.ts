import { createHmac, hkdfSync, randomBytes } from "node:crypto";

/**
 * Per-organization salt line for hosted model prompts that carry tenant text.
 *
 * Every organization shares DocSlurp's provider accounts, and providers cache
 * repeated prompt prefixes automatically. A prompt whose prefix is tenant text
 * (a document, chunks, a query, project instructions) would let one
 * organization detect, by latency or a cache discount, that another recently
 * sent the same text. Starting every such prompt with a line keyed by the
 * organization (HMAC under a server secret, so it cannot be computed from an
 * org id) keeps provider cache reuse inside one organization.
 *
 * Without an organization the line is random, so nothing is shared. The key is
 * `EVIDENCE_TAG_KEY`, else derived from `BETTER_AUTH_SECRET`, else random per
 * process (safe; it only lowers cache reuse across processes).
 */
let key: Buffer | null = null;

function saltKey(): Buffer {
  if (key) return key;
  const explicit = process.env.EVIDENCE_TAG_KEY?.trim();
  const secret = (explicit && explicit.length >= 32 ? explicit : undefined) || process.env.BETTER_AUTH_SECRET?.trim();
  key = secret ? Buffer.from(hkdfSync("sha256", secret, "", "docslurp-org-prompt-salt-v1", 32)) : randomBytes(32);
  return key;
}

/** Test seam: forget the derived key after changing the environment. */
export function resetOrgPromptSaltKeyForTests(): void {
  key = null;
}

/** The org's salt line (stable per org and key), or a random line when there is no organization. */
export function orgPromptSaltLine(orgId: string | null | undefined): string {
  const org = typeof orgId === "string" ? orgId.trim() : "";
  const salt = org
    ? createHmac("sha256", saltKey()).update("org-prompt").update("\0").update(org).digest("hex").slice(0, 16)
    : randomBytes(8).toString("hex");
  return `Workspace ${salt}.`;
}

/** `system` with the org salt line first. */
export function withOrgPromptSalt(orgId: string | null | undefined, system: string | undefined): string {
  return [orgPromptSaltLine(orgId), system].filter(Boolean).join("\n\n");
}
