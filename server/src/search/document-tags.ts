import { sql } from "../db.js";

/** Match any supplied tag. The column is SQL authored by the caller, never user text. */
export function documentTagPredicate(documentColumn: ReturnType<typeof sql>, tags?: string[]) {
  return tags?.length
    ? sql`exists (select 1 from document_tags tagged where tagged.document_id = ${documentColumn} and tagged.tag = any(${sql.array(tags)}))`
    : sql`true`;
}
