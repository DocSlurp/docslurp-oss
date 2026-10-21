import { Store } from "mppx/server";

import { sql as defaultSql, type SqlClient } from "../../db.js";

/** Rows untouched this long hold only expired challenges and replay markers. */
const RETENTION_DAYS = 30;

/**
 * mppx's shared atomic store on Postgres (migration 0067). mppx refuses Stripe
 * machine payments without one: replay claims for Tempo transfers must be seen
 * by every API instance. `update` serializes per key with a transaction-scoped
 * advisory lock, so it also covers keys that have no row yet.
 */
export function postgresMachinePaymentStore(client: SqlClient = defaultSql) {
  return Store.redis({
    async get(key: string) {
      const [row] = await client<{ value: string }[]>`select value from machine_payment_store where key = ${key}`;
      return row?.value ?? null;
    },
    async set(key: string, value: string) {
      await client`
        insert into machine_payment_store (key, value) values (${key}, ${value})
        on conflict (key) do update set value = excluded.value, updated_at = now()
      `;
    },
    async del(key: string) {
      await client`delete from machine_payment_store where key = ${key}`;
    },
    async update<result>(key: string, fn: (current: string | null) => Store.Change<string, result>): Promise<result> {
      return (await client.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(hashtextextended(${`machine_payment_store:${key}`}, 0))`;
        const [row] = await tx<{ value: string }[]>`select value from machine_payment_store where key = ${key}`;
        const change = fn(row?.value ?? null);
        if (change.op === "set") {
          await tx`
            insert into machine_payment_store (key, value) values (${key}, ${change.value})
            on conflict (key) do update set value = excluded.value, updated_at = now()
          `;
        } else if (change.op === "delete") {
          await tx`delete from machine_payment_store where key = ${key}`;
        }
        return change.result;
      })) as result;
    },
  });
}

/** Maintenance sweep: drop state no live challenge or replay window can still need. */
export async function sweepMachinePaymentStore(client: SqlClient = defaultSql): Promise<number> {
  const rows = await client`
    delete from machine_payment_store where updated_at < now() - make_interval(days => ${RETENTION_DAYS})
  `;
  return rows.count;
}
