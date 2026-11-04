import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as lancedb from "@lancedb/lancedb";
import { afterAll, describe, expect, it } from "vitest";

import {
  CHUNK_TEXT_FTS_INDEX_NAME,
  chunkTextFtsLanguage,
  ensureChunkTextFtsIndex,
  hasCurrentChunkTextFtsIndex,
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

    expect(await ensureChunkTextFtsIndex(table, legacy)).toBe(true);
    const indices = await table.listIndices();
    expect(indices.filter((index) => index.columns.includes("text"))).toHaveLength(1);
    expect(indices.find((index) => index.columns.includes("text"))?.name).toBe(CHUNK_TEXT_FTS_INDEX_NAME);
    expect(await ensureChunkTextFtsIndex(table, indices)).toBe(false);

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
});
