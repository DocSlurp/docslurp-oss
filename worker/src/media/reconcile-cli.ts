import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import postgres from "postgres";
import { reconcileMediaReceipt, type ReconciliationEvidence } from "./reconcile.js";
const {values}=parseArgs({options:{receipt:{type:"string"},evidence:{type:"string"},apply:{type:"boolean",default:false}}});
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL required");
const sql=postgres(process.env.DATABASE_URL,{max:1,prepare:false});
try {
  if (!values.receipt) {
    const rows=await sql`select id,provider,model,status,cost_state,created_at,accounting->>'providerRequestId' as provider_request_id
      from remote_media_jobs where cost_state in ('unknown','disputed') or status='uncertain' order by created_at limit 100`;
    console.log(JSON.stringify(rows,null,2));
  } else {
    if (!values.evidence) throw new Error("--evidence JSON file required; default is dry-run");
    const evidence=JSON.parse(await readFile(values.evidence,"utf8")) as ReconciliationEvidence;
    console.log(JSON.stringify(await reconcileMediaReceipt(sql,values.receipt,evidence,values.apply)));
  }
} finally { await sql.end(); }
