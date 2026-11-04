import { describe, expect, it, vi } from "vitest";

import { chunkTokenBudget, embeddingInputTokenLimit, preambleReserveTokens } from "../embeddings/input-limits.js";
import { detectLanguage, detectScript } from "../embeddings/resolver.js";
import { buildCanonicalChunksFromDocument, buildCanonicalDocumentFromMarkdown } from "../lib/canonical-document.js";
import { estimateTokens } from "../lib/unicode-text.js";
import { ArtifactReadError, buildChunks, extractTextForEmbedding, fitChunkContextPreamble } from "../stages/embedding-runtime.js";
import type { CommandRunner } from "../tools/runner.js";
import { isDocumentLevelFailure } from "../lib/document-failure.js";
import type { Document } from "../models.js";

describe("embedding input limits", () => {
  it("knows the context window of the models we host and defaults to a small one", () => {
    expect(embeddingInputTokenLimit("llm://transformers.js/Xenova/all-MiniLM-L6-v2")).toBe(256);
    expect(embeddingInputTokenLimit("llm://transformers.js/Xenova/paraphrase-multilingual-MiniLM-L12-v2")).toBe(128);
    expect(embeddingInputTokenLimit("llm://transformers.js/Xenova/bge-m3")).toBe(8192);
    expect(embeddingInputTokenLimit("llm://some/unknown-model")).toBe(512);
  });

  it("leaves room for the preamble in every chunk budget", () => {
    for (const uri of ["llm://transformers.js/Xenova/all-MiniLM-L6-v2", "llm://transformers.js/Xenova/gte-small"]) {
      const limit = embeddingInputTokenLimit(uri);
      expect(chunkTokenBudget(uri) + preambleReserveTokens(limit)).toBeLessThanOrEqual(limit);
    }
  });
});

describe("chunks plus preamble fit the model window", () => {
  const uri = "llm://transformers.js/Xenova/all-MiniLM-L6-v2";
  const limit = embeddingInputTokenLimit(uri);

  it.each([
    ["Russian", "Это длинное предложение для проверки размера фрагментов в токенах модели. ".repeat(60)],
    ["Japanese", "請求書の支払期限は来月末日です。お支払いは銀行振込でお願いします。".repeat(60)],
    ["English", "Payment is due thirty days after the invoice date unless agreed otherwise. ".repeat(60)],
  ])("markdown chunks of %s text with a long preamble never exceed the window", (_name, text) => {
    const { texts, headingPaths } = buildChunks(text, "fallback", { maxTokens: chunkTokenBudget(uri) });
    expect(texts.length).toBeGreaterThan(1);
    for (const [index, chunk] of texts.entries()) {
      const preamble = fitChunkContextPreamble({
        documentTitle: "Quarterly contract amendment between the parties.pdf",
        documentContext: "This agreement amends the master services agreement and sets payment terms, penalties and renewal rules.",
        headingPath: headingPaths[index],
        pageNumbers: [1, 2, 3],
      }, chunk, limit);
      expect(estimateTokens(`${preamble}\n\n${chunk}`)).toBeLessThanOrEqual(limit);
    }
  });

  it("canonical chunks respect the token budget and keep every character", () => {
    const text = "# Contract\n\n" + "Сумма платежа определяется приложением и подлежит оплате в срок. ".repeat(80);
    const document = buildCanonicalDocumentFromMarkdown({ documentId: "d", text, pageCount: 1, extractor: "test" });
    const chunks = buildCanonicalChunksFromDocument(document, "fallback", { maxTokens: chunkTokenBudget(uri) });
    expect(chunks.length).toBeGreaterThan(3);
    for (const chunk of chunks) expect(estimateTokens(chunk.text)).toBeLessThanOrEqual(chunkTokenBudget(uri));
    const body = text.split("\n\n")[1]!.trim();
    expect(chunks.slice(1).map((chunk) => chunk.text).join(" ").replace(/\s+/g, " ")).toContain(body.slice(0, 40));
  });

  it("shortens the preamble before it can push the chunk past the window", () => {
    const rawText = "слово ".repeat(Math.floor(limit * 0.3));
    const preamble = fitChunkContextPreamble({
      documentTitle: "T".repeat(300),
      documentContext: "context ".repeat(30),
      headingPath: ["A", "B"],
      pageNumbers: [4],
    }, rawText, limit);
    expect(estimateTokens(`${preamble}\n\n${rawText}`)).toBeLessThanOrEqual(limit);
    expect(preamble).not.toContain("Context:");
  });

  it("drops the preamble entirely when the chunk fills the window", () => {
    const rawText = "слово ".repeat(limit);
    expect(fitChunkContextPreamble({ documentTitle: "t", documentContext: "c" }, rawText, limit)).toBe("");
  });
});

