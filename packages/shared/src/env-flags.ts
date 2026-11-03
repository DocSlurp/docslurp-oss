/**
 * Boolean-style environment flags for startup logs and telemetry: which
 * features this process booted with (MEDIA_REMOTE_ENABLED=false,
 * PAGE_ROUTER_MODE=off, ...).
 *
 * Only values that are themselves booleans are reported, so URLs, keys,
 * numbers and free-form settings never leave the process. Names that look
 * secret are dropped even with a boolean value. Unset variables are absent:
 * the reader falls back to each flag's code default.
 */

const BOOLEAN_VALUES = new Set(["true", "false", "on", "off", "yes", "no"]);
const SECRET_NAME = /KEY|SECRET|TOKEN|PASSW|CREDENTIAL|PRIVATE|COOKIE|SESSION|DSN|AUTH_HEADER/;
const IGNORED_PREFIX = /^(NPM_|PNPM_|COREPACK_)/;

export function envFlags(env: Record<string, string | undefined> = process.env): Record<string, string> {
  const flags: Record<string, string> = {};
  for (const name of Object.keys(env).sort()) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(name) || IGNORED_PREFIX.test(name) || SECRET_NAME.test(name)) continue;
    const value = env[name]?.trim().toLowerCase();
    if (value && BOOLEAN_VALUES.has(value)) flags[name] = value;
  }
  return flags;
}

export function formatEnvFlags(flags: Record<string, string>): string {
  const pairs = Object.entries(flags).map(([name, value]) => `${name}=${value}`);
  return pairs.length > 0 ? pairs.join(" ") : "none";
}
