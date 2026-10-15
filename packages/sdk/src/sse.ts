export type SseFrame = { event: string; id?: string; data: string };

/** Incremental SSE framing; the reader is owned and cancelled by the caller. */
export async function* readSse(reader: ReadableStreamDefaultReader<Uint8Array>): AsyncGenerator<SseFrame> {
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
    if (buffer.length + size > 1_048_576) throw new Error("DocSlurp SSE frame exceeds 1 MiB");
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
      if (size > 1_048_576) throw new Error("DocSlurp SSE frame exceeds 1 MiB");
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
