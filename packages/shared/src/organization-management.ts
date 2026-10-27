import { z } from "zod";
import { organizationRoleSchema } from "./pipeline.js";
import { organizationMembershipSchema, organizationSchema } from "./workspace.js";

export const organizationAccessSchema = z.object({
  orgId: z.string(), userId: z.string(), role: organizationRoleSchema,
  capabilities: z.object({ read: z.boolean(), update: z.boolean(), manageMembers: z.boolean(), manageOwners: z.boolean(), manageApiKeys: z.boolean(), leave: z.boolean() }),
});
export type OrganizationAccess = z.infer<typeof organizationAccessSchema>;
export const organizationDetailsSchema = z.object({
  organization: organizationSchema, access: organizationAccessSchema,
  counts: z.object({ members: z.number().int().nonnegative(), workspaces: z.number().int().nonnegative() }),
});
export type OrganizationDetails = z.infer<typeof organizationDetailsSchema>;
export const organizationMemberSchema = organizationMembershipSchema.extend({ email: z.string(), name: z.string() });
export type OrganizationMember = z.infer<typeof organizationMemberSchema>;
export const updateOrganizationSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  slug: z.string().trim().min(2).max(120).regex(/^[a-z0-9-]+$/).nullable().optional(),
  /** Null returns to DEFAULT_RETAINED_VERSIONS. */
  retainDocumentVersions: z.number().int().min(1).max(100).nullable().optional(),
  /** False keeps China-based model providers out of every model request made for the org. */
  allowChinaProviders: z.boolean().optional(),
}).strict().refine(value => Object.keys(value).length > 0, "Supply name, slug, retainDocumentVersions or allowChinaProviders");
export type UpdateOrganizationInput = z.infer<typeof updateOrganizationSchema>;
/** PUT /v1/organizations/:orgId/security-policy: require members to use MFA after a grace period. */
export const updateOrganizationMfaPolicySchema = z.object({
  requireMfa: z.boolean(),
  /** Days a member may keep signing in without MFA, from when the policy turned on or they joined. */
  gracePeriodDays: z.number().int().min(0).max(30).optional(),
}).strict();
export type UpdateOrganizationMfaPolicyInput = z.infer<typeof updateOrganizationMfaPolicySchema>;
