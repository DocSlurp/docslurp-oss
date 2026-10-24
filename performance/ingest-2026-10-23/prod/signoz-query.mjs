// Usage: node signoz-query.mjs "<clickhouse sql>"  (read-only; key read from app .env, never printed)
import { readFileSync } from "node:fs";
const env = readFileSync("/home/dan/code/17th-street-labs/docslurp-app/.env", "utf8");
const key = /^SIGNOZ_API_KEY=(.*)$/m.exec(env)?.[1]?.replace(/^["']|["']$/g, "");
const sql = process.argv[2];
const now = Date.now();
const body = {
  schemaVersion: "v1", start: now - 7 * 86400e3, end: now, requestType: "raw",
  compositeQuery: { queries: [{ type: "clickhouse_sql", spec: { name: "A", query: sql, disabled: false } }] },
  formatOptions: { formatTableResultForUI: false, fillGaps: false },
};
const r = await fetch("http://127.0.0.1:18082/api/v5/query_range", {
  method: "POST", headers: { "content-type": "application/json", "SIGNOZ-API-KEY": key }, body: JSON.stringify(body) });
const t = await r.text(); if (process.env.RAW) console.error(t.slice(0,1500));
if (!r.ok) { console.error(r.status, t.slice(0, 600)); process.exit(1); }
const j = JSON.parse(t);
const res = j.data?.data?.results?.[0] ?? j.data?.results?.[0] ?? j;
const rows = (res.rows ?? []).map((r) => r.data ?? r);
const cols = rows.length ? Object.keys(rows[0]) : [];
console.log(cols.join("\t"));
for (const row of rows) console.log(cols.map((c) => row[c]).join("\t"));
