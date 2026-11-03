import { AGENT_STREAM_TOPIC } from "@mastra/core/agent/durable";
import type { BackgroundTask } from "@mastra/core/background-tasks";
import type { PubSub } from "@mastra/core/events";

/** Browser sequences are native topic indices + 1; zero means no applied frame.
 * Only public application output is published on this topic. Native reasoning,
 * raw provider chunks, workflow state and tool arguments never enter it.
 */
export const operationOutputTopic = (taskId: string) => AGENT_STREAM_TOPIC(`docslurp-output-${taskId}`);
export type OperationOutput = { kind: "text" | "tool" | "evidence" | "result" | "error"; payload: unknown };

export async function publishOperationOutput(pubsub: PubSub, taskId: string, output: OperationOutput) {
  await pubsub.publish(operationOutputTopic(taskId), {
    runId: taskId, type: output.kind === "result" ? "finish" : output.kind === "error" ? "error" : "chunk", data: output,
  });
}

/** Uses native retained history, not an application execution journal. The
 * caller must authorize the logical operation before looking up its native task.
 */
export async function readNativeOperationOutput(pubsub: PubSub, task: BackgroundTask, after: number, hasAcceptedOutput = true) {
  if (!Number.isSafeInteger(after) || after < 0) throw new Error("invalid_cursor");
  const history = await pubsub.getHistory(operationOutputTopic(task.id));
  let events = history.map(event => {
    if (!Number.isSafeInteger(event.index) || event.index! < 0) throw new Error("unpersisted_output");
    const output = event.data as OperationOutput;
    if (!output || !["text","tool","evidence","result","error"].includes(output.kind)) throw new Error("invalid_output");
    return { sequence: event.index! + 1, kind: output.kind, payload: output.payload };
  }).sort((a,b)=>a.sequence-b.sequence);
  const terminal = ["completed","failed","cancelled","timed_out"].includes(task.status);
  const stored = task.result as { result?: Record<string,unknown>; watermark?: number } | undefined;
  if (events.length && (events[0]!.sequence !== 1 || events.some((event,index)=>index>0&&event.sequence!==events[index-1]!.sequence+1))) {
    if(!terminal||!stored?.result)throw new Error("output_history_gap");
    events=[]; // Native final result is authoritative when replay has a gap.
  }
  const watermark = Math.max(events.at(-1)?.sequence ?? 0, stored?.watermark ?? 0);
  if (!events.length && hasAcceptedOutput && !stored?.result) throw new Error("output_history_unavailable");
  let text = "";
  const tools: unknown[]=[];
  let evidence:unknown;
  let result: Record<string,unknown>|undefined=stored?.result;
  for(const event of events) {
    if(event.kind==="text" && event.payload && typeof event.payload==="object" && "text" in event.payload && typeof event.payload.text==="string") text+=event.payload.text;
    else if(event.kind==="evidence") evidence=event.payload;
    else if(event.kind==="tool") tools.push(event.payload);
    else if(event.kind==="result" && event.payload && typeof event.payload==="object") result=event.payload as Record<string,unknown>;
  }
  // Every event remains indexed, including lifecycle/tool events; a cursor is
  // never inferred from text length or the number of visible text chunks.
  const snapshot:Record<string,unknown>={...(result ?? {text}),tools:tools.length?tools:result?.tools??[],...(evidence===undefined?{}:{evidence}),...(terminal && task.status!=="completed" ? {error: task.status} : {})};
  let resync=(stored?.watermark ?? 0) > (events.at(-1)?.sequence ?? 0) || after>watermark || !!events.length && after<events[0]!.sequence-1 || !events.length;
  let page=events.filter(event=>event.sequence>after).slice(0,256);
  if(Buffer.byteLength(JSON.stringify({snapshot,events:page}))>393216){resync=true;page=[];}
  if(resync)page=[];
  return {snapshot,events:page,watermark,resync,hasMore:!resync&&(page.at(-1)?.sequence ?? after)<watermark};
}
