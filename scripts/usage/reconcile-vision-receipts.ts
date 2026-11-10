/** Operator entrypoint. Uses tenant-scoped provider accounting; never changes customer credits. */
import postgres from "postgres";
import { reconcileVisionReceipts } from "../../worker/src/db/vision-receipt-reconciliation.js";

const [orgId, projectId, afterId] = process.argv.slice(2);
if (!orgId || !projectId || !process.env.DATABASE_URL || !process.env.OPENROUTER_API_KEY) {
  throw new Error("Usage: tsx scripts/usage/reconcile-vision-receipts.ts ORG_ID PROJECT_ID [AFTER_ID]; DATABASE_URL and OPENROUTER_API_KEY required");
}
const client = postgres(process.env.DATABASE_URL, { max: 1 });
try {
  console.log(JSON.stringify(await reconcileVisionReceipts({ client, orgId, projectId, afterId, apiKey: process.env.OPENROUTER_API_KEY })));
} finally {
  await client.end();
}
