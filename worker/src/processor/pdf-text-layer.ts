/** Executes a parser command through a caller-owned sandbox and applies the output limit. */
export type ParserCommand = (
  binary: string,
  args: string[],
  maxBytes: number,
  timeoutMs: number,
  signal?: AbortSignal,
) => Promise<Buffer>;

/** Reads an inclusive page range. The raw UTF-8 output retains Poppler's form-feed page separators. */
export function readPdfTextLayer(
  command: ParserCommand,
  input: string,
  range: { first: number; last: number },
  limits: { maxBytes: number; timeoutMs: number },
  signal?: AbortSignal,
): Promise<Buffer> {
  return command(
    "pdftotext",
    ["-f", String(range.first), "-l", String(range.last), "-layout", "-enc", "UTF-8", input, "-"],
    limits.maxBytes,
    limits.timeoutMs,
    signal,
  );
}
