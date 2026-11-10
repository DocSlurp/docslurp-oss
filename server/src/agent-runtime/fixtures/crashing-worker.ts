/** Local integration child. No model/tool provider is called. */
import {Pool} from "pg";
import {createNativeChatHost} from "../native-host.js";
import {publishOperationOutput} from "../operation-delivery.js";
const url=process.env.NATIVE_CHAT_TEST_DATABASE_URL!;
const redis=process.env.NATIVE_CHAT_TEST_REDIS_URL!;
if(new URL(url).hostname!=="127.0.0.1"||new URL(redis).hostname!=="127.0.0.1")throw new Error("loopback fixture only");
const pool=new Pool({connectionString:url,max:2});
const host=await createNativeChatHost({pool,redisUrl:redis,namespace:process.env.NATIVE_CRASH_NAMESPACE!,worker:true,
  configureBackgroundTasks(manager,pubsub){
    manager.registerStaticExecutor("crashFixture",{async execute(args, options){
      const tasks=await manager.listTasks({toolCallId:String(args.operationId),perPage:2});
      const task=tasks.tasks[0]!;
      await publishOperationOutput(pubsub,task.id,{kind:"text",payload:{text:"durably accepted before crash"}});
      process.send?.({taskId:task.id,leaseExpiresAt:task.leaseExpiresAt});
      await new Promise<void>((resolve)=>{ options?.abortSignal?.addEventListener("abort",()=>resolve(),{once:true}); });
      throw new Error("Worker shutdown interrupted execution");
    }});
  }});
process.on("message", async (message: {start?: string}) => {
  if (!message.start) return;
  const id=message.start;
  await host.mastra.backgroundTaskManager!.enqueue({agentId:"docslurp-project-chat",runId:id,toolCallId:id,
    toolName:"crashFixture",args:{operationId:id},resourceId:"fixture",maxRetries:0,timeoutMs:600000},{executor:host.mastra.backgroundTaskManager!.getStaticExecutor("crashFixture")!},{pinToWorker:true});
});
process.send?.({ready:true});
process.on("SIGTERM",()=>{void host.close().then(()=>pool.end()).then(()=>process.exit(0));});
