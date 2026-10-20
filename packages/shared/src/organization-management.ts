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
  /** Paid plans only; null returns to the plan default. */
  retainDocumentVersions: z.number().int().min(1).max(100).nullable().optional(),
}).strict().refine(value => Object.keys(value).length > 0, "Supply name, slug or retainDocumentVersions");
export type UpdateOrganizationInput = z.infer<typeof updateOrganizationSchema>;
