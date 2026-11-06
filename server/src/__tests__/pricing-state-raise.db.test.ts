import { Client } from "pg";
import { afterAll, expect, it } from "vitest";

// Real Postgres (scripts/run-database-tests.mjs gives each file a fresh migrated database, connected as its owner):
// concurrent pricing_state_raise calls to one value, each on its own connection, so they really race (council K #6).
const url = process.env.PRICING_STATE_TEST_DATABASE_URL;
const clients: Client[] = [];
afterAll(async () => { await Promise.all(clients.map((client) => client.end().catch(() => {}))); });
async function connect() { const client = new Client({ connectionString: url }); await client.connect(); clients.push(client); return client; }

async function race(key: string, value: bigint, racers = 8) {
  const connections = await Promise.all(Array.from({ length: racers }, connect));
  const results = await Promise.allSettled(connections.map((client) => client.query("select pricing_state_raise($1, $2::bigint)::text as value", [key, value.toString()])));
  return {
    won: results.filter((result) => result.status === "fulfilled").map((result) => (result as PromiseFulfilledResult<{ rows: Array<{ value: string }> }>).value.rows[0]!.value),
    lost: results.filter((result) => result.status === "rejected").map((result) => String((result as PromiseRejectedResult).reason)),
  };
}

it.skipIf(!url)("of concurrent raises to one value exactly one succeeds: seeding a missing key, then raising it", async () => {
  for (let round = 0; round < 5; round++) {
    const key = `race.${round}`;
    const seeded = await race(key, 7n);
    expect(seeded.won).toEqual(["7"]);
    for (const reason of seeded.lost) expect(reason).toMatch(/not above the stored value 7/);
    const raised = await race(key, 8n);
    expect(raised.won).toEqual(["8"]);
    for (const reason of raised.lost) expect(reason).toMatch(/not above the stored value 8/);
    const reader = await connect();
    expect((await reader.query("select value::text as value from pricing_provider_state where key = $1", [key])).rows[0].value).toBe("8");
  }
}, 30_000);
