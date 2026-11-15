/*
 * Summary tree: LLM summaries of contiguous sections inside one long document, one root per document.
 * Most of this folder is pure logic (leaf selection, grouping, hashing, reuse planning, the summary contract,
 * the coverage check and the text artifact format). `state-store.ts` is its Postgres side, `leaf-index.ts` reads
 * the embed artifact as a stream, and `build.ts` runs one document's build with the model and the embedder
 * injected: nothing here calls a model on its own.
 */
export * from "./limits.js";
export * from "./leaves.js";
export * from "./hash.js";
export * from "./grouping.js";
export * from "./vectors.js";
export * from "./reuse.js";
export * from "./summary.js";
export * from "./coverage.js";
export * from "./artifact.js";
export * from "./leaf-index.js";
export * from "./state-store.js";
export * from "./build.js";
