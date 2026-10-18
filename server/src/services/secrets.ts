import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";

import { sql } from "../db.js";
import { getRequiredEncryptionKey } from "../lib/encryption.js";
import {
  canManageWorkspace,
  getWorkspaceAccess,
  type WorkspaceAccess,
} from "./organizations.js";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;

type WorkspaceSecretRow = {
  id: string;
  workspace_id: string;
  name: string;
  type: string;
  encrypted_value: string;
  rotated_at: string;
  expires_at: string | null;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
};

export interface WorkspaceSecretRecord {
  id: string;
  workspaceId: string;
  name: string;
  type: string;
  rotatedAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

export type WorkspaceSecretAccessGrant = {
  workspaceId: string;
  userId: string;
  orgId: string;
  access: WorkspaceAccess;
};

type WorkspaceSecretAccessArgs =
  | { access: WorkspaceSecretAccessGrant; workspaceId?: never; userId?: never }
  | { workspaceId: string; userId: string; access?: never };

type WorkspaceSecretMutationAccessArgs =
  | { access: WorkspaceSecretAccessGrant; userId?: never }
  | { userId: string; access?: never };

function getEncryptionKey(): Buffer {
  return getRequiredEncryptionKey("SECRETS_ENCRYPTION_KEY");
}

export function encryptSecret(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Format: hex(iv):hex(tag):hex(ciphertext)
  return `${iv.toString("hex")}:${tag.toString("hex")}:${encrypted.toString("hex")}`;
}

export function decryptSecret(stored: string): string {
  const parts = stored.split(":");
  if (parts.length !== 3) {
    throw new Error("Invalid encrypted secret format");
  }

  const [ivHex, tagHex, ciphertextHex] = parts;
  const key = getEncryptionKey();
  const iv = Buffer.from(ivHex, "hex");
  const tag = Buffer.from(tagHex, "hex");
  const ciphertext = Buffer.from(ciphertextHex, "hex");

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

function mapSecret(row: WorkspaceSecretRow): WorkspaceSecretRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    type: row.type,
    rotatedAt: row.rotated_at,
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
  };
}

export async function authorizeWorkspaceSecretAccess(args: {
  workspaceId: string;
  userId: string;
}): Promise<
  | { ok: true; grant: WorkspaceSecretAccessGrant }
  | { ok: false; status: 403 | 404; code: "forbidden" | "workspace_not_found"; message: string }
> {
  const access = await getWorkspaceAccess(args.workspaceId, args.userId);
  if (!access) {
    return { ok: false, status: 404, code: "workspace_not_found", message: "Workspace not found" };
  }
  if (!canManageWorkspace(access, args.userId)) {
    return { ok: false, status: 403, code: "forbidden", message: "Forbidden" };
  }

  return {
    ok: true,
    grant: {
      workspaceId: args.workspaceId,
      userId: args.userId,
      orgId: access.orgId,
      access,
    },
  };
}

async function requireWorkspaceSecretAccess(
  args: WorkspaceSecretAccessArgs,
): Promise<WorkspaceSecretAccessGrant> {
  if (args.access) {
    return args.access;
  }
  if (!args.userId) {
    throw new Error("Workspace secret access requires an actor userId");
  }

  const authorization = await authorizeWorkspaceSecretAccess(args);
  if (!authorization.ok) {
    throw new Error(authorization.message);
  }
  return authorization.grant;
}

export async function listWorkspaceSecrets(
  args: WorkspaceSecretAccessArgs,
): Promise<WorkspaceSecretRecord[]> {
  const grant = await requireWorkspaceSecretAccess(args);
  const rows = await sql<WorkspaceSecretRow[]>`
    select id, workspace_id, name, type, encrypted_value, rotated_at, expires_at, last_used_at, created_at, updated_at
    from workspace_secrets
    where workspace_id = ${grant.workspaceId}
    order by created_at asc
  `;

  return rows.map(mapSecret);
}

