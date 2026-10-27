import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

/**
 * Where `docslurp login` keeps its OAuth credentials.
 *
 * - The OS keychain when one is usable: macOS Keychain (`security`), the
 *   freedesktop Secret Service through libsecret (`secret-tool`), or the
 *   Windows Credential Manager (PasswordVault through Windows PowerShell).
 *   Secrets reach these tools on stdin, never in argv.
 * - Otherwise `~/.config/docslurp/credentials.json` (`$XDG_CONFIG_HOME`,
 *   `%APPDATA%` on Windows): mode 0600 in a 0700 directory. A file or
 *   directory with looser permissions, a symlink, or another owner is refused.
 *
 * `DOCSLURP_CREDENTIAL_STORE=keychain` requires the keychain (fail closed),
 * `file` forces the file, and `auto` (the default) prefers the keychain.
 * Credentials are keyed by profile and API origin, so each profile holds one
 * login per DocSlurp deployment.
 */

export type StoredCredential = {
  version: 1;
  apiUrl: string;
  profile: string;
  clientId: string;
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken: string;
  scopes: string[];
  user?: { id: string; email: string | null; name: string | null };
  organization?: { id: string; name: string } | null;
  updatedAt: string;
};

export type StoreMode = "auto" | "keychain" | "file";

const SERVICE = "docslurp-cli";
const PROFILE_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const TOOL_TIMEOUT_MS = 15_000;

export class CredentialStoreError extends Error {}

export function validateProfile(profile: string): string {
  if (!PROFILE_PATTERN.test(profile)) throw new CredentialStoreError("--profile must be 1-64 letters, digits, dots, dashes or underscores.");
  return profile;
}

/** One credential per profile and API origin. */
export function credentialAccount(profile: string, apiUrl: string): string {
  const account = `${validateProfile(profile)}@${new URL(apiUrl).origin}`;
  // Origins cannot contain quotes or spaces; refuse anything that could break tool quoting.
  if (!/^[A-Za-z0-9._@:/[\]-]+$/.test(account)) throw new CredentialStoreError("Unsupported API URL for credential storage.");
  return account;
}

export function storeMode(): StoreMode {
  const value = (process.env.DOCSLURP_CREDENTIAL_STORE ?? "auto").trim().toLowerCase() || "auto";
  if (value !== "auto" && value !== "keychain" && value !== "file") {
    throw new CredentialStoreError("DOCSLURP_CREDENTIAL_STORE must be auto, keychain or file.");
  }
  return value;
}

function parseCredential(raw: unknown): StoredCredential | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (value.version !== 1 || typeof value.accessToken !== "string" || typeof value.refreshToken !== "string"
    || typeof value.apiUrl !== "string" || typeof value.clientId !== "string" || typeof value.accessTokenExpiresAt !== "string") return null;
  return { ...value, scopes: Array.isArray(value.scopes) ? value.scopes.filter((scope): scope is string => typeof scope === "string") : [] } as StoredCredential;
}

// ---------------------------------------------------------------------------
// File store

export function credentialsDirectory(): string {
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  if (xdg) return join(xdg, "docslurp");
  if (process.platform === "win32" && process.env.APPDATA) return join(process.env.APPDATA, "docslurp");
  return join(homedir(), ".config", "docslurp");
}

export const credentialsFile = () => join(credentialsDirectory(), "credentials.json");

/**
 * POSIX: refuse symlinks, other owners and any group/other permission bits.
 * Windows has no POSIX modes; %APPDATA% is per-user by ACL.
 */
async function assertPrivate(path: string, kind: "directory" | "file"): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink()) throw new CredentialStoreError(`Refusing to use ${path}: it is a symbolic link.`);
  if (kind === "directory" ? !info.isDirectory() : !info.isFile()) throw new CredentialStoreError(`Refusing to use ${path}: not a ${kind}.`);
  if (process.platform === "win32") return;
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw new CredentialStoreError(`Refusing to use ${path}: it is owned by another user.`);
  }
  if ((info.mode & 0o077) !== 0) {
    const fix = kind === "directory" ? "chmod 700" : "chmod 600";
    throw new CredentialStoreError(`Refusing to use ${path}: permissions ${(info.mode & 0o777).toString(8)} are too open. Run \`${fix} ${path}\` or \`docslurp logout\`.`);
  }
}

type CredentialFile = { version: 1; credentials: Record<string, StoredCredential> };

