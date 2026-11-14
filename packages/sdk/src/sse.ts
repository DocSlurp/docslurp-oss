export type SseFrame = { event: string; id?: string; data: string };

export const DEFAULT_SSE_FRAME_BYTES = 1_048_576;

/**
 * Incremental SSE framing; the reader is owned and cancelled by the caller.
 * `maxFrameBytes` bounds one frame (default 1 MiB); the search stream raises it because
 * `search.results` carries the whole search response in one frame.
 */
export async function* readSse(reader: ReadableStreamDefaultReader<Uint8Array>, maxFrameBytes = DEFAULT_SSE_FRAME_BYTES): AsyncGenerator<SseFrame> {
  const tooLarge = () => new Error(`DocSlurp SSE frame exceeds ${Math.round(maxFrameBytes / 1_048_576)} MiB`);
  const decoder = new TextDecoder();
  let buffer = "";
  let event = "message";
  let id: string | undefined;
  let data: string[] = [];
  let size = 0;
  while (true) {
    const chunk = await reader.read();
    buffer += decoder.decode(chunk.value, { stream: !chunk.done });
    // Bound both a single unbroken line and a frame containing many short lines.
    if (buffer.length + size > maxFrameBytes) throw tooLarge();
    while (true) {
      const newline = /\r\n|\r|\n/.exec(buffer);
      if (!newline || (!chunk.done && newline[0] === "\r" && newline.index === buffer.length - 1)) break;
      const line = buffer.slice(0, newline.index);
      buffer = buffer.slice(newline.index + newline[0].length);
      if (!line) {
        if (data.length) yield { event, ...(id === undefined ? {} : { id }), data: data.join("\n") };
        event = "message";
        data = [];
        size = 0;
        continue;
      }
      size += line.length;
      if (size > maxFrameBytes) throw tooLarge();
      if (line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon < 0 ? line : line.slice(0, colon);
      let value = colon < 0 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "event") event = value;
      else if (field === "data") data.push(value);
      else if (field === "id" && !value.includes("\0")) id = value;
    }
    if (chunk.done) return;
  }
}
