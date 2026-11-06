/** Bound hostile VM streams before allocating their complete contents. */
export async function boundedVmStream(stream: ReadableStream<Uint8Array | string>, limit: number): Promise<Buffer> {
  const reader = stream.getReader();
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += typeof value === "string" ? Buffer.byteLength(value) : value.byteLength;
      if (bytes > limit) throw new Error("parser VM transfer exceeded byte limit");
      chunks.push(typeof value === "string" ? Buffer.from(value) : Buffer.from(value));
    }
    return Buffer.concat(chunks, bytes);
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