async function readCredentialFile(): Promise<CredentialFile> {
  const dir = credentialsDirectory(), file = credentialsFile();
  if (!existsSync(file)) return { version: 1, credentials: {} };
  await assertPrivate(dir, "directory");
  await assertPrivate(file, "file");
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, "utf8"));
  } catch {
    throw new CredentialStoreError(`${file} is not valid JSON. Remove it and run \`docslurp login\` again.`);
  }
  const credentials: Record<string, StoredCredential> = {};
  const entries = (parsed as { credentials?: Record<string, unknown> })?.credentials ?? {};
  for (const [account, value] of Object.entries(entries)) {
    const credential = parseCredential(value);
    if (credential) credentials[account] = credential;
  }
  return { version: 1, credentials };
}

async function writeCredentialFile(data: CredentialFile): Promise<void> {
  const dir = credentialsDirectory(), file = credentialsFile();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await assertPrivate(dir, "directory");
  if (Object.keys(data.credentials).length === 0) {
    if (existsSync(file)) await unlink(file);
    return;
  }
  const temp = join(dir, `.credentials.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  // O_EXCL with mode 0600: the secret never exists in a wider-permission file.
  const handle = await open(temp, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(data, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temp, file);
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }
}

const fileStore = {
  label: () => `file ${credentialsFile()}`,
  async get(account: string) { return (await readCredentialFile()).credentials[account] ?? null; },
  async set(account: string, credential: StoredCredential) {
    const data = await readCredentialFile();
    data.credentials[account] = credential;
    await writeCredentialFile(data);
  },
  async delete(account: string) {
    if (!existsSync(credentialsFile())) return false;
    const data = await readCredentialFile();
    if (!data.credentials[account]) return false;
    delete data.credentials[account];
    await writeCredentialFile(data);
    return true;
  },
};

// ---------------------------------------------------------------------------
// OS keychains (via platform tools; no native dependency)

type ToolResult = { code: number | null; stdout: string };

function runTool(command: string, args: string[], input?: string): Promise<ToolResult> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    } catch {
      resolve({ code: -1, stdout: "" });
      return;
    }
    let stdout = "";
    const timer = setTimeout(() => child.kill(), TOOL_TIMEOUT_MS);
    child.stdout?.on("data", (chunk) => { if (stdout.length < 65_536) stdout += chunk; });
    child.once("error", () => { clearTimeout(timer); resolve({ code: -1, stdout: "" }); });
    child.once("close", (code) => { clearTimeout(timer); resolve({ code, stdout }); });
    child.stdin?.on("error", () => {});
    child.stdin?.end(input ?? "");
  });
}

function onPath(binary: string): boolean {
  return (process.env.PATH ?? "").split(delimiter).some((dir) => dir && existsSync(join(dir, binary)));
}

const encode = (credential: StoredCredential) => Buffer.from(JSON.stringify(credential), "utf8").toString("base64");
function decode(secret: string): StoredCredential | null {
  try {
    return parseCredential(JSON.parse(Buffer.from(secret.trim(), "base64").toString("utf8")));
  } catch {
    return null;
  }
}

type Keychain = {
  name: string;
  available(): boolean;
  read(account: string): Promise<string | null>;
  write(account: string, secret: string): Promise<boolean>;
  remove(account: string): Promise<boolean>;
};

const macKeychain: Keychain = {
  name: "macOS Keychain",
  available: () => process.platform === "darwin" && existsSync("/usr/bin/security"),
  async read(account) {
    const result = await runTool("/usr/bin/security", ["find-generic-password", "-s", SERVICE, "-a", account, "-w"]);
    return result.code === 0 ? result.stdout : null;
  },
  async write(account, secret) {
    // `security -i` reads the command from stdin, so the secret is not in argv; -X takes hex.
    const hex = Buffer.from(secret, "utf8").toString("hex");
    const result = await runTool("/usr/bin/security", ["-i"], `add-generic-password -U -s ${SERVICE} -a "${account}" -l "DocSlurp CLI" -X ${hex}\n`);
    return result.code === 0;
  },
  async remove(account) {
    return (await runTool("/usr/bin/security", ["delete-generic-password", "-s", SERVICE, "-a", account])).code === 0;
  },
};

const secretService: Keychain = {
  name: "Secret Service (libsecret)",
  available: () => process.platform === "linux" && onPath("secret-tool")
    && Boolean(process.env.DBUS_SESSION_BUS_ADDRESS || (process.env.XDG_RUNTIME_DIR && existsSync(join(process.env.XDG_RUNTIME_DIR, "bus")))),
  async read(account) {
    const result = await runTool("secret-tool", ["lookup", "service", SERVICE, "account", account]);
    return result.code === 0 && result.stdout ? result.stdout : null;
  },
  async write(account, secret) {
    // secret-tool reads the secret from stdin.
    return (await runTool("secret-tool", ["store", "--label", `DocSlurp CLI (${account})`, "service", SERVICE, "account", account], secret)).code === 0;
  },
  async remove(account) {
    return (await runTool("secret-tool", ["clear", "service", SERVICE, "account", account])).code === 0;
  },
};

const PASSWORD_VAULT = "[void][Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime];$v=New-Object Windows.Security.Credentials.PasswordVault;";
const windowsVault: Keychain = {
  name: "Windows Credential Manager",
  available: () => process.platform === "win32",
  // The script (and the base64 secret it carries) goes to Windows PowerShell on stdin.
  async read(account) {
    const script = `$ErrorActionPreference='Stop';${PASSWORD_VAULT}try{$c=$v.Retrieve('${SERVICE}','${account}');$c.RetrievePassword();[Console]::Out.Write($c.Password)}catch{exit 44}\n`;
    const result = await runTool("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "-"], script);
    return result.code === 0 && result.stdout ? result.stdout : null;
  },
  async write(account, secret) {
    const script = `$ErrorActionPreference='Stop';${PASSWORD_VAULT}try{$v.Remove($v.Retrieve('${SERVICE}','${account}'))}catch{};$v.Add((New-Object Windows.Security.Credentials.PasswordCredential('${SERVICE}','${account}','${secret}')))\n`;
    return (await runTool("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "-"], script)).code === 0;
  },
  async remove(account) {
    const script = `$ErrorActionPreference='Stop';${PASSWORD_VAULT}try{$v.Remove($v.Retrieve('${SERVICE}','${account}'))}catch{exit 44}\n`;
    return (await runTool("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "-"], script)).code === 0;
  },
};

function platformKeychain(): Keychain | null {
  for (const keychain of [macKeychain, secretService, windowsVault]) if (keychain.available()) return keychain;
  return null;
}

// ---------------------------------------------------------------------------
// Public store API

export type LoadedCredential = { credential: StoredCredential; source: string };

export async function loadCredential(account: string): Promise<LoadedCredential | null> {
  const mode = storeMode();
  if (mode !== "file") {
    const keychain = platformKeychain();
    if (!keychain && mode === "keychain") throw new CredentialStoreError("DOCSLURP_CREDENTIAL_STORE=keychain, but no OS keychain is available.");
    if (keychain) {
      const secret = await keychain.read(account);
      const credential = secret ? decode(secret) : null;
      if (credential) return { credential, source: `keychain (${keychain.name})` };
      if (mode === "keychain") return null;
    }
  }
  const credential = await fileStore.get(account);
  return credential ? { credential, source: fileStore.label() } : null;
}

/** Stores the credential and returns where it went. Auto mode falls back to the file, and says so. */
export async function saveCredential(account: string, credential: StoredCredential, warn: (message: string) => void = () => {}): Promise<string> {
  const mode = storeMode();
  if (mode !== "file") {
    const keychain = platformKeychain();
    if (keychain) {
      const secret = encode(credential);
      // Read back: some tools exit 0 without storing (a locked or absent collection).
      if (await keychain.write(account, secret) && (await keychain.read(account))?.trim() === secret) {
        await fileStore.delete(account).catch(() => false);
        return `keychain (${keychain.name})`;
      }
      if (mode === "keychain") throw new CredentialStoreError(`Could not store the login in ${keychain.name}.`);
      warn(`Could not use ${keychain.name}; storing the login in ${credentialsFile()} (mode 0600) instead.`);
    } else if (mode === "keychain") {
      throw new CredentialStoreError("DOCSLURP_CREDENTIAL_STORE=keychain, but no OS keychain is available.");
    }
  }
  await fileStore.set(account, credential);
  return fileStore.label();
}

export async function deleteCredential(account: string): Promise<boolean> {
  const mode = storeMode();
  let removed = false;
  if (mode !== "file") {
    const keychain = platformKeychain();
    if (keychain && await keychain.read(account)) removed = (await keychain.remove(account)) || removed;
  }
  if (mode !== "keychain") removed = (await fileStore.delete(account)) || removed;
  return removed;
}
