// Stand-in for @huggingface/transformers in local-embedding-thread tests. Like
// onnxruntime-node, the pipeline blocks its thread synchronously; the model
// name `busy:<ms>` sets how long each batch blocks.
export const env = {};

export async function pipeline(_task, model) {
  if (model.startsWith("fail:")) throw new Error(`cannot load ${model}`);
  const busyMs = Number(model.split(":")[1] ?? 100);
  return async (texts) => {
    const end = Date.now() + busyMs;
    while (Date.now() < end) {
      // Busy: the thread cannot service its event loop.
    }
    const width = 4;
    const data = new Float32Array(texts.length * width);
    texts.forEach((text, row) => data.fill(text.length, row * width, (row + 1) * width));
    return { data, dims: [texts.length, width] };
  };
}
