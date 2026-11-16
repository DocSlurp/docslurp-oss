/**
 * `DOCSLURP_DISABLE` kill switches (docs/self-host/deployment-profile.md): the closed vocabulary, its parser and the
 * readers' view. Deliberately free of imports so VM guest bundles that include the chart contract (chart-export.ts) stay
 * off the deployment-profile and runtime-environment code; deployment-profile.ts re-exports everything here.
 */

type Env = Readonly<Record<string, string | undefined>>;

export const DISABLE_ENV = "DOCSLURP_DISABLE";

/** ASCII-only trim and lower-case, as runtime-environment.ts normalizeEnvSetting does (kept here to stay import-free). */
function normalize(value: string): string {
  return value.replace(/^[\t\n\v\f\r ]+|[\t\n\v\f\r ]+$/g, "").replace(/[A-Z]+/g, (letters) => letters.toLowerCase());
}

/**
 * The closed `DOCSLURP_DISABLE` vocabulary (design 2.5). Every token is known from R0, so a rollback to R0 never meets
 * an unknown token.
 */
export const DISABLE_TOKENS = [
  "ai",
  "ai-rescue",
  "ai-escalation",
  "page-reader",
  "ocr",
  "router",
  "figures",
  "charts",
  "charts-ai",
  "figure-resume",
] as const;
export type DisableToken = (typeof DISABLE_TOKENS)[number];

/**
 * What each switch also turns off. `ai` turns off every model read in extraction: rescue, escalation, the page image
 * reader, decision models (deterministic routing only) and AI chart reads; `smart` runs as `balanced` without AI
 * (applyKillSwitchesToPipeline). `charts` turns off all chart export, including AI chart reads.
 */
const IMPLIES: Readonly<Partial<Record<DisableToken, readonly DisableToken[]>>> = {
  ai: ["ai-rescue", "ai-escalation", "page-reader", "router", "charts-ai"],
  charts: ["charts-ai"],
};

export function isDisableToken(value: string): value is DisableToken {
  return (DISABLE_TOKENS as readonly string[]).includes(value);
}

/** Parse `DOCSLURP_DISABLE`: comma list, trimmed, lower-cased; empty entries ignored. Unknown tokens are returned apart. */
export function parseDisableList(raw: string | undefined | null): { tokens: DisableToken[]; unknown: string[] } {
  const tokens = new Set<DisableToken>();
  const unknown: string[] = [];
  for (const entry of (raw ?? "").split(",")) {
    const token = normalize(entry);
    if (!token) continue;
    if (isDisableToken(token)) tokens.add(token);
    else unknown.push(token.slice(0, 40));
  }
  return { tokens: DISABLE_TOKENS.filter((token) => tokens.has(token)), unknown };
}

/** The switches the given tokens turn off, with their implications, in vocabulary order. */
export function expandDisableTokens(tokens: Iterable<DisableToken>): DisableToken[] {
  const off = new Set<DisableToken>();
  for (const token of tokens) {
    off.add(token);
    for (const implied of IMPLIES[token] ?? []) off.add(implied);
  }
  return DISABLE_TOKENS.filter((token) => off.has(token));
}

const ALL_OFF: ReadonlySet<DisableToken> = new Set(DISABLE_TOKENS);
let lastParsed: { raw: string; set: ReadonlySet<DisableToken> } | null = null;

/**
 * The switches that are off under `env` (`DOCSLURP_DISABLE` with implications). Never throws: a value with an unknown
 * token reads as every switch off (fail closed); startup refuses it (resolveDeploymentProfile).
 */
export function disabledSwitches(env: Env): ReadonlySet<DisableToken> {
  const raw = env[DISABLE_ENV] ?? "";
  if (lastParsed?.raw === raw) return lastParsed.set;
  const parsed = parseDisableList(raw);
  const set: ReadonlySet<DisableToken> = parsed.unknown.length > 0 ? ALL_OFF : new Set(expandDisableTokens(parsed.tokens));
  lastParsed = { raw, set };
  return set;
}

/** True when `token` (or a switch that implies it) is in `DOCSLURP_DISABLE`. */
export function switchDisabled(env: Env, token: DisableToken): boolean {
  return disabledSwitches(env).has(token);
}