describe("script and language metadata", () => {
  it("is derived from letters, never from an ASCII ratio", () => {
    expect(detectScript("The quick brown fox jumps over the lazy dog")).toBe("latin");
    expect(detectScript("Müller Gebühren Straße größer français café")).toBe("latin");
    expect(detectScript("Москва является столицей России")).toBe("cyrillic");
    expect(detectLanguage("請求書の支払期限は来月末日です。")).toBe("ja");
    expect(detectLanguage("东京是日本的首都，也是最大的城市。")).toBe("zh");
    expect(detectLanguage("1234 5678")).toBe("und");
  });
});

describe("a recorded artifact that cannot be read", () => {
  const document = { id: "doc", userId: "u", runId: "r", filename: "report.csv", mimeType: "text/csv", sourceKey: "u/source/report.csv", pageCount: 1 } as unknown as Document;
  const runner = { extractText: () => { throw new Error("must not re-extract"); }, extractMarkdown: () => { throw new Error("must not re-extract"); } } as unknown as CommandRunner;

  it("fails with a retryable error instead of re-extracting the raw bytes", async () => {
    const getBytes = vi.fn(async (key: string) => {
      if (key.startsWith("markdown/")) throw new Error("socket hang up");
      return Buffer.from("a;b\n1;2\n");
    });
    const storage = { getBytes, bucket: "bucket" } as never;
    const error = await extractTextForEmbedding(document, runner, storage, "s3://bucket/markdown/doc.md", undefined, undefined).catch((e) => e);
    expect(error).toBeInstanceOf(ArtifactReadError);
    expect(error.retryable).toBe(true);
    expect(getBytes).not.toHaveBeenCalledWith(document.sourceKey);
  });

  it("does not fall back to the source when the redacted markdown is not valid UTF-8", async () => {
    const getBytes = vi.fn(async () => Buffer.from([0xff, 0xfe, 0xfd]));
    const storage = { getBytes, bucket: "bucket" } as never;
    await expect(extractTextForEmbedding(document, runner, storage, "s3://bucket/markdown/doc.md", undefined, undefined)).rejects.toBeInstanceOf(ArtifactReadError);
  });

  it("rejects an unreadable canonical artifact instead of indexing without it", async () => {
    const getBytes = vi.fn(async () => Buffer.from("text"));
    const getJson = vi.fn(async () => { throw new Error("Unexpected token { in JSON"); });
    const storage = { getBytes, getJson, bucket: "bucket" } as never;
    await expect(extractTextForEmbedding(document, runner, storage, "s3://bucket/markdown/doc.md", undefined, "s3://bucket/canonical/doc.json")).rejects.toBeInstanceOf(ArtifactReadError);
  });

  it("refuses an artifact in another bucket before any storage call, in the URI, a manifest and the canonical artifact", async () => {
    const getBytes = vi.fn(async () => Buffer.from(JSON.stringify({ textArtifactUri: "s3://other-tenant-bucket/markdown/doc.md" })));
    const getJson = vi.fn(async () => ({}));
    const storage = { getBytes, getJson, bucket: "bucket" } as never;

    const direct = await extractTextForEmbedding(document, runner, storage, "s3://other-bucket/markdown/doc.md", undefined, undefined).catch((e) => e);
    expect(direct).toBeInstanceOf(ArtifactReadError);
    expect(direct).toMatchObject({ kind: "outside-bucket", retryable: false });
    expect(getBytes).not.toHaveBeenCalled();

    // A manifest in our bucket that points at another bucket.
    const nested = await extractTextForEmbedding(document, runner, storage, "s3://bucket/markdown/doc.json", undefined, undefined).catch((e) => e);
    expect(nested).toMatchObject({ kind: "outside-bucket", retryable: false, artifactUri: "s3://other-tenant-bucket/markdown/doc.md" });
    expect(getBytes).toHaveBeenCalledTimes(1);

    const canonical = await extractTextForEmbedding(document, runner, storage, "s3://bucket/markdown/doc.md", undefined, "s3://other-bucket/canonical/doc.json").catch((e) => e);
    expect(canonical).toMatchObject({ kind: "outside-bucket" });
    expect(getJson).not.toHaveBeenCalled();
  });

  it("refuses keys that climb out of the artifact tree", async () => {
    const getBytes = vi.fn(async () => Buffer.from("text"));
    const storage = { getBytes, bucket: "bucket" } as never;
    for (const uri of ["s3://bucket/../other-user/run/markdown/doc.md", "s3://bucket/a/%2e%2e/../b.md", "../x.md", "s3://bucket//absolute.md"]) {
      await expect(extractTextForEmbedding(document, runner, storage, uri, undefined, undefined)).rejects.toMatchObject({ kind: "outside-bucket", retryable: false });
    }
    expect(getBytes).not.toHaveBeenCalled();
  });

  it("classifies a missing or malformed artifact as permanent and a failed read as retryable", async () => {
    const noSuchKey = Object.assign(new Error("The specified key does not exist."), { name: "NoSuchKey", $metadata: { httpStatusCode: 404 } });
    const missing = await extractTextForEmbedding(document, runner, { getBytes: async () => { throw noSuchKey; }, bucket: "bucket" } as never, "s3://bucket/markdown/doc.md", undefined, undefined).catch((e) => e);
    expect(missing).toMatchObject({ kind: "missing", retryable: false });
    expect(missing.message).toContain("not retryable");
    const notUtf8 = await extractTextForEmbedding(document, runner, { getBytes: async () => Buffer.from([0xff, 0xfe]), bucket: "bucket" } as never, "s3://bucket/markdown/doc.md", undefined, undefined).catch((e) => e);
    expect(notUtf8).toMatchObject({ kind: "invalid", retryable: false });
    const badSchema = await extractTextForEmbedding(document, runner, { getBytes: async () => Buffer.from("text"), getJson: async () => ({ blocks: "nope" }), bucket: "bucket" } as never, "s3://bucket/markdown/doc.md", undefined, "s3://bucket/canonical/doc.json").catch((e) => e);
    expect(badSchema).toMatchObject({ kind: "invalid", retryable: false });
    const slow = await extractTextForEmbedding(document, runner, { getBytes: async () => { throw new Error("503 Service Unavailable"); }, bucket: "bucket" } as never, "s3://bucket/markdown/doc.md", undefined, undefined).catch((e) => e);
    expect(slow).toMatchObject({ kind: "storage", retryable: true });
  });

  it("fails the document for a permanent read error and reruns the stage for a transient one", () => {
    expect(isDocumentLevelFailure(new ArtifactReadError("s3://bucket/a.md", "gone", { kind: "missing" }))).toBe(true);
    expect(isDocumentLevelFailure(new ArtifactReadError("s3://bucket/a.md", "503", { kind: "storage" }))).toBe(false);
    expect(isDocumentLevelFailure(new Error("outer", { cause: new ArtifactReadError("s3://bucket/a.md", "other bucket", { kind: "outside-bucket" }) }))).toBe(true);
  });

  it("returns the artifact text in NFC", async () => {
    const storage = { getBytes: async () => Buffer.from("Müller"), bucket: "bucket" } as never;
    const result = await extractTextForEmbedding(document, runner, storage, "s3://bucket/markdown/doc.md", undefined, undefined);
    expect(result.text).toBe("Müller");
  });

  it("treats an artifact that read as empty as an empty document", async () => {
    const storage = { getBytes: async () => Buffer.from("  \n"), bucket: "bucket" } as never;
    const result = await extractTextForEmbedding(document, runner, storage, "s3://bucket/markdown/doc.md", undefined, undefined);
    expect(result.text.trim()).toBe("");
  });
});
