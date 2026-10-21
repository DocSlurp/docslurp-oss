import { isBillingEnforced, type ApiErrorCode, type ApiErrorDetails, type ApiErrorLinks } from "@docslurp/shared";

/**
 * Where a caller can lift a limit, attached as `details.links` (and a `Link`
 * header) to every 402 and 429. The URLs point at the hosted app (`APP_URL`):
 *
 * - `billing`: `/app/billing`, the plan, credits, spend and budget page.
 * - `buyCredits`: its "Buy credits" section (`/app/billing#bl-topup`).
 * - `upgrade`: `/pricing`, the plan comparison that hands a choice back to billing.
 * - `apiKeys`: `/app/api-keys`, where a key's own request, page and spend limits live.
 * - `docs`: the HTTP API guide's section for the limit.
 *
 * Self-hosted deployments, and any deployment that does not bill (no Stripe and
 * no `DOCSLURP_BILL_*` flag), have no billing pages, so they get no links.
 */

function readBoolean(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

export function isSelfHostedDeployment(env: NodeJS.ProcessEnv = process.env): boolean {
  const configuredProfile = env.API_RATE_LIMIT_DEFAULT_PROFILE?.trim().toLowerCase();
  if (configuredProfile === "self-hosted" || configuredProfile === "self_hosted") return true;
  const deploymentMode = env.DOCSLURP_DEPLOYMENT_MODE?.trim().toLowerCase();
  return deploymentMode === "self-hosted"
    || deploymentMode === "self_hosted"
    || readBoolean(env.DOCSLURP_SELF_HOSTED)
    || readBoolean(env.SELF_HOSTED);
}

/** Whether 402/429 responses carry billing and upgrade links. */
export function upgradeLinksEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !isSelfHostedDeployment(env) && isBillingEnforced(env);
}

function appBaseUrl(env: NodeJS.ProcessEnv): string | null {
  const raw = env.APP_URL?.trim() || "http://localhost:4321";
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.origin + url.pathname.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

export const RATE_LIMIT_DOCS_PATH = "/docs/http#rate-limits-and-headers";
export const CREDITS_DOCS_PATH = "/docs/http#credits-budgets-and-upgrades";

const CREDIT_CODES = new Set<ApiErrorCode>(["credit_exhausted", "minimum_credit_required", "payment_required"]);
const BUDGET_CODES = new Set<ApiErrorCode>(["workspace_budget_paused", "org_budget_paused"]);
const KEY_LIMIT_CODES = new Set<ApiErrorCode>(["spend_limit_exceeded", "daily_page_limit"]);

/**
 * Links for an error `code`, or undefined when the code has none or this
 * deployment has no billing. `details.plan` is the rate-limit profile: an
 * IP-level limit (`ip`) only links the docs, since nothing is bought per IP.
 */
export function upgradeLinksFor(code: ApiErrorCode, details?: ApiErrorDetails, env: NodeJS.ProcessEnv = process.env): ApiErrorLinks | undefined {
  if (!upgradeLinksEnabled(env)) return undefined;
  const base = appBaseUrl(env);
  if (!base) return undefined;
  const billing = `${base}/app/billing`;
  const buyCredits = `${base}/app/billing#bl-topup`;
  const upgrade = `${base}/pricing`;
  const apiKeys = `${base}/app/api-keys`;
  if (code === "ip_temporarily_blocked" || (code === "rate_limited" && details?.plan === "ip")) {
    return { docs: `${base}${RATE_LIMIT_DOCS_PATH}` };
  }
  if (code === "rate_limited") return { upgrade, billing, buyCredits, docs: `${base}${RATE_LIMIT_DOCS_PATH}` };
  if (KEY_LIMIT_CODES.has(code)) return { apiKeys, billing, buyCredits, upgrade, docs: `${base}${RATE_LIMIT_DOCS_PATH}` };
  if (CREDIT_CODES.has(code)) return { billing, buyCredits, upgrade, docs: `${base}${CREDITS_DOCS_PATH}` };
  if (BUDGET_CODES.has(code)) return { billing, docs: `${base}${CREDITS_DOCS_PATH}` };
  if (code === "plan_not_entitled") return { upgrade, billing, docs: `${base}${CREDITS_DOCS_PATH}` };
  return undefined;
}

/** `details` with `links` added for `code` (route-supplied links win). */
export function withUpgradeLinks(code: ApiErrorCode, details?: ApiErrorDetails): ApiErrorDetails | undefined {
  if (details?.links) return details;
  const links = upgradeLinksFor(code, details);
  return links ? { ...details, links } : details;
}

/** RFC 8288 `Link` value: `rel="payment"` for upgrade/billing, `rel="help"` for docs. */
export function upgradeLinkHeader(links: ApiErrorLinks | undefined): string | null {
  if (!links) return null;
  const parts: string[] = [];
  const payment = links.upgrade ?? links.billing;
  if (payment) parts.push(`<${payment}>; rel="payment"`);
  if (links.buyCredits && links.buyCredits !== payment) parts.push(`<${links.buyCredits}>; rel="payment"; title="Buy credits"`);
  if (links.docs) parts.push(`<${links.docs}>; rel="help"`);
  return parts.length ? parts.join(", ") : null;
}
