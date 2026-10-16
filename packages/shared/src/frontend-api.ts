import type { OrganizationRecord, WorkspaceRecord } from "./workspace.js";

/** Wire shapes for the endpoints the dashboard reads over HTTP (server/src/routes/frontend.ts). */

/** GET /dashboard/bootstrap. Read-only dashboard state; account provisioning runs during authentication. */
export type DashboardBootstrapResponse = { isAdmin: boolean; organizations: OrganizationRecord[]; workspaces: WorkspaceRecord[] };

/** A seeded local account offered as a quick-login button (development only). */
export type DevSeedAccountDescriptor = { id: "admin" | "member"; label: string; email: string };

/** GET /meta/auth-config: what the sign-in surface offers. Public. */
export type AuthConfigResponse = {
  emailAuth: boolean;
  socialProviders: { github: boolean; google: boolean };
  ssoConfigured: boolean;
  /** Empty unless the server runs with NODE_ENV=development. */
  devSeedAccounts: DevSeedAccountDescriptor[];
};

/** GET /v1/invites/:token?kind= */
export type InvitePreview = {
  kind: "organization" | "workspace";
  status: "pending" | "accepted" | "revoked" | "expired";
  email: string;
  role: string;
  organizationName: string;
  workspaceName: string | null;
  inviterName: string | null;
  expiresAt: string;
};

/** GET /oauth/mcp/consent/:id */
export type McpConsentRequest = { id: string; client_name: string; redirect_uri: string; scopes: string[] };

/** POST /v1/waitlist */
export type WaitlistResponse = { ok: true; already_registered: boolean };
