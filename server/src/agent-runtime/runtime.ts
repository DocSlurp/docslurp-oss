import { sql } from "../db.js";
import { Pool } from "pg";
import { env } from "../config.js";
import type { RequestActor } from "../lib/request-actor.js";
import { createNativeChatHost } from "./native-host.js";
import { NativeOperations } from "./native-operations.js";
import { createNativeOperationPolicy } from "./operation-policy.js";
import { createProjectChatExecutor } from "./project-chat-executor.js";
import { durableRedisUrl } from "./durability-policy.js";

let producer: Promise<Awaited<ReturnType<typeof createRuntime>>> | undefined;
async function createRuntime(worker: boolean) {
  const redisUrl=durableRedisUrl(process.env);
  const pool=new Pool({connectionString:env.databaseUrl,max:4,connectionTimeoutMillis:1000,
    statement_timeout:4000,query_timeout:4500,idle_in_transaction_session_timeout:4000});
  try {
    const host=await createNativeChatHost({pool,redisUrl,worker,namespace:process.env.MASTRA_NAMESPACE,
      configureBackgroundTasks: worker ? (manager,pubsub)=>manager.registerStaticExecutor(
        "docslurpProjectChat",createProjectChatExecutor(manager,pubsub)) : undefined});
    return {...host,async close(){await host.close();await pool.end();}};
  } catch(error){await pool.end();throw error;}
}
export function nativeChatRuntime() {
  if (producer) return producer;
  const attempt = createRuntime(false);
  producer = attempt;
  // Release only the failed initialization, never retry accepted model work.
  // Identity guards keep an old rejection from clearing a newer host.
  void attempt.catch(() => { if (producer === attempt) producer = undefined; });
  return attempt;
}
export async function nativeOperations(resolveActor:()=>Promise<RequestActor|null>) {
  const host=await nativeChatRuntime();
  return new NativeOperations(host.mastra.backgroundTaskManager!,host.pubsub,createNativeOperationPolicy(resolveActor));
}
export async function runNativeChatWorker(signal:AbortSignal) {
  if(process.env.DOCSLURP_DURABLE_CHAT!=="1")throw new Error("durable_chat_not_enabled");
  const host=await createRuntime(true);
  // Application identity retention only; native manager cleanup owns task/result
  // lifecycle. This does not claim, retry or execute anything.
  const cleanup=async()=>{await sql`delete from chat_operations where id in (
    select id from chat_operations where runtime='mastra' and expires_at<clock_timestamp() order by expires_at limit 256)`;};
  let cleaning=false;
  const timer=setInterval(()=>{
    if(cleaning)return;cleaning=true;
    void cleanup().catch(()=>{}).finally(()=>{cleaning=false;});
  },3600000);
  timer.unref();
  try {
    await cleanup();
    console.info("[native-chat] worker_ready");
    if(!signal.aborted)await new Promise<void>(resolve=>signal.addEventListener("abort",()=>resolve(),{once:true}));
  } finally {clearInterval(timer);await host.close();}
}

export async function closeNativeChatRuntime(){const current=producer;producer=undefined;await (await current)?.close();}
