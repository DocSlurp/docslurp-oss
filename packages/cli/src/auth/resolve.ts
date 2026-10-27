import { credentialAccount, loadCredential, saveCredential, validateProfile, withCredentialLock, type StoredCredential } from "./credentials.js";
import { discover, refreshTokens, type AuthorizationServer } from "./oauth.js";

/**
 * Which credential a command uses, in precedence order:
 *
 * 1. `--api-key <key>`
 * 2. `DOCSLURP_API_KEY`
 * 3. `DOCSLURP_TOKEN`: a short-lived OAuth access token from the environment
 *    (CI, agents, `docslurp exec`). Never refreshed; it simply expires.
 * 4. The stored `docslurp login` for this profile and API URL, refreshed
 *    transparently shortly before it expires.
 */
export type CredentialSource = "flag --api-key" | "env DOCSLURP_API_KEY" | "env DOCSLURP_TOKEN" | "stored login";

export type ResolvedAuth = {
  source: CredentialSource;
  kind: "apiKey" | "oauth";
  apiUrl: string;
  profile: string;
  /** Where a stored login lives (keychain or file); null for flag and env credentials. */
  store: string | null;
  /** A bearer token valid for at least `minValiditySeconds` where that can be known; `forceRefresh` after a 401. */
  token(options?: { minValiditySeconds?: number; forceRefresh?: boolean }): Promise<string>;
  /** The stored login's current record (never printed with its tokens). */
  stored(): StoredCredential | null;
};

export class NotSignedInError extends Error {}
export class LoginExpiredError extends Error {}

export function resolveProfile(flags: Record<string, string | boolean>): string {
  const value = typeof flags.profile === "string" && flags.profile.trim() ? flags.profile.trim() : process.env.DOCSLURP_PROFILE?.trim() || "default";
  return validateProfile(value);
}

const RELOGIN = (profile: string) => `Run \`docslurp login${profile === "default" ? "" : ` --profile ${profile}`}\` to sign in again.`;

export async function resolveAuth(flags: Record<string, string | boolean>, apiUrl: string, options: { allowEmpty?: boolean } = {}): Promise<ResolvedAuth | null> {
  const profile = resolveProfile(flags);
  const fixed = (source: CredentialSource, kind: ResolvedAuth["kind"], value: string): ResolvedAuth => ({
    source, kind, apiUrl, profile, store: null, stored: () => null, token: async () => value,
  });
  if (typeof flags.apiKey === "string" && flags.apiKey) return fixed("flag --api-key", "apiKey", flags.apiKey);
  const envKey = process.env.DOCSLURP_API_KEY?.trim();
  if (envKey) return fixed("env DOCSLURP_API_KEY", "apiKey", envKey);
  const envToken = process.env.DOCSLURP_TOKEN?.trim();
  if (envToken) return fixed("env DOCSLURP_TOKEN", "oauth", envToken);

  const account = credentialAccount(profile, apiUrl);
  const loaded = await loadCredential(account);
  if (!loaded) {
    if (options.allowEmpty) return null;
    throw new NotSignedInError(`Not signed in to ${new URL(apiUrl).origin}${profile === "default" ? "" : ` (profile ${profile})`}. Run \`docslurp login\`, or set DOCSLURP_API_KEY.`);
  }
  let current = loaded.credential;
  let store = loaded.source;
  let server: AuthorizationServer | null = null;
  let inFlight: Promise<string> | null = null;

  const validFor = (credential: StoredCredential) => (Date.parse(credential.accessTokenExpiresAt) - Date.now()) / 1000;

  async function refresh(minValiditySeconds: number, force: boolean): Promise<string> {
    // Held across re-read, refresh and save: two CLI processes on this machine
    // never spend the same refresh token, and neither drops the other's login.
    return await withCredentialLock(async () => {
      // Another process may have rotated the tokens already: prefer its result.
      const latest = (await loadCredential(account))?.credential;
      if (latest && latest.refreshToken !== current.refreshToken) {
        current = latest;
        if (!force && validFor(current) > minValiditySeconds) return current.accessToken;
      }
      server ??= await discover(apiUrl);
      const result = await refreshTokens(server, current.refreshToken);
      if (!result.ok && result.error === "invalid_grant" && /just rotated/i.test(result.description)) {
        // A refresh elsewhere (another machine sharing this store, or a keychain
        // without our lock) won the race; poll for its tokens for up to ~10 s.
        for (let waited = 0; waited < 10_000; waited += 500) {
          await new Promise((resolve) => setTimeout(resolve, 500));
          const rotated = (await loadCredential(account))?.credential;
          if (rotated && rotated.refreshToken !== current.refreshToken) {
            current = rotated;
            return current.accessToken;
          }
        }
      }
      if (!result.ok) {
        if (result.error === "network_error") throw new LoginExpiredError(`Could not refresh the DocSlurp login: ${result.description}`);
        throw new LoginExpiredError(`Your DocSlurp login has expired or was revoked. ${RELOGIN(profile)}`);
      }
      current = {
        ...current,
        accessToken: result.tokens.accessToken,
        refreshToken: result.tokens.refreshToken,
        accessTokenExpiresAt: result.tokens.expiresAt,
        scopes: result.tokens.scopes.length ? result.tokens.scopes : current.scopes,
        updatedAt: new Date().toISOString(),
      };
      // The old refresh token is now spent: persist the new one before using the access token.
      try {
        store = await saveCredential(account, current, (message) => process.stderr.write(`${message}\n`));
      } catch (error) {
        // This process can keep using the new access token, but the stored
        // refresh token is spent; presenting it later revokes the login.
        process.stderr.write(`Warning: the DocSlurp login was refreshed but could not be saved (${error instanceof Error ? error.message : "unknown error"}). The stored login is now unusable; ${RELOGIN(profile).replace(/^Run/, "run")}\n`);
      }
      return current.accessToken;
    });
  }

  return {
    source: "stored login",
    kind: "oauth",
    apiUrl,
    profile,
    get store() { return store; },
    stored: () => current,
    async token(tokenOptions = {}) {
      const minValidity = tokenOptions.minValiditySeconds ?? 60;
      if (!tokenOptions.forceRefresh && validFor(current) > minValidity) return current.accessToken;
      inFlight ??= refresh(minValidity, tokenOptions.forceRefresh === true).finally(() => { inFlight = null; });
      return await inFlight;
    },
  };
}
