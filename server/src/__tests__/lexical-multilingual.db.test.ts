import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { startMigratedPostgres } from "@docslurp/worker/testing";

/**
 * Keyword search over real text in several languages, against the migrated schema (migration 0121's
 * expression leg beside the English `ts_content`, with and without the GIN expression index that
 * server/db/folded-search-index.mjs builds after the migration). Each case is a query a user would type and the
 * chunk that must be found; the English-only configuration alone failed the accent, Cyrillic-case and
 * CJK cases, and the ASCII backoff deleted every non-ASCII letter from the query.
 */
let stop: () => Promise<void>;
let sql: postgres.Sql<Record<string, unknown>>;
let search: typeof import("../services/search.js");
let foldedIndex: typeof import("../search/folded-index.js");

const CORPUS: Record<string, string> = {
  en: "Refunds are not allowed after thirty days. The class action settlement covers late fees.",
  de: "Die Müller GmbH erhöht die Gebühren für Verwaltung und Wartung zum ersten Januar.",
  fr: "Le contrat de la société Dupont prévoit une résiliation anticipée avec préavis de trois mois.",
  ru: "Налоговая декларация должна быть подана до тридцатого апреля. Штраф за просрочку составляет пять процентов.",
  ja: "東京は日本の首都であり、人口は約1400万人です。契約の解除には三十日前の通知が必要です。",
  zh: "合同终止需要提前三十天书面通知对方。违约金为合同总额的百分之五。",
  other: "The weather in Lisbon is mild in spring and the harbour is busy.",
};

beforeAll(async () => {
  const pg = await startMigratedPostgres();
  stop = pg.stop;
  sql = postgres(pg.url, { max: 1, prepare: false, onnotice: () => {} }) as unknown as postgres.Sql<Record<string, unknown>>;
  vi.doMock("../db.js", () => ({ sql }));
  search = await import("../services/search.js");
  foldedIndex = await import("../search/folded-index.js");

  await sql.unsafe("set session_replication_role = replica");
  const languages = Object.keys(CORPUS);
  await sql`
    insert into documents (id, user_id, workspace_id, run_id, filename, mime_type, source_key, status, org_id)
    select 'doc-' || l, 'u1', 'ws-a', 'run-1', l || '.txt', 'text/plain', 'k', 'completed', 'org1'
    from unnest(${languages}::text[]) as l
  `;
  await sql`
    insert into documents (id, user_id, workspace_id, run_id, filename, mime_type, source_key, status, org_id)
    values ('doc-foreign', 'u2', 'ws-b', 'run-2', 'foreign.txt', 'text/plain', 'k', 'completed', 'org2')
  `;
  await sql`insert into document_chunks ${sql(languages.map((language, index) => ({
    id: `c-${language}`, document_id: `doc-${language}`, run_id: "run-1", user_id: "u1", chunk_index: index,
    text: CORPUS[language]!, page_number: 1, token_estimate: 20,
  })))}`;
  // Another tenant's chunk that matches the German query: it must never be returned for ws-a.
  await sql`insert into document_chunks ${sql([{
    id: "c-foreign", document_id: "doc-foreign", run_id: "run-2", user_id: "u2", chunk_index: 0,
    text: "Müller Gebühren der anderen Organisation", page_number: 1, token_estimate: 8,
  }])}`;
  await sql.unsafe("set session_replication_role = origin");
}, 120_000);

afterAll(async () => {
  await sql?.end({ timeout: 1 });
  await stop?.();
});

const find = async (query: string) =>
  (await search.textSearch(query, "u1", { filters: { workspaceId: "ws-a" }, limit: 5 })).map((chunk) => chunk.id);

