/** Process-cold index read diagnostic on local copies. No live mutation.
 * Read bytes are /proc/self/io rchar, not physical storage I/O or S3 traffic.
 */
import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as lance from "@lancedb/lancedb";
import { lanceDbQueryTuning } from "@docslurp/shared/lancedb-query-tuning";
const { values } = parseArgs({ options: { database: { type: "string" }, table: { type: "string" }, source: { type: "string" }, "source-table": { type: "string" }, tuned: { type: "boolean", default: false }, probes: { type: "string", default: "32" } } });
if (!values.database || !values.table || !values.source || !values["source-table"] || [values.database, values.source].some((p) => /:\/\//.test(p))) throw new Error("Require local --database --table --source --source-table");
const sourceDb = await lance.connect(resolve(values.source));
const source = await sourceDb.openTable(values["source-table"]);
const count = await source.countRows();
const row = (await source.query().select(["vector"]).offset(Math.floor(count / 256)).limit(1).toArray())[0]!;
const vector = Array.from(row.vector as Iterable<number>);
source.close(); sourceDb.close();
const db = await lance.connect(resolve(values.database));
const rchar = () => Number(/rchar: (\d+)/.exec(readFileSync("/proc/self/io", "utf8"))![1]);
const before = rchar();
const started = performance.now();
const table = await db.openTable(values.table);
let query = table.vectorSearch(vector).distanceType("l2").limit(10).select(["id", "_distance"]);
if (values.tuned) { const policy = lanceDbQueryTuning(10, 0); query = query.ef(policy.ef).refineFactor(policy.refineFactor).nprobes(Number(values.probes)); }
const results = await query.toArray();
const ms = performance.now() - started;
const bytes = rchar() - before;
if (results.length !== 10) throw new Error("Cold query did not complete useful work");
console.log(JSON.stringify({ arm: values.table, rows: count - 64, results: results.length, rcharBytes: bytes, ms, rssBytes: process.memoryUsage().rss }));
table.close(); db.close();
