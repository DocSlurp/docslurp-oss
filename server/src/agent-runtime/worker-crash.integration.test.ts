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

it.runIf(!!url&&!!redis).each(["redis", "redis-timeout", "pool", "cas"] as const)("bounds SIGTERM during real %s contention and releases recovery I/O", async(mode)=>{
  const pool=new Pool({connectionString:url,max:5});
  const namespace=`native-io:${randomUUID()}`;
  const producer=await createNativeChatHost({pool,redisUrl:redis!,namespace,worker:false});
  const {createClient}=await import("redis");
  const admin=createClient({url:redis});admin.on("error",()=>{});await admin.connect();
  const id=`io-${randomUUID()}`;
  const storage=await producer.mastra.backgroundTaskManager!.getStorage();
  let locker:import("pg").PoolClient|undefined;
  const child=fork(new URL("./fixtures/io-worker.ts",import.meta.url),[],{
    execArgv:["--import","tsx"],env:{...process.env,NATIVE_CRASH_NAMESPACE:namespace},stdio:["ignore","ignore","pipe","ipc"]});
  const messages:any[]=[];let stderr="";
  child.on("message",message=>messages.push(message));child.stderr?.on("data",data=>{stderr+=String(data);});
  try {
    await vi.waitFor(()=>expect(messages.some(m=>m.ready),stderr).toBe(true),{timeout:10000});
    if(mode==="pool") {
      child.send({exhaust:true});
      await vi.waitFor(()=>expect(messages.some(m=>m.exhausted),stderr).toBe(true));
    } else if(mode.startsWith("redis")) {
      await pool.query(`insert into "user"(id,name,email) values($1,'IO fixture',$2)`,[id,`${id}@example.test`]);
      await pool.query(`insert into organizations(id,name,slug,created_by_user_id) values($1,'IO fixture',$1,$1)`,[id]);
      await pool.query(`insert into projects(id,org_id,user_id,name) values($1,$1,$1,'IO fixture')`,[id]);
      await pool.query(`insert into chat_operations(id,root_id,user_id,project_id,org_id,idempotency_key,request_hash,input,runtime)
        values($1,$1,$1,$1,$1,$1,'fixture','{}','mastra')`,[id]);
      // Real Redis stops answering all clients, including connected native I/O.
      await admin.sendCommand(["CLIENT","PAUSE","10000",mode==="redis-timeout"?"WRITE":"ALL"]);
    }
    if(mode!=="pool") {
      await storage.createTask({id,toolCallId:id,toolName:"docslurpProjectChat",agentId:"docslurp-project-chat",
        runId:id,resourceId:JSON.stringify([id,id]),args:{operationId:id},status:mode==="cas"?"running":"pending",
        ownerId:mode==="cas"?"dead-owner":undefined,leaseExpiresAt:mode==="cas"?new Date(Date.now()-10000):undefined,
        createdAt:new Date(),maxRetries:0,retryCount:0,timeoutMs:600000});
      if(mode==="cas") {
        locker=await pool.connect();await locker.query("begin");
        await locker.query(`select id from docslurp_mastra.mastra_background_tasks where id=$1 for update`,[id]);
      }
      await vi.waitFor(async()=>{
        const {rows}=await pool.query(`select wait_event_type,state,query from pg_stat_activity
          where application_name='docslurp-native-recovery' and datname=current_database()`);
        expect(rows.some(row=>mode==="cas"?row.wait_event_type==="Lock":row.state==="idle in transaction"),stderr).toBe(true);
      },{timeout:8000,interval:20});
    }
    if(mode==="redis-timeout") {
      const began=Date.now();
      await pool.query("set statement_timeout='4500ms'");
      await pool.query(`update chat_operations set tree_cancel_requested=true where id=$1`,[id]);
      expect(Date.now()-began).toBeLessThan(4000);
      // The same worker must make subsequent progress after aborting its writer.
      await vi.waitFor(async()=>expect((await storage.getTask(id))?.status).toBe("failed"),{timeout:8000});
    }
    const exited=once(child,"exit");const began=Date.now();child.kill("SIGTERM");
    const [code]=await exited;
    expect(code,stderr).toBe(0);expect(Date.now()-began).toBeLessThan(7500);
    expect(messages.find(m=>m.closedMs!==undefined)?.closedMs).toBeLessThan(6500);
    // Child must not retain a native SQL waiter/transaction after it exits.
    await vi.waitFor(async()=>{
      const remaining=await pool.query(`select count(*)::int as n from pg_stat_activity
        where application_name='docslurp-native-recovery' and datname=current_database()`);
      expect(remaining.rows[0].n).toBe(0);
    },{timeout:1500,interval:25});
    console.info(JSON.stringify({mode,closedMs:messages.find(m=>m.closedMs!==undefined)?.closedMs,ioReleasedMs:Date.now()-began}));
    if(mode.startsWith("redis")) {
      await pool.query("set statement_timeout='500ms'");
      await pool.query(`update chat_operations set tree_cancel_requested=true where id=$1`,[id]);
      // After the real outage recovers, no timed-out producer publishes late.
      await admin.sendCommand(["CLIENT","UNPAUSE"]);
      expect(await admin.xLen(`${namespace}:events:background-tasks`)).toBe(0);
      expect((await storage.getTask(id))?.status).toBe(mode==="redis-timeout"?"failed":"pending");
    }
  } finally {
    child.kill("SIGKILL");
    if(locker){await locker.query("rollback");locker.release();}
    await admin.sendCommand(["CLIENT","UNPAUSE"]).catch(()=>{});await admin.quit();
    await storage.deleteTask(id);
    await pool.query(`delete from chat_operations where id=$1`,[id]);
    await pool.query(`delete from projects where id=$1`,[id]);
    await pool.query(`delete from organizations where id=$1`,[id]);
    await pool.query(`delete from "user" where id=$1`,[id]);
    await producer.close();await pool.end();
  }
},35000);

