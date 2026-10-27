import { spawn } from "node:child_process";
import { constants } from "node:os";

import { credentialAccount, deleteCredential, loadCredential, saveCredential, type StoredCredential } from "./credentials.js";
import { CLI_CLIENT_ID, deviceLogin, discover, loopbackLogin, parseScopes, revokeToken, type TokenSet } from "./oauth.js";
import { resolveAuth, resolveProfile, type ResolvedAuth } from "./resolve.js";
import { windowsSpawn } from "./windows-exec.js";

type Flags = Record<string, string | boolean>;
const err = (line: string) => process.stderr.write(`${line}\n`);

type WhoAmI = {
  user?: { id: string; email: string | null; name: string | null };
  organization?: { id: string; name: string; slug?: string } | null;
  defaultWorkspace?: { id: string; name: string; slug: string | null } | null;
  credential?: { type: string; client?: string; scopes?: string[]; apiKeyScopes?: string[]; expiresAt?: string | null };
};

async function fetchWhoAmI(apiUrl: string, token: string): Promise<{ status: number; body: WhoAmI | null }> {
  try {
    const response = await fetch(`${apiUrl}/v1/whoami`, { headers: { authorization: `Bearer ${token}`, accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
    return { status: response.status, body: response.ok ? await response.json() as WhoAmI : null };
  } catch {
    return { status: 0, body: null };
  }
}

function relative(iso: string | null | undefined): string {
  if (!iso) return "never (API key)";
  const seconds = Math.round((Date.parse(iso) - Date.now()) / 1000);
  if (!Number.isFinite(seconds)) return iso;
  if (seconds <= 0) return `${iso} (expired)`;
  return `${iso} (in ${seconds >= 120 ? `${Math.round(seconds / 60)} min` : `${seconds} s`})`;
}

export async function loginCommand(flags: Flags, apiUrl: string): Promise<void> {
  const profile = resolveProfile(flags);
  const scopes = parseScopes(flags.scopes);
  const account = credentialAccount(profile, apiUrl);
  if (process.env.DOCSLURP_API_KEY?.trim()) err("Note: DOCSLURP_API_KEY is set and takes precedence over this login until you unset it.");
  else if (process.env.DOCSLURP_TOKEN?.trim()) err("Note: DOCSLURP_TOKEN is set and takes precedence over this login until you unset it.");
  const server = await discover(apiUrl);
  const tokens: TokenSet = flags.device === true
    ? await deviceLogin(server, scopes, { print: err })
    : await loopbackLogin(server, scopes, { openBrowser: flags.noBrowser !== true, print: err });
  const me = await fetchWhoAmI(apiUrl, tokens.accessToken);
  const credential: StoredCredential = {
    version: 1, apiUrl, profile, clientId: CLI_CLIENT_ID,
    accessToken: tokens.accessToken, accessTokenExpiresAt: tokens.expiresAt, refreshToken: tokens.refreshToken,
    scopes: tokens.scopes.length ? tokens.scopes : scopes,
    user: me.body?.user, organization: me.body?.organization ? { id: me.body.organization.id, name: me.body.organization.name } : null,
    updatedAt: new Date().toISOString(),
  };
  const store = await saveCredential(account, credential, err);
  // The approver can grant less than asked (device logins grant search and read unless more is ticked).
  const withheld = scopes.filter((scope) => !credential.scopes.includes(scope));
  if (withheld.length) err(`Note: you asked for ${scopes.join(" ")}, but the approval granted only ${credential.scopes.join(" ")}. Not granted: ${withheld.join(" ")}. Run \`docslurp login${flags.device === true ? " --device" : ""} --scopes "${scopes.join(" ")}"\` and tick them to add them.`);
  const who = me.body?.user?.email ?? me.body?.user?.name ?? "your account";
  console.log(`Signed in to ${new URL(apiUrl).origin} as ${who}.`);
  if (me.body?.organization) console.log(`Organization: ${me.body.organization.name} (${me.body.organization.id})`);
  if (me.body?.defaultWorkspace) console.log(`Default workspace: ${me.body.defaultWorkspace.name} (${me.body.defaultWorkspace.slug ?? me.body.defaultWorkspace.id})`);
  console.log(`Scopes: ${credential.scopes.join(" ")}`);
  console.log(`Stored in ${store}${profile === "default" ? "" : ` (profile ${profile})`}.`);
}

export async function logoutCommand(flags: Flags, apiUrl: string): Promise<void> {
  const profile = resolveProfile(flags);
  const account = credentialAccount(profile, apiUrl);
  const loaded = await loadCredential(account);
  if (!loaded) {
    console.log(`Not signed in to ${new URL(apiUrl).origin}${profile === "default" ? "" : ` (profile ${profile})`}.`);
    return;
  }
  try {
    await revokeToken(await discover(apiUrl), loaded.credential.refreshToken);
  } catch (error) {
    if (flags.force !== true) {
      throw new Error(`${error instanceof Error ? error.message : "Revocation failed."} The login was kept so you can retry; pass --force to delete it locally anyway (it stays valid on the server until it expires or you revoke it in DocSlurp).`);
    }
    err("Warning: the server did not confirm revocation; deleting the local login anyway (--force).");
  }
  await deleteCredential(account);
  console.log(`Signed out of ${new URL(apiUrl).origin}${profile === "default" ? "" : ` (profile ${profile})`}.`);
  if (process.env.DOCSLURP_TOKEN?.trim()) err("Note: DOCSLURP_TOKEN is still set in this shell; it stays valid until it expires (at most 15 minutes).");
}

/** `whoami` (concise) and `auth status` (adds local credential details). */
export async function whoamiCommand(flags: Flags, apiUrl: string, detailed: boolean): Promise<void> {
  const auth = await resolveAuth(flags, apiUrl, { allowEmpty: detailed });
  if (!auth) {
    console.log(`Not signed in to ${new URL(apiUrl).origin} (profile ${resolveProfile(flags)}).`);
    process.exitCode = 1;
    return;
  }
  const me = await fetchWhoAmI(apiUrl, await auth.token());
  const stored = auth.stored();
  const summary = {
    apiUrl: new URL(apiUrl).origin,
    profile: auth.profile,
    credentialSource: auth.source,
    store: auth.store,
    status: me.body ? "valid" : me.status === 401 || me.status === 403 ? "rejected" : "unreachable",
    user: me.body?.user ?? stored?.user ?? null,
    organization: me.body?.organization ?? stored?.organization ?? null,
    defaultWorkspace: me.body?.defaultWorkspace ?? null,
    scopes: me.body?.credential?.scopes ?? stored?.scopes ?? [],
    accessTokenExpiresAt: me.body?.credential?.expiresAt ?? stored?.accessTokenExpiresAt ?? null,
    ...(detailed ? { apiKeyScopes: me.body?.credential?.apiKeyScopes ?? null, shadowedStoredLogin: auth.source !== "stored login" && Boolean(await loadCredential(credentialAccount(auth.profile, apiUrl)).catch(() => null)) } : {}),
  };
  if (flags.json === true) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    const user = summary.user;
    console.log(user ? `Signed in as ${user.email ?? user.name ?? user.id}` : "Signed in");
    if (summary.organization) console.log(`Organization: ${summary.organization.name} (${summary.organization.id})`);
    if (summary.defaultWorkspace) console.log(`Default workspace: ${summary.defaultWorkspace.name} (${summary.defaultWorkspace.slug ?? summary.defaultWorkspace.id})`);
    console.log(`Scopes: ${summary.scopes.join(" ") || "-"}`);
    console.log(`Token expires: ${relative(summary.accessTokenExpiresAt)}`);
    console.log(`Credential: ${summary.credentialSource}${summary.store ? ` (${summary.store})` : ""}`);
    if (detailed) {
      console.log(`API: ${summary.apiUrl}  Profile: ${summary.profile}`);
      if (summary.apiKeyScopes) console.log(`Effective API scopes: ${summary.apiKeyScopes.join(" ")}`);
      if (summary.shadowedStoredLogin) console.log(`A stored login exists for this profile but ${summary.credentialSource} takes precedence.`);
    }
  }
  if (!me.body) {
    err(me.status === 0 ? `Could not reach ${summary.apiUrl}.` : "The server rejected this credential. Run `docslurp login` again or check your API key.");
    process.exitCode = 1;
  }
}

async function requireOAuth(flags: Flags, apiUrl: string, command: string): Promise<ResolvedAuth> {
  const auth = await resolveAuth(flags, apiUrl);
  if (!auth || auth.kind !== "oauth") {
    throw new Error(`${command} forwards short-lived OAuth tokens, but the active credential is a long-lived API key (${auth?.source}). Unset DOCSLURP_API_KEY / drop --api-key and run \`docslurp login\`.`);
  }
  return auth;
}

/** Prints only the access token on stdout, for `export DOCSLURP_TOKEN=$(docslurp auth token)`. */
export async function authTokenCommand(flags: Flags, apiUrl: string): Promise<void> {
  const auth = await requireOAuth(flags, apiUrl, "docslurp auth token");
  if (auth.source === "env DOCSLURP_TOKEN") {
    err("Note: printing DOCSLURP_TOKEN from the environment unchanged; it was not freshly issued and is not refreshed. Unset it to print a token from your stored login.");
  }
  process.stdout.write(`${await auth.token({ minValiditySeconds: 300 })}\n`);
}

/**
 * Runs `<cmd...>` with a fresh short-lived DOCSLURP_TOKEN, DOCSLURP_URL and
 * (when chosen) DOCSLURP_WORKSPACE in its environment only: never on disk,
 * never in argv. The child's exit status becomes ours.
 */
export async function execCommand(flags: Flags, apiUrl: string, workspace: string | null, argv: string[]): Promise<void> {
  if (!argv.length) throw new Error("Usage: docslurp exec [--profile <name>] -- <command> [args...]");
  const auth = await requireOAuth(flags, apiUrl, "docslurp exec");
  const env: NodeJS.ProcessEnv = { ...process.env, DOCSLURP_TOKEN: await auth.token({ minValiditySeconds: 300 }), DOCSLURP_URL: apiUrl };
  if (workspace) env.DOCSLURP_WORKSPACE = workspace;
  delete env.DOCSLURP_API_KEY;
  const [command, ...args] = argv as [string, ...string[]];
  // Windows: resolve PATHEXT ourselves; only .cmd/.bat go through cmd.exe, with every argument escaped.
  const target = process.platform === "win32" ? windowsSpawn(command, args, env) : { file: command, args, verbatim: false };
  const child = spawn(target.file, target.args, { stdio: "inherit", env, shell: false, windowsVerbatimArguments: target.verbatim });
  // Ctrl-C reaches the child directly from the terminal (same process group):
  // ignore it here so we stay alive to report the child's status. Forward the
  // signals a terminal does not deliver to the child itself.
  const forward = (signal: NodeJS.Signals) => () => { child.kill(signal); };
  const handlers = [["SIGINT", () => {}], ...(["SIGTERM", "SIGHUP"] as const).map((signal) => [signal, forward(signal)] as const)] as Array<readonly [NodeJS.Signals, () => void]>;
  for (const [signal, handler] of handlers) process.on(signal, handler);
  const status = await new Promise<number>((resolve, reject) => {
    child.once("error", (error) => reject(new Error(`Could not run ${command}: ${(error as NodeJS.ErrnoException).code ?? error.message}`)));
    child.once("close", (code, signal) => resolve(code ?? (signal ? 128 + (constants.signals[signal] ?? 1) : 1)));
  }).finally(() => { for (const [signal, handler] of handlers) process.off(signal, handler); });
  process.exitCode = status;
}
