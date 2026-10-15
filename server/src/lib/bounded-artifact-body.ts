/** Bound object-storage reads before decoding or parsing attacker-controlled output. */
export async function readBoundedArtifactText(body: AsyncIterable<Uint8Array>, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of body) {
    total += chunk.byteLength;
    if (total > maxBytes) throw new Error("Artifact exceeds the text read limit");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, total).toString("utf8");
}
