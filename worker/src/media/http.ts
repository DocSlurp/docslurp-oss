export async function jsonResponse(response: Response): Promise<unknown> {
  if (!response.ok) { await response.body?.cancel(); throw new Error(`Media provider HTTP ${response.status}`); }
  if (!response.body) throw new Error("Empty media provider response");
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    for (;;) { const { done, value } = await reader.read(); if (done) break;
      bytes += value.length; if (bytes > 4 * 1024 * 1024) throw new Error("Media response exceeds limit"); chunks.push(value);
    }
  } finally { await reader.cancel(); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
