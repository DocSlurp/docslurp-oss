/**
 * Org-level LanceDB layouts from before every workspace had its own database.
 * Nothing reads or writes them any more; they are known only so the one-off
 * relocation (lancedb-relocate.ts) can move their rows into workspace
 * databases and drop them, and so cleanup rows queued before the change can
 * still drop a deleted org's tables.
 *
 * - `<root>/<orgId>/vectors/<model>/<dimensions>`, table `chunks`
 * - `<root>`, table `chunks_org_<hash>_embedding_<slug>_d<dimensions>_<hash>`
 * - `<root>`, table `chunks_org_<hash>` (one per org, any model)
 */
import { createHash } from "node:crypto";

import type { VectorLocation } from "@docslurp/shared";

const SAFE_ORG_ID = /^[a-zA-Z0-9_-]+$/;
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

function orgTableName(orgId: string): string {
  const normalized = orgId.trim();
  if (!normalized) throw new Error("orgId is required to derive a legacy vector namespace");
  return `chunks_org_${sha256(normalized).slice(0, 32)}`;
}

/** The org-wide table every model shared before embedding spaces existed. */
export function legacyOrgTable(root: string, orgId: string): VectorLocation {
  return { uri: root.replace(/\/+$/, ""), table: orgTableName(orgId) };
}

/** The two per-embedding-space org-level locations. */
export function legacyEmbeddingLocations(root: string, orgId: string, model: string, dimensions: number): VectorLocation[] {
  const base = root.replace(/\/+$/, "");
  const locations: VectorLocation[] = [];
  if (SAFE_ORG_ID.test(orgId)) {
    const modelSegment = encodeURIComponent(model).replace(/\./g, "%2E");
    locations.push({ uri: `${base}/${orgId}/vectors/${modelSegment}/${dimensions}`, table: "chunks" });
  }
  const slug = model.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 64) || "model";
  const identity = sha256(JSON.stringify([model, dimensions])).slice(0, 32);
  locations.push({ uri: base, table: `${orgTableName(orgId)}_embedding_${slug}_d${dimensions}_${identity}` });
  return locations;
}
