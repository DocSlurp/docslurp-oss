import { documentVersionKey } from "@docslurp/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// PGlite is a worker dev dependency; its migrated-database harness is shared by path.
import { createMigratedDatabase } from "@docslurp/worker/testing";

let db: Awaited<ReturnType<typeof createMigratedDatabase>>;

beforeAll(async () => {
  db = await createMigratedDatabase();
}, 120_000);

afterAll(async () => {
  await db?.close();
});

const WS = "0b9a7c1e-3f52-4d6a-8a41-7e2f1c9d5b30";

const cases: Array<[path: string, name: string]> = [
  ["", "report.pdf"],
  ["a", "report.pdf"],
  ["b", "report.pdf"],
  ["a/b/c", "Report.PDF"],
  ["A/B", "report.pdf"],
  ["/leading/slash/", "x.pdf"],
  ["a//b///c", "x.pdf"],
  ["a\\b\\c", "x.pdf"],
  ["a\\\\b//c", "x.pdf"],
  ["  spaced  ", "  name.pdf  "],
  ["\tTab\n", "\r\nname.pdf\t"],
  ["café", "résumé.pdf"],
  ["café", "résumé.pdf"],
  ["Über", "ÜBER.pdf"],
  ["日本語/フォルダ", "文書.pdf"],
  ["emoji/😀", "😀.png"],
  ["nb sp", "nb .pdf"],
  [" lead", "trail "],
  ["/", "root.pdf"],
  ["///", "///x"],
  ["dir with spaces/sub dir", "my file (1).pdf"],
  ["İstanbul", "İ.pdf"],
  ["a/./b", "x.pdf"],
  ["a/.../b", "dots.pdf"],
  ["ẞ/straße", "ß.pdf"],
];

describe("docslurp_version_key SQL matches documentVersionKey", () => {
  it("covers at least 20 inputs", () => {
    expect(cases.length).toBeGreaterThanOrEqual(20);
  });

  for (const [path, name] of cases) {
    it(`agrees for ${JSON.stringify([path, name])}`, async () => {
      const { rows } = await db.query<{ key: string }>("select docslurp_version_key($1, $2, $3) as key", [WS, path, name]);
      expect(rows[0]?.key).toBe(documentVersionKey({ workspaceId: WS, path, filename: name }));
    });
  }
});
