import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { connect } from "@lancedb/lancedb";
import { expect, it, vi } from "vitest";
import { lanceDbVectorSearch, resetLanceDbConnectionForTests } from "../search/lancedb.js";
import { VectorNamespaceManager } from "@docslurp/shared";

const require = createRequire(import.meta.url);
const lanceEntry = require.resolve("@lancedb/lancedb");
const arrow = require(require.resolve("apache-arrow", { paths: [lanceEntry] }));
const embedding = require(path.join(path.dirname(lanceEntry), "embedding/index.js"));
const registry = require(path.join(path.dirname(lanceEntry), "embedding/registry.js"));

it("refuses populated provider metadata through actual scoped server search", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lance-metadata-"));
  const constructors = vi.fn(() => { throw new Error("FORBIDDEN_CONSTRUCTOR"); });
  const network = vi.fn(() => { throw new Error("FORBIDDEN_NETWORK"); });
  const loader = vi.fn(() => { throw new Error("FORBIDDEN_CODE_LOADER"); });
  const r = embedding.getRegistry();
  const providers = [
    ["openai", require(path.join(path.dirname(lanceEntry), "embedding/openai.js")).OpenAIEmbeddingFunction],
    ["huggingface", require(path.join(path.dirname(lanceEntry), "embedding/transformers.js")).TransformersEmbeddingFunction],
  ] as const;
  for (const [name, ctor] of providers) {
    // Wrap the installed built-ins, preserving their prototypes; no synthetic provider.
    r.setBuiltIn(name, new Proxy(ctor, { construct: constructors }));
  }
  const spies = [
    vi.spyOn(globalThis, "fetch").mockImplementation(network),
    vi.spyOn(require("node:http"), "request").mockImplementation(network),
    vi.spyOn(require("node:https"), "request").mockImplementation(network),
    vi.spyOn(require("node:net").Socket.prototype, "connect").mockImplementation(network),
    vi.spyOn(providers[1][1].prototype, "init").mockImplementation(loader),
  ];
  try {
    const cases = ["{", "[]", ...["unknown", "openai", "huggingface"].map(name => JSON.stringify([{
      name, sourceColumn: "text", vectorColumn: "vector",
      model: { apiKey: "fake", baseURL: "http://169.254.169.254", model: "https://example.invalid/model", trust_remote_code: true },
    }]))];
    for (const [index, metadata] of cases.entries()) {
      const location = VectorNamespaceManager.getEmbeddingLocation(dir,"org",`ws-${index}`,"model",2);
      const db = await connect(location.uri);
      const name = location.table;
      const schema = new arrow.Schema([
        new arrow.Field("id", new arrow.Utf8()), new arrow.Field("text", new arrow.Utf8()),
        new arrow.Field("vector", new arrow.FixedSizeList(2, new arrow.Field("item", new arrow.Float32()))),
      ], new Map([["embedding_functions", metadata]]));
      const fixture = await db.createEmptyTable(name, schema);
      const {makeArrowTable} = require(path.join(path.dirname(lanceEntry), "arrow.js"));
      const records = makeArrowTable([{id:"existing",text:"persisted",vector:[1,0]}], {schema});
      const bytes = Buffer.from(await arrow.RecordBatchFileWriter.writeAll(records).toUint8Array());
      await Reflect.get(fixture, "inner").add(bytes,"append");
      expect(await fixture.countRows()).toBe(1);
      fixture.close();
      db.close();
      const reopened = await connect(location.uri);
      const table = await reopened.openTable(name);
      expect((await table.schema()).metadata.get("embedding_functions")).toBe(metadata);
      table.close(); reopened.close();
      process.env.LANCEDB_URI=dir;
      expect(await lanceDbVectorSearch({orgId:"org",workspaceId:`ws-${index}`,embeddingModel:"model",queryVector:[1,0],limit:3,documentIds:["doc"]})).toEqual([]);
      resetLanceDbConnectionForTests();
    }
    expect(constructors).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
    expect(loader).not.toHaveBeenCalled();
  } finally {
    resetLanceDbConnectionForTests();
    delete process.env.LANCEDB_URI;
    spies.forEach(spy => spy.mockRestore());
    for (const [name, ctor] of providers) r.setBuiltIn(name, ctor);
    registry.getRegistry().reset();
    await rm(dir, { recursive: true, force: true });
  }
});
