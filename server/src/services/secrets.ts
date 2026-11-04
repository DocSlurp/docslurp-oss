import { randomUUID } from "node:crypto";

import { sql } from "../db.js";
import { openSecret, sealSecret } from "../lib/encryption.js";
import {
  canManageProject,
  getProjectAccess,
  type ProjectAccess,
} from "./organizations.js";

type ProjectSecretRow = {
  id: string;
  project_id: string;
  name: string;
  type: string;
  encrypted_value: string;
  rotated_at: string;
  expires_at: string | null;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
};

export interface ProjectSecretRecord {
  id: string;
  projectId: string;
  name: string;
  type: string;
  rotatedAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

export type ProjectSecretAccessGrant = {
  projectId: string;
  userId: string;
  orgId: string;
  access: ProjectAccess;
};

type ProjectSecretAccessArgs =
  | { access: ProjectSecretAccessGrant; projectId?: never; userId?: never }
  | { projectId: string; userId: string; access?: never };

type ProjectSecretMutationAccessArgs =
  | { access: ProjectSecretAccessGrant; userId?: never }
  | { userId: string; access?: never };

export function encryptSecret(plaintext: string): string {
  return sealSecret("SECRETS_ENCRYPTION_KEY", plaintext);
}

export function decryptSecret(stored: string): string {
  return openSecret("SECRETS_ENCRYPTION_KEY", stored);
}

function mapSecret(row: ProjectSecretRow): ProjectSecretRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    type: row.type,
    rotatedAt: row.rotated_at,
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
  };
}

export async function authorizeProjectSecretAccess(args: {
  projectId: string;
  userId: string;
}): Promise<
  | { ok: true; grant: ProjectSecretAccessGrant }
  | { ok: false; status: 403 | 404; code: "forbidden" | "project_not_found"; message: string }
> {
  const access = await getProjectAccess(args.projectId, args.userId);
  if (!access) {
    return { ok: false, status: 404, code: "project_not_found", message: "Project not found" };
  }
  if (!canManageProject(access, args.userId)) {
    return { ok: false, status: 403, code: "forbidden", message: "Forbidden" };
  }

  return {
    ok: true,
    grant: {
      projectId: args.projectId,
      userId: args.userId,
      orgId: access.orgId,
      access,
    },
  };
}

async function requireProjectSecretAccess(
  args: ProjectSecretAccessArgs,
): Promise<ProjectSecretAccessGrant> {
  if (args.access) {
    return args.access;
  }
  if (!args.userId) {
    throw new Error("Project secret access requires an actor userId");
  }

  const authorization = await authorizeProjectSecretAccess(args);
  if (!authorization.ok) {
    throw new Error(authorization.message);
  }
  return authorization.grant;
}

export async function listProjectSecrets(
  args: ProjectSecretAccessArgs,
): Promise<ProjectSecretRecord[]> {
  const grant = await requireProjectSecretAccess(args);
  const rows = await sql<ProjectSecretRow[]>`
    select id, project_id, name, type, encrypted_value, rotated_at, expires_at, last_used_at, created_at, updated_at
    from project_secrets
    where project_id = ${grant.projectId}
    order by created_at asc
  `;

  return rows.map(mapSecret);
}

export async function createProjectSecret(args: {
  projectId: string;
  name: string;
  type: string;
  value: string;
  expiresAt?: string | null;
} & ProjectSecretMutationAccessArgs): Promise<ProjectSecretRecord> {
  const grant = await requireProjectSecretAccess(
    args.access
      ? { access: args.access }
      : { projectId: args.projectId, userId: args.userId },
  );
  const id = randomUUID();
  const encryptedValue = encryptSecret(args.value);

  const [row] = await sql<ProjectSecretRow[]>`
    insert into project_secrets (
      id, project_id, name, type, encrypted_value, rotated_at, expires_at, created_at, updated_at
    )
    values (
      ${id},
      ${grant.projectId},
      ${args.name},
      ${args.type},
      ${encryptedValue},
      now(),
      ${args.expiresAt ?? null},
      now(),
      now()
    )
    returning id, project_id, name, type, encrypted_value, rotated_at::text, expires_at::text, last_used_at::text, created_at::text, updated_at::text
  `;

  return mapSecret(row);
}

export async function rotateProjectSecret(args: {
  projectId: string;
  secretId: string;
  newValue: string;
} & ProjectSecretMutationAccessArgs): Promise<ProjectSecretRecord | null> {
  const grant = await requireProjectSecretAccess(
    args.access
      ? { access: args.access }
      : { projectId: args.projectId, userId: args.userId },
  );
  const encryptedValue = encryptSecret(args.newValue);

  const [row] = await sql<ProjectSecretRow[]>`
    update project_secrets
    set
      encrypted_value = ${encryptedValue},
      rotated_at = now(),
      updated_at = now()
    where id = ${args.secretId}
      and project_id = ${grant.projectId}
    returning id, project_id, name, type, encrypted_value, rotated_at::text, expires_at::text, last_used_at::text, created_at::text, updated_at::text
  `;

  return row ? mapSecret(row) : null;
}

export async function deleteProjectSecret(args: {
  projectId: string;
  secretId: string;
} & ProjectSecretMutationAccessArgs): Promise<boolean> {
  const grant = await requireProjectSecretAccess(
    args.access
      ? { access: args.access }
      : { projectId: args.projectId, userId: args.userId },
  );
  const [row] = await sql<{ id: string }[]>`
    delete from project_secrets
    where id = ${args.secretId}
      and project_id = ${grant.projectId}
    returning id
  `;

  return !!row;
}

export async function getProjectSecretValue(args: {
  projectId: string;
  secretId: string;
} & ProjectSecretMutationAccessArgs): Promise<string | null> {
  const grant = await requireProjectSecretAccess(
    args.access
      ? { access: args.access }
      : { projectId: args.projectId, userId: args.userId },
  );
  const [row] = await sql<{ encrypted_value: string }[]>`
    select encrypted_value from project_secrets
    where id = ${args.secretId}
      and project_id = ${grant.projectId}
  `;

  if (!row) return null;

  // Update last_used_at on access
  await sql`
    update project_secrets
    set last_used_at = now()
    where id = ${args.secretId}
      and project_id = ${grant.projectId}
  `;

  return decryptSecret(row.encrypted_value);
}

export async function getExpiringSecrets(daysBefore = 7): Promise<
  Array<ProjectSecretRecord & { projectName: string; ownerEmail: string }>
> {
  const rows = await sql<
    Array<
      ProjectSecretRow & {
        project_name: string;
        owner_email: string;
      }
    >
  >`
    select
      ws.id,
      ws.project_id,
      ws.name,
      ws.type,
      ws.encrypted_value,
      ws.rotated_at::text,
      ws.expires_at::text,
      ws.last_used_at::text,
      ws.created_at::text,
      ws.updated_at::text,
      w.name as project_name,
      u.email as owner_email
    from project_secrets ws
    join projects w on w.id = ws.project_id
    join "user" u on u.id = w.user_id
    where ws.expires_at is not null
      and ws.expires_at <= now() + (${daysBefore} * interval '1 day')
      and ws.expires_at > now()
    order by ws.expires_at asc
  `;

  return rows.map((row) => ({
    ...mapSecret(row),
    projectName: row.project_name,
    ownerEmail: row.owner_email,
  }));
}