export async function createWorkspaceSecret(args: {
  workspaceId: string;
  name: string;
  type: string;
  value: string;
  expiresAt?: string | null;
} & WorkspaceSecretMutationAccessArgs): Promise<WorkspaceSecretRecord> {
  const grant = await requireWorkspaceSecretAccess(
    args.access
      ? { access: args.access }
      : { workspaceId: args.workspaceId, userId: args.userId },
  );
  const id = randomUUID();
  const encryptedValue = encryptSecret(args.value);

  const [row] = await sql<WorkspaceSecretRow[]>`
    insert into workspace_secrets (
      id, workspace_id, name, type, encrypted_value, rotated_at, expires_at, created_at, updated_at
    )
    values (
      ${id},
      ${grant.workspaceId},
      ${args.name},
      ${args.type},
      ${encryptedValue},
      now(),
      ${args.expiresAt ?? null},
      now(),
      now()
    )
    returning id, workspace_id, name, type, encrypted_value, rotated_at::text, expires_at::text, last_used_at::text, created_at::text, updated_at::text
  `;

  return mapSecret(row);
}

export async function rotateWorkspaceSecret(args: {
  workspaceId: string;
  secretId: string;
  newValue: string;
} & WorkspaceSecretMutationAccessArgs): Promise<WorkspaceSecretRecord | null> {
  const grant = await requireWorkspaceSecretAccess(
    args.access
      ? { access: args.access }
      : { workspaceId: args.workspaceId, userId: args.userId },
  );
  const encryptedValue = encryptSecret(args.newValue);

  const [row] = await sql<WorkspaceSecretRow[]>`
    update workspace_secrets
    set
      encrypted_value = ${encryptedValue},
      rotated_at = now(),
      updated_at = now()
    where id = ${args.secretId}
      and workspace_id = ${grant.workspaceId}
    returning id, workspace_id, name, type, encrypted_value, rotated_at::text, expires_at::text, last_used_at::text, created_at::text, updated_at::text
  `;

  return row ? mapSecret(row) : null;
}

export async function deleteWorkspaceSecret(args: {
  workspaceId: string;
  secretId: string;
} & WorkspaceSecretMutationAccessArgs): Promise<boolean> {
  const grant = await requireWorkspaceSecretAccess(
    args.access
      ? { access: args.access }
      : { workspaceId: args.workspaceId, userId: args.userId },
  );
  const [row] = await sql<{ id: string }[]>`
    delete from workspace_secrets
    where id = ${args.secretId}
      and workspace_id = ${grant.workspaceId}
    returning id
  `;

  return !!row;
}

export async function getWorkspaceSecretValue(args: {
  workspaceId: string;
  secretId: string;
} & WorkspaceSecretMutationAccessArgs): Promise<string | null> {
  const grant = await requireWorkspaceSecretAccess(
    args.access
      ? { access: args.access }
      : { workspaceId: args.workspaceId, userId: args.userId },
  );
  const [row] = await sql<{ encrypted_value: string }[]>`
    select encrypted_value from workspace_secrets
    where id = ${args.secretId}
      and workspace_id = ${grant.workspaceId}
  `;

  if (!row) return null;

  // Update last_used_at on access
  await sql`
    update workspace_secrets
    set last_used_at = now()
    where id = ${args.secretId}
      and workspace_id = ${grant.workspaceId}
  `;

  return decryptSecret(row.encrypted_value);
}

export async function getExpiringSecrets(daysBefore = 7): Promise<
  Array<WorkspaceSecretRecord & { workspaceName: string; ownerEmail: string }>
> {
  const rows = await sql<
    Array<
      WorkspaceSecretRow & {
        workspace_name: string;
        owner_email: string;
      }
    >
  >`
    select
      ws.id,
      ws.workspace_id,
      ws.name,
      ws.type,
      ws.encrypted_value,
      ws.rotated_at::text,
      ws.expires_at::text,
      ws.last_used_at::text,
      ws.created_at::text,
      ws.updated_at::text,
      w.name as workspace_name,
      u.email as owner_email
    from workspace_secrets ws
    join workspaces w on w.id = ws.workspace_id
    join "user" u on u.id = w.user_id
    where ws.expires_at is not null
      and ws.expires_at <= now() + (${daysBefore} * interval '1 day')
      and ws.expires_at > now()
    order by ws.expires_at asc
  `;

  return rows.map((row) => ({
    ...mapSecret(row),
    workspaceName: row.workspace_name,
    ownerEmail: row.owner_email,
  }));
}
