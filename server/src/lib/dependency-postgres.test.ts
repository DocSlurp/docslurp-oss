import { afterAll, expect, it, vi } from "vitest";
import postgres from "postgres";
import { initializeObservability, shutdownObservability, instrumentPostgres } from "@docslurp/shared/observability";

vi.stubEnv("OTEL_ENABLED", "true");
vi.stubEnv("LANGFUSE_ENABLED", "false");
const spans: Array<{ name: string; attributes: Record<string, unknown> }> = [];
initializeObservability({ spanProcessors: [{ onStart() {}, onEnd(span) { spans.push(span); }, async shutdown() {}, async forceFlush() {} }] });
afterAll(async () => { await shutdownObservability(); vi.unstubAllEnvs(); });

it.skipIf(!process.env.GRAPH_PURGE_TEST_DATABASE_URL)("preserves lazy queries, fragments, transactions, cursors and SQL errors", async () => {
  const url = process.env.GRAPH_PURGE_TEST_DATABASE_URL!;
  const sql = instrumentPostgres(postgres(url, { max: 2 }), url);
  try {
    const query = sql`select ${42}::int as answer`;
    expect(spans).toHaveLength(0);
    const result = await query;
    expect(result[0]!.answer).toBe(42);
    expect(await query).toBe(result);
    expect(spans.filter(span => span.name === "postgres.SELECT")).toHaveLength(1);
    const rows = await sql.begin(tx => [tx`select ${1}::int as n`, tx`select ${2}::int as n`]);
    expect(rows.map(row => row[0]!.n)).toEqual([1, 2]);
    const nested = await sql.begin(async tx => tx.savepoint(async nested => (await nested`select ${3}::int as n`)[0]!.n));
    expect(nested).toBe(3);
    const fragment = sql`where n = ${2}`;
    expect((await sql`select n from generate_series(1, 3) n ${fragment}`)[0]!.n).toBe(2);
    expect((await sql.unsafe("select $1::int as n", [7]))[0]!.n).toBe(7);
    const cursor: number[] = [];
    for await (const rows of sql`select n from generate_series(1, 5) n`.cursor(2)) cursor.push(...rows.map(row => row.n));
    expect(cursor).toEqual([1, 2, 3, 4, 5]);
    const reserved = await sql.reserve();
    try { expect((await reserved`select 8 as n`)[0]!.n).toBe(8); } finally { reserved.release(); }
    await expect(sql`select 1/0`).rejects.toMatchObject({ code: "22012" });
    expect(spans.some(span => span.attributes["db.response.status_code"] === "22012")).toBe(true);
    expect(spans.filter(span => span.name === "postgres.begin")).toHaveLength(2);
  } finally { await sql.end({ timeout: 1 }); }
});
