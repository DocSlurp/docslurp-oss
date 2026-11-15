/** Explicit, project-scoped index-only maintenance. Dry run unless --apply.
 * Load deployment credentials through the usual environment mechanism.
 */
import { parseArgs } from "node:util";
import { resolveLanceDbConfig } from "@docslurp/shared";
import { connectLanceDb } from "../src/stages/lancedb-connection.js";
import { rebuildVectorIndex, vectorReindexLocation } from "../src/stages/lancedb-vector-reindex.js";

const { values } = parseArgs({ options: {
  org: { type: "string" }, project: { type: "string" }, model: { type: "string" }, dimensions: { type: "string" },
  // A catalogued old embedding space may predate lossless model-name encoding.
  uri: { type: "string" }, "max-rows": { type: "string", default: "100000" }, apply: { type: "boolean", default: false },
} });
if (!values.org || !values.project || !values.model || !values.dimensions) throw new Error("Require --org --project --model --dimensions; optional --uri for a catalogued legacy space");
const config = resolveLanceDbConfig();
const location = vectorReindexLocation(config.root, { org: values.org, project: values.project, model: values.model, dimensions: Number(values.dimensions), uri: values.uri });
const db = await connectLanceDb(location.uri);
try {
  const table = await db.openTable(location.table);
  try {
    const options = { apply: false, maxRows: Number(values["max-rows"]), dimensions: Number(values.dimensions) };
    const plan = await rebuildVectorIndex(table, options);
    if (plan.dimensions !== Number(values.dimensions)) throw new Error("Requested dimension does not match this index's vectors");
    console.log(JSON.stringify(values.apply ? await rebuildVectorIndex(table, { ...options, apply: true }) : plan));
  }
  finally { table.close(); }
} finally { db.close(); }
