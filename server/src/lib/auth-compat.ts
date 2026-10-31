/**
 * The Better Auth release whose internals DocSlurp's authentication policy was
 * last reviewed against. Every guard that depends on native behaviour beyond
 * the documented hook and plugin API checks this version and fails startup on
 * any other, so an upgrade can't silently reopen a path the policy closed.
 *
 * Upgrading: bump `better-auth` and every `@better-auth/*` package together,
 * walk the seam inventory in docs/better-auth-upgrade-contract.md, run the
 * auth database suites, then change this constant.
 */
export const REVIEWED_BETTER_AUTH_VERSION = "1.7.14";

/** Throws unless a native plugin or package reports the reviewed release. */
export function assertReviewedBetterAuth(component: string, version: string | undefined): void {
  if (version !== REVIEWED_BETTER_AUTH_VERSION) {
    throw new Error(`${component}: Better Auth ${version ?? "(unknown)"} has not been reviewed (expected ${REVIEWED_BETTER_AUTH_VERSION}); see docs/better-auth-upgrade-contract.md before upgrading`);
  }
}
