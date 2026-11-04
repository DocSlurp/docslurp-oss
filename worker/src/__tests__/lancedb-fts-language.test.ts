import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as lancedb from "@lancedb/lancedb";
import { afterAll, describe, expect, it } from "vitest";

import {
  CHUNK_TEXT_FTS_INDEX_NAME,
  chunkTextFtsIndexName,
  chunkTextFtsLanguage,
  ensureChunkTextFtsIndex,
  ftsRebuildBackoffMs,
  hasCurrentChunkTextFtsIndex,
  resetFtsRebuildBackoff,
} from "../stages/lancedb-maintenance.js";

describe("chunk-text FTS analyzer", () => {
  it("is language-neutral unless a deployment names one language", () => {
    expect(chunkTextFtsLanguage({})).toBeNull();
    expect(chunkTextFtsLanguage({ LANCEDB_FTS_LANGUAGE: "auto" })).toBeNull();
    expect(chunkTextFtsLanguage({ LANCEDB_FTS_LANGUAGE: " German " })).toBe("German");
  });

  const dirs: string[] = [];
  afterAll(async () => { await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))); });

  it("replaces the old English-only index and finds CJK, Cyrillic and accented text", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fts-language-"));
    dirs.push(dir);
    const db = await lancedb.connect(dir);
    const table = await db.createTable("chunks", [
      { id: "ja", vector: [0.1, 0.2], text: "請求書の支払期限は来月末日です。東京の本社" },
      { id: "ru", vector: [0.2, 0.1], text: "Москва является столицей России" },
      { id: "de", vector: [0.3, 0.3], text: "Herr Müller zahlt Gebühren für die Wohnung" },
      { id: "en", vector: [0.4, 0.4], text: "The tenant shall terminate the subscription plan" },
    ]);
    // What maintenance built before: English stemmer and stop words under the default name.
    await table.createIndex("text", { config: lancedb.Index.fts({ withPosition: false, language: "English", stem: true, removeStopWords: true, lowercase: true, asciiFolding: true }), replace: false });
    const legacy = await table.listIndices();
    expect(hasCurrentChunkTextFtsIndex(legacy)).toBe(false);

    const rebuilt = await ensureChunkTextFtsIndex(table, legacy, { key: "t1" });
    expect(rebuilt).toMatchObject({ rebuilt: true });
    expect(rebuilt.ms).toBeGreaterThanOrEqual(0);
    const indices = await table.listIndices();
    expect(indices.filter((index) => index.columns.includes("text"))).toHaveLength(1);
    expect(indices.find((index) => index.columns.includes("text"))?.name).toBe(CHUNK_TEXT_FTS_INDEX_NAME);
    expect(await ensureChunkTextFtsIndex(table, indices, { key: "t1" })).toMatchObject({ rebuilt: false, ms: 0 });

    const find = async (query: string) => (await table.search(query, "fts", "text").limit(5).toArray()).map((row) => row.id as string);
    expect(await find("東京")).toEqual(["ja"]);
    expect(await find("支払期限")).toEqual(["ja"]);
    expect(await find("столицей")).toEqual(["ru"]);
    expect(await find("Muller")).toEqual(["de"]);
    expect(await find("Gebühren")).toEqual(["de"]);
    expect(await find("subscription")).toEqual(["en"]);
    table.close();
    db.close();
  });

  it("names the index after its analyzer so a language change rebuilds it", () => {
    expect(chunkTextFtsIndexName({})).toBe(CHUNK_TEXT_FTS_INDEX_NAME);
    expect(chunkTextFtsIndexName({ LANCEDB_FTS_LANGUAGE: "auto" })).toBe(CHUNK_TEXT_FTS_INDEX_NAME);
    expect(chunkTextFtsIndexName({ LANCEDB_FTS_LANGUAGE: "German" })).toBe("text_fts_german_v1");
    expect(chunkTextFtsIndexName({ LANCEDB_FTS_LANGUAGE: " Portuguese (BR)! " })).toBe("text_fts_portuguese_br_v1");
    const icu = [{ name: CHUNK_TEXT_FTS_INDEX_NAME, indexType: "FTS", columns: ["text"] }];
    expect(hasCurrentChunkTextFtsIndex(icu, {})).toBe(true);
    expect(hasCurrentChunkTextFtsIndex(icu, { LANCEDB_FTS_LANGUAGE: "German" })).toBe(false);
  });

  it("builds the new index before dropping the old one, and keeps the old one when the build fails", async () => {
    resetFtsRebuildBackoff();
    const calls: string[] = [];
    const legacy = [{ name: "text_idx", indexType: "FTS", columns: ["text"] }];
    const failing = {
      createIndex: async () => { calls.push("create"); throw new Error("out of memory"); },
      dropIndex: async (name: string) => { calls.push(`drop ${name}`); },
    };
    const failed = await ensureChunkTextFtsIndex(failing as never, legacy, { key: "t2", now: 1_000 });
    expect(failed).toMatchObject({ rebuilt: false, error: "out of memory" });
    expect(calls).toEqual(["create"]);

    const ok = {
      createIndex: async () => { calls.push("create"); },
      dropIndex: async (name: string) => { calls.push(`drop ${name}`); },
    };
    // The next pass, a minute later, does not retry a full build.
    expect(await ensureChunkTextFtsIndex(ok as never, legacy, { key: "t2", now: 61_000 })).toMatchObject({ rebuilt: false, backedOff: true });
    expect(calls).toEqual(["create"]);
    expect(ftsRebuildBackoffMs("t2", 61_000)).toBeGreaterThan(0);
    // Other tables are not held back, and the back-off ends.
    expect(ftsRebuildBackoffMs("other", 61_000)).toBe(0);
    const later = await ensureChunkTextFtsIndex(ok as never, legacy, { key: "t2", now: 1_000 + 24 * 60 * 60_000 });
    expect(later).toMatchObject({ rebuilt: true });
    expect(calls).toEqual(["create", "create", "drop text_idx"]);
  });
});
