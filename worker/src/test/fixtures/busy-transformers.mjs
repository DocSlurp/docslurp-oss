// Stand-in for @huggingface/transformers in local-embedding-thread tests. Like
// onnxruntime-node, the pipeline blocks its thread synchronously; the model
// name `busy:<ms>` sets how long each batch blocks.
//
// - `trace:<ms>`: each row is [text length, thread id, start ms, end ms] (ms modulo
//   16,000,000, exact in a Float32), so tests can see which thread ran a batch and when.
// - `opts:<ms>`: each row is [text length, intra-op threads the pipeline was created with].
// - a text equal to `__crash__` kills the thread with process.exit(7), as a native crash would.
import { threadId } from "node:worker_threads";

export const env = {};

export async function pipeline(_task, model, options = {}) {
  if (model.startsWith("fail:")) throw new Error(`cannot load ${model}`);
  const [kind, ms] = model.split(":");
  const busyMs = Number(ms ?? 100);
  const intraOpThreads = options.session_options?.intraOpNumThreads ?? 0;
  return async (texts) => {
    if (texts.includes("__crash__")) process.exit(7);
    const startedAt = Date.now();
    while (Date.now() < startedAt + busyMs) {
      // Busy: the thread cannot service its event loop.
    }
    const endedAt = Date.now();
    const width = 4;
    const data = new Float32Array(texts.length * width);
    texts.forEach((text, row) => {
      data.fill(text.length, row * width, (row + 1) * width);
      if (kind === "trace") {
        data.set([text.length, threadId, startedAt % 16_000_000, endedAt % 16_000_000], row * width);
      } else if (kind === "opts") {
        data[row * width + 1] = intraOpThreads;
      }
    });
    return { data, dims: [texts.length, width] };
  };
}
