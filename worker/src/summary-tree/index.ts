/*
 * Summary tree: LLM summaries of contiguous sections inside one long document, one root per document.
 * This folder is the pure logic (leaf selection, grouping, hashing, reuse planning, the summary contract,
 * the coverage check and the text artifact format). It has no database access and makes no model call.
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
