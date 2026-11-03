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
    manager.registerStaticExecutor("crashFixture",{async execute(args){
      const tasks=await manager.listTasks({toolCallId:String(args.operationId),perPage:2});
      const task=tasks.tasks[0]!;
      await publishOperationOutput(pubsub,task.id,{kind:"text",payload:{text:"durably accepted before crash"}});
      process.send?.({taskId:task.id,leaseExpiresAt:task.leaseExpiresAt});
      await new Promise(()=>{});
    }});
  }});
process.send?.({ready:true});
process.on("SIGTERM",()=>{void host.close().then(()=>pool.end()).then(()=>process.exit(0));});