it.runIf(!!url&&!!redis)("keyset recovery reaches multiple pages under status churn and revisits contended rows",async()=>{
  const {startNativeRecovery}=await import("./recovery.js");
  const pool=new Pool({connectionString:url,max:3});
  const namespace=`native-churn:${randomUUID()}`;
  const producer=await createNativeChatHost({pool,redisUrl:redis!,namespace,worker:false});
  const storage=await producer.mastra.backgroundTaskManager!.getStorage();
  const prefix=`churn-${randomUUID()}-`;
  const ids=Array.from({length:130},(_,n)=>`${prefix}${String(n).padStart(3,"0")}`);
  const make=async(id:string)=>storage.createTask({id,toolCallId:id,toolName:"fixture",agentId:"docslurp-project-chat",
    runId:id,args:{},status:"running",ownerId:"dead",leaseExpiresAt:new Date(Date.now()-10000),
    createdAt:new Date(),maxRetries:0,retryCount:0,timeoutMs:600000});
  for(const id of ids)await make(id);
  const lock=await pool.connect();await lock.query("begin");
  await lock.query(`select id from docslurp_mastra.mastra_background_tasks where id=$1 for update`,[ids[0]]);
  const stop=startNativeRecovery(pool,redis!,namespace);
  let additions=0;
  try {
    await vi.waitFor(async()=>{
      // New arrivals and removal of earlier terminal rows cannot shift an offset.
      if(additions<12){const id=`${prefix}new-${additions++}`;ids.push(id);await make(id);}
      for(const id of ids.slice(1,5))if((await storage.getTask(id))?.status==="failed")await storage.deleteTask(id);
      expect((await storage.getTask(ids[129]!))?.status).toBe("failed");
    },{timeout:18000,interval:500});
    expect((await storage.getTask(ids[0]!))?.status).toBe("running");
    await lock.query("rollback");lock.release();
    await vi.waitFor(async()=>expect((await storage.getTask(ids[0]!))?.status).toBe("failed"),{timeout:12000});
  } finally {
    await stop();
    try{await lock.query("rollback");lock.release();}catch{}
    for(const id of ids)await storage.deleteTask(id);
    await producer.close();await pool.end();
  }
},40000);

it.runIf(!!url&&!!redis)("the actual executor entrypoint exits within its encompassing SIGTERM deadline",async()=>{
  const child=fork(new URL("../../scripts/chat-operation-executor.ts",import.meta.url),[],{
    execArgv:["--import","tsx"],env:{...process.env,NODE_ENV:"test",DATABASE_URL:url,MASTRA_REDIS_URL:redis,
      DOCSLURP_DURABLE_CHAT:"1",MASTRA_NAMESPACE:`native-entry:${randomUUID()}`},stdio:["ignore","pipe","pipe","ipc"]});
  let stdout="",stderr="";child.stdout?.on("data",data=>{stdout+=String(data);});child.stderr?.on("data",data=>{stderr+=String(data);});
  try {
    await vi.waitFor(()=>expect(stdout.includes("worker_ready"),stderr).toBe(true),{timeout:15000});
    const exited=once(child,"exit");const began=Date.now();child.kill("SIGTERM");
    expect((await exited)[0],stderr).toBe(0);
    const exitMs=Date.now()-began;
    console.info(JSON.stringify({mode:"actual-entrypoint",exitMs}));
    expect(exitMs).toBeLessThan(6000);
  } finally {child.kill("SIGKILL");}
},25000);

