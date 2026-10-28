import { createHash } from "node:crypto";

/**
 * Gravatar for the platform-admin user directory. Avatar images need no key
 * and are loaded by the admin's browser; the profile lookup is server-side,
 * fixed to api.gravatar.com and keyed only by a hex hash, and runs only when
 * GRAVATAR_API_KEY is set (1,000 profile requests per hour per key).
 * Responses are reduced to a small allowlist of display fields.
 */

const PROFILE_API = "https://api.gravatar.com/v3/profiles/";
const OAUTH_AVATAR_HOSTS = [/^avatars\.githubusercontent\.com$/, /^[a-z0-9-]+\.googleusercontent\.com$/];
const CACHE_TTL_MS = 60 * 60 * 1000;
const CACHE_MAX = 1_000;

export function gravatarHash(email: string): string {
  return createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
}

/** The provider avatar when it is a GitHub/Google image (both allowed by the app CSP), else Gravatar (404 → initials). */
export function avatarUrl(email: string, image: string | null | undefined, size = 64): string {
  if (image) {
    try {
      const url = new URL(image);
      if (url.protocol === "https:" && OAUTH_AVATAR_HOSTS.some(host => host.test(url.hostname))) return url.toString();
    } catch { /* fall through */ }
  }
  return `https://gravatar.com/avatar/${gravatarHash(email)}?s=${size}&d=404`;
}

export interface GravatarProfile {
  displayName: string | null;
  location: string | null;
  jobTitle: string | null;
  company: string | null;
  description: string | null;
  pronouns: string | null;
  profileUrl: string | null;
  verifiedAccounts: { service: string; url: string }[];
}

export type GravatarLookup =
  | { status: "not_configured" }
  | { status: "not_found" }
  | { status: "found"; profile: GravatarProfile };

function str(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim();
  return cleaned ? cleaned.slice(0, max) : null;
}

function httpsUrl(value: unknown): string | null {
  const raw = str(value, 512);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" ? url.toString() : null;
  } catch { return null; }
}

export function sanitizeGravatarProfile(data: unknown): GravatarProfile {
  const record = data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : {};
  const accounts = Array.isArray(record.verified_accounts) ? record.verified_accounts : [];
  return {
    displayName: str(record.display_name, 120),
    location: str(record.location, 120),
    jobTitle: str(record.job_title, 120),
    company: str(record.company, 120),
    description: str(record.description, 500),
    pronouns: str(record.pronouns, 40),
    profileUrl: httpsUrl(record.profile_url),
    verifiedAccounts: accounts.slice(0, 10).flatMap((account) => {
      const entry = account && typeof account === "object" ? account as Record<string, unknown> : {};
      const service = str(entry.service_label, 60) ?? str(entry.service_type, 60);
      const url = httpsUrl(entry.url);
      return service && url ? [{ service, url }] : [];
    }),
  };
}

export class GravatarClient {
  private cache = new Map<string, { at: number; value: GravatarLookup }>();
  constructor(
    private readonly apiKey: () => string | undefined = () => process.env.GRAVATAR_API_KEY?.trim() || undefined,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async lookup(email: string): Promise<GravatarLookup> {
    const key = this.apiKey();
    if (!key) return { status: "not_configured" };
    const hash = gravatarHash(email);
    const cached = this.cache.get(hash);
    if (cached && this.now() - cached.at < CACHE_TTL_MS) return cached.value;
    const response = await this.fetchImpl(`${PROFILE_API}${hash}`, {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    });
    let value: GravatarLookup;
    if (response.status === 404) value = { status: "not_found" };
    else if (response.ok) value = { status: "found", profile: sanitizeGravatarProfile(await response.json()) };
    else throw new Error(`Gravatar profile lookup failed with HTTP ${response.status}`);
    if (this.cache.size >= CACHE_MAX) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(hash, { at: this.now(), value });
    return value;
  }
}

export const gravatarClient = new GravatarClient();
