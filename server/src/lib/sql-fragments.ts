import { sql } from "../db.js";

export type SqlFragment = ReturnType<typeof sql>;

export function joinSqlFragments(
  fragments: readonly SqlFragment[],
  separator: SqlFragment,
): SqlFragment {
  if (fragments.length === 0) {
    return sql``;
  }

  return fragments.slice(1).reduce(
    (combined, fragment) => sql`${combined}${separator}${fragment}`,
    fragments[0]!,
  );
}

export function andSqlFragments(fragments: readonly SqlFragment[]): SqlFragment {
  return fragments.length === 0
    ? sql`true`
    : joinSqlFragments(fragments, sql` and `);
}