describe.each([
  ["before the folded index is built", false],
  ["with the folded expression index", true],
] as const)("multilingual keyword search %s", (_label, indexed) => {
  beforeAll(async () => {
    if (indexed) {
      // The same statement as folded-search-index.mjs, minus CONCURRENTLY (the test owns its database).
      const { INDEX_EXPRESSION, INDEX_NAME } = await import("../../db/folded-search-index.mjs");
      await sql.unsafe(`create index ${INDEX_NAME} on document_chunks using gin ((${INDEX_EXPRESSION}))`);
    }
    foldedIndex.resetFoldedIndexCache();
    expect(await foldedIndex.foldedIndexReady()).toBe(indexed);
  });

  it.each([
    ["English control", "refunds after thirty days", "c-en"],
    ["negation is kept", "refunds not allowed", "c-en"],
    ["class is an ordinary subject", "class action settlement", "c-en"],
    ["German, umlauts typed", "Müller Gebühren", "c-de"],
    ["German, umlauts folded", "Muller Gebuhren", "c-de"],
    ["German, one word", "Verwaltung", "c-de"],
    ["German, conversational", "wie hoch sind die Müller Gebühren in Lissabon", "c-de"],
    ["French, conversational", "quel est le préavis de résiliation anticipée à Lisbonne", "c-fr"],
    ["Russian, conversational", "какой штраф за просрочку в Лиссабоне", "c-ru"],
    ["French, accents typed", "résiliation anticipée préavis", "c-fr"],
    ["French, accents dropped", "resiliation anticipee preavis", "c-fr"],
    ["Russian", "налоговая декларация", "c-ru"],
    ["Russian, other case", "ШТРАФ ЗА ПРОСРОЧКУ", "c-ru"],
    ["Japanese, noun", "日本の首都", "c-ja"],
    ["Japanese, two words", "契約 解除", "c-ja"],
    ["Japanese, question", "日本の首都はどこですか", "c-ja"],
    ["Chinese, noun", "合同终止", "c-zh"],
    ["Chinese, question", "违约金是多少", "c-zh"],
  ])("%s: %j finds %s first", async (_name, query, expected) => {
    const ids = await find(query);
    expect(ids[0]).toBe(expected);
  });

  it("returns nothing for text that is not in the workspace", async () => {
    expect(await find("zxqvbn zxqvbn")).toEqual([]);
    expect(await find("火星の天気")).not.toContain("c-ja");
  });

  it("never returns another workspace's chunk for the same words", async () => {
    const ids = await find("Müller Gebühren");
    expect(ids).toContain("c-de");
    expect(ids).not.toContain("c-foreign");
    const other = (await search.textSearch("Müller Gebühren", "u2", { filters: { workspaceId: "ws-b" }, limit: 5 })).map((chunk) => chunk.id);
    expect(other).toEqual(["c-foreign"]);
  });

  it("builds the English backoff from Unicode words instead of deleting non-ASCII letters", () => {
    expect(search.buildLexicalBackoffTsQuery("Müller Gebühren")).toBe("müller | gebühren");
    expect(search.buildLexicalBackoffTsQuery("налоговая декларация")).toBe("налоговая | декларация");
    expect(search.buildLexicalBackoffTsQuery("how do I cancel the class action")).toBe("cancel | class | action");
    expect(search.buildLexicalBackoffTsQuery("日本の首都")).toBeNull();
  });

  it("builds the folded backoff from words and CJK character pairs", () => {
    expect(search.buildFoldedLexicalBackoffQuery("日本の首都")).toBe("('日' <-> '本') | ('本' <-> 'の') | ('の' <-> '首') | ('首' <-> '都')");
    expect(search.buildFoldedLexicalBackoffQuery("Müller 契約")).toBe("'muller' | ('契' <-> '約')");
  });

  if (indexed) it("serves the folded leg from the expression index", async () => {
    const plan = await sql.begin(async (tx) => {
      await tx.unsafe("set local enable_seqscan = off");
      return await tx.unsafe(
        "explain select id from document_chunks c where to_tsvector('simple'::regconfig, docslurp_fold_text(c.text)) @@ websearch_to_tsquery('simple', docslurp_fold_text('Müller'))",
      );
    });
    expect(JSON.stringify(plan)).toContain("document_chunks_ts_folded_expr_idx");
  });
});

describe("folded index settings", () => {
  it("bounds the unindexed leg by its own timeout", async () => {
    const { foldedUnindexedTimeoutMs } = foldedIndex;
    expect(foldedUnindexedTimeoutMs({} as NodeJS.ProcessEnv)).toBe(2_000);
    expect(foldedUnindexedTimeoutMs({ SEARCH_FOLDED_UNINDEXED_TIMEOUT_MS: "50" } as NodeJS.ProcessEnv)).toBe(100);
    expect(foldedUnindexedTimeoutMs({ SEARCH_FOLDED_UNINDEXED_TIMEOUT_MS: "999999" } as NodeJS.ProcessEnv)).toBe(60_000);
    expect(foldedUnindexedTimeoutMs({ SEARCH_FOLDED_UNINDEXED_TIMEOUT_MS: "nope" } as NodeJS.ProcessEnv)).toBe(2_000);
  });
});
