/**
 * Lifts the one-organization-per-user policy (DOCSLURP_MAX_ORGS_PER_USER=1, enforced by the org_memberships_one_org_per_user
 * index of migration 0127) in a test database. Suites that seat one user in several organizations, to exercise the
 * org-generic paths kept for when the limit is raised (and cross-organization isolation for such a user), run with it lifted.
 * Tests of the policy itself never use this.
 */
export const LIFT_ONE_ORG_PER_USER_POLICY = "drop index if exists org_memberships_one_org_per_user";