it.runIf(!!url&&!!redis)("drains on stop: claims no new task, lets the running turn finish, then shuts down",async()=>{
  if(new URL(url!).hostname!=="127.0.0.1"||new URL(redis!).hostname!=="127.0.0.1")throw new Error("loopback fixture only");
  const pool=new Pool({connectionString:url,max:6});
  const namespace=`native-drain:${randomUUID()}`;
  const ran:Array<{worker:string;id:string}>=[];
  let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
  const aborted=new Set<string>();
  const executor=(worker:string)=>({async execute(args:Record<string,unknown>,options?:{abortSignal?:AbortSignal}){
    const id=String(args.operationId);ran.push({worker,id});
    if(args.block===true)await new Promise<void>((resolve,reject)=>{
      void gate.then(resolve);
      options?.abortSignal?.addEventListener("abort",()=>{aborted.add(id);reject(new Error("interrupted"));},{once:true});
    });
    return {done:id};
  }});
  const producer=await createNativeChatHost({pool,redisUrl:redis!,namespace,worker:false});
  const a=await createNativeChatHost({pool,redisUrl:redis!,namespace,worker:true,
    configureBackgroundTasks(manager){manager.registerStaticExecutor("drainFixture",executor("a"));}});
  let b:Awaited<ReturnType<typeof createNativeChatHost>>|undefined;
  const manager=producer.mastra.backgroundTaskManager!;
  const enqueue=async(id:string,block:boolean)=>(await manager.enqueue({agentId:"docslurp-project-chat",runId:id,toolCallId:id,
    toolName:"drainFixture",args:{operationId:id,block},resourceId:"fixture",maxRetries:0,timeoutMs:60000})).task.id;
  try {
    const first=randomUUID();const firstTask=await enqueue(first,true);
    await vi.waitFor(()=>expect(ran).toContainEqual({worker:"a",id:first}),{timeout:10000});
    b=await createNativeChatHost({pool,redisUrl:redis!,namespace,worker:true,
      configureBackgroundTasks(m){m.registerStaticExecutor("drainFixture",executor("b"));}});
    let drained:boolean|undefined;
    const draining=a.drain(30000).then(idle=>{drained=idle;});
    // New work goes to the other worker while the draining one finishes its turn.
    const second=randomUUID();const secondTask=await enqueue(second,false);
    await vi.waitFor(async()=>expect((await manager.getTask(secondTask))?.status).toBe("completed"),{timeout:10000});
    expect(ran.filter(r=>r.id===second)).toEqual([{worker:"b",id:second}]);
    expect(drained).toBeUndefined();
    expect((await manager.getTask(firstTask))?.status).toBe("running");
    release();
    await draining;
    expect(drained).toBe(true);
    await vi.waitFor(async()=>expect((await manager.getTask(firstTask))?.status).toBe("completed"),{timeout:10000});
    expect(aborted.size).toBe(0);
    expect(ran.filter(r=>r.id===first)).toHaveLength(1);
  } finally {release();await a.close();await b?.close();await producer.close();await pool.end();}
},60000);

it.runIf(!!url&&!!redis)("a drain that reaches its limit leaves the turn to native shutdown, which interrupts it",async()=>{
  if(new URL(url!).hostname!=="127.0.0.1"||new URL(redis!).hostname!=="127.0.0.1")throw new Error("loopback fixture only");
  const pool=new Pool({connectionString:url,max:4});
  const namespace=`native-drain-limit:${randomUUID()}`;
  let started=false;let interrupted=false;
  const producer=await createNativeChatHost({pool,redisUrl:redis!,namespace,worker:false});
  const a=await createNativeChatHost({pool,redisUrl:redis!,namespace,worker:true,
    configureBackgroundTasks(manager){manager.registerStaticExecutor("drainFixture",{async execute(_args,options){
      started=true;
      await new Promise<void>((_resolve,reject)=>options?.abortSignal?.addEventListener("abort",()=>{interrupted=true;reject(new Error("interrupted"));},{once:true}));
      return {};
    }});}});
  const manager=producer.mastra.backgroundTaskManager!;
  try {
    const id=randomUUID();
    const {task}=await manager.enqueue({agentId:"docslurp-project-chat",runId:id,toolCallId:id,toolName:"drainFixture",
      args:{operationId:id},resourceId:"fixture",maxRetries:0,timeoutMs:60000});
    await vi.waitFor(()=>expect(started).toBe(true),{timeout:10000});
    const began=Date.now();
    expect(await a.drain(600)).toBe(false);
    expect(Date.now()-began).toBeLessThan(3000);
    expect(interrupted).toBe(false);
    await a.close();
    expect(interrupted).toBe(true);
    await vi.waitFor(async()=>expect(["cancelled","failed"]).toContain((await manager.getTask(task.id))?.status),{timeout:10000});
  } finally {await a.close();await producer.close();await pool.end();}
},40000);
