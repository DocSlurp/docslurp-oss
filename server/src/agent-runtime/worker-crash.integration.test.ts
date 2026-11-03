import {fork} from "node:child_process";
import {once} from "node:events";
import {randomUUID} from "node:crypto";
import {Pool} from "pg";
import {expect,it,vi} from "vitest";
import {createNativeChatHost} from "./native-host.js";
import {readNativeOperationOutput} from "./operation-delivery.js";
const url=process.env.NATIVE_CHAT_TEST_DATABASE_URL;
const redis=process.env.NATIVE_CHAT_TEST_REDIS_URL;
it.runIf(!!url&&!!redis).each(["SIGKILL", "SIGTERM"] as const)("retains accepted output after %s with an already-running survivor and no paid retry",async(signal)=>{
  if(new URL(url!).hostname!=="127.0.0.1"||new URL(redis!).hostname!=="127.0.0.1")throw new Error("loopback fixture only");
  const pool=new Pool({connectionString:url,max:3});
  const namespace=`native-crash:${randomUUID()}`;
  const producer=await createNativeChatHost({pool,redisUrl:redis!,namespace,worker:false});
  let recovered:Awaited<ReturnType<typeof createNativeChatHost>>|undefined;
  let restarts=0;
  recovered=await createNativeChatHost({pool,redisUrl:redis!,namespace,worker:true,
    configureBackgroundTasks(manager){manager.registerStaticExecutor("crashFixture",{async execute(){restarts++;return {};}});}});
  // Survivor completes its empty startup scan before the future owner exists.
  await recovered.mastra.backgroundTaskManager!.init(recovered.pubsub);
  const child=fork(new URL("./fixtures/crashing-worker.ts",import.meta.url),[],{
    execArgv:["--import","tsx"],env:{...process.env,NATIVE_CRASH_NAMESPACE:namespace},
    stdio:["ignore","ignore","pipe","ipc"]});
  const messages:any[]=[];let stderr="";
  child.on("message",message=>messages.push(message));
  child.stderr?.on("data",data=>{stderr+=String(data);});
  try {
    await vi.waitFor(()=>expect(messages.some(m=>m.ready),stderr).toBe(true),{timeout:10000});
    const id=randomUUID();
    child.send({start:id});
    await vi.waitFor(()=>expect(messages.some(m=>m.taskId),stderr).toBe(true),{timeout:10000});
    const task={id:messages.find(m=>m.taskId).taskId as string};
    // Several recovery ticks must leave a live owner alone.
    await new Promise(resolve=>setTimeout(resolve,4200));
    expect((await producer.mastra.backgroundTaskManager!.getTask(task.id))?.status).toBe("running");
    expect(messages.filter(m=>m.taskId===task.id)).toHaveLength(1);
    const before=await producer.mastra.backgroundTaskManager!.getTask(task.id);
    const exited=once(child,"exit");child.kill(signal);await exited;
    expect((await readNativeOperationOutput(producer.pubsub,before!,0)).snapshot.text).toBe("durably accepted before crash");
    await vi.waitFor(async()=>expect(["failed","cancelled"]).toContain((await recovered!.mastra.backgroundTaskManager!.getTask(task.id))?.status),{timeout:40000});
    const final=(await recovered.mastra.backgroundTaskManager!.getTask(task.id))!;
    expect(final.status).toBe(signal==="SIGTERM"?"cancelled":"failed");
    if(signal==="SIGKILL")expect(final.error?.message).toMatch(/terminated|interrupted/i);
    expect(restarts).toBe(0);expect(final.retryCount).toBe(0);
    expect((await readNativeOperationOutput(recovered.pubsub,final,0)).snapshot).toMatchObject({text:"durably accepted before crash",error:final.status});
  } finally {child.kill("SIGKILL");await recovered?.close();await producer.close();await pool.end();}
},65000);
