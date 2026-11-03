/** Local process fixture: never invokes a paid provider. */
import { Pool, type PoolClient } from "pg";
import { createNativeChatHost } from "../native-host.js";
const pool = new Pool({ connectionString: process.env.NATIVE_CHAT_TEST_DATABASE_URL, max: 1, connectionTimeoutMillis: 500 });
const held: PoolClient[] = [];
const host = await createNativeChatHost({ pool, redisUrl: process.env.NATIVE_CHAT_TEST_REDIS_URL!,
  namespace: process.env.NATIVE_CRASH_NAMESPACE!, worker: true });
await host.mastra.backgroundTaskManager!.init(host.pubsub);
process.on("message", async (message: { exhaust?: boolean }) => {
  if (message.exhaust) { held.push(await pool.connect()); process.send?.({ exhausted: true }); }
});
process.once("SIGTERM", () => {
  const began = Date.now();
  void host.close().then(async () => {
    for (const client of held) client.release();
    await pool.end();
    process.send?.({ closedMs: Date.now() - began });
    process.exit(0);
  }).catch(error => { process.send?.({ error: String(error) }); process.exit(1); });
});
process.send?.({ ready: true });
