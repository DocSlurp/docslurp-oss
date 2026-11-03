import {fork} from "node:child_process";
import {once} from "node:events";
import {randomUUID} from "node:crypto";
import {Pool} from "pg";
import {expect,it,vi} from "vitest";
import {createNativeChatHost} from "./native-host.js";
import {readNativeOperationOutput} from "./operation-delivery.js";
const url=process.env.NATIVE_CHAT_TEST_DATABASE_URL;
const redis=process.env.NATIVE_CHAT_TEST_REDIS_URL;
it.runIf(!!url&&!!redis)("retains accepted output after SIGKILL and native lease expiry without replaying paid execution",async()=>{
  if(new URL(url!).hostname!=="127.0.0.1"||new URL(redis!).hostname!=="127.0.0.1")throw new Error("loopback fixture only");
  const pool=new Pool({connectionString:url,max:3});
  const namespace=`native-crash:${randomUUID()}`;
  const producer=await createNativeChatHost({pool,redisUrl:redis!,namespace,worker:false});
  let recovered:Awaited<ReturnType<typeof createNativeChatHost>>|undefined;
  const child=fork(new URL("./fixtures/crashing-worker.ts",import.meta.url),[],{
    execArgv:["--import","tsx"],env:{...process.env,NATIVE_CRASH_NAMESPACE:namespace},
    stdio:["ignore","ignore","pipe","ipc"]});
  const messages:any[]=[];let stderr="";
  child.on("message",message=>messages.push(message));
  child.stderr?.on("data",data=>{stderr+=String(data);});
  try {
    await vi.waitFor(()=>expect(messages.some(m=>m.ready),stderr).toBe(true),{timeout:10000});
    const id=randomUUID();
    const {task}=await producer.mastra.backgroundTaskManager!.enqueue({agentId:"crash-fixture",runId:id,
      toolCallId:id,toolName:"crashFixture",args:{operationId:id},resourceId:"fixture",maxRetries:0,timeoutMs:600000});
    await vi.waitFor(()=>expect(messages.some(m=>m.taskId===task.id),stderr).toBe(true),{timeout:10000});
    const before=await producer.mastra.backgroundTaskManager!.getTask(task.id);
    const exited=once(child,"exit");child.kill("SIGKILL");await exited;
    expect((await readNativeOperationOutput(producer.pubsub,before!,0)).snapshot.text).toBe("durably accepted before crash");
    // Real elapsed native lease time; no SQL clock mutation or fake task state.
    await new Promise(resolve=>setTimeout(resolve,Math.max(0,before!.leaseExpiresAt!.getTime()-Date.now())+250));
    let restarts=0;
    recovered=await createNativeChatHost({pool,redisUrl:redis!,namespace,worker:true,
      configureBackgroundTasks(manager){manager.registerStaticExecutor("crashFixture",{async execute(){restarts++;return {};}});}});
    await vi.waitFor(async()=>expect((await recovered!.mastra.backgroundTaskManager!.getTask(task.id))?.status).toBe("failed"),{timeout:10000});
    const final=(await recovered.mastra.backgroundTaskManager!.getTask(task.id))!;
    expect(final.error?.message).toMatch(/terminated|interrupted/i);
    expect(restarts).toBe(0);expect(final.retryCount).toBe(0);
    expect((await readNativeOperationOutput(recovered.pubsub,final,0)).snapshot).toMatchObject({text:"durably accepted before crash",error:"failed"});
  } finally {child.kill("SIGKILL");await recovered?.close();await producer.close();await pool.end();}
},65000);
