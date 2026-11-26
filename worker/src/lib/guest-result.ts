import { constants } from "node:fs";
import { open } from "node:fs/promises";

/**
 * Reads a parser VM guest's result file without following a link (a local sandbox provider's job directory is on this
 * host) and only when it is a regular file within `limit` bytes, checked on the opened handle so the file cannot be swapped
 * between the check and the read. Anything else is refused with the caller's typed error. Every guest result the worker
 * reads goes through here.
 */
export async function readGuestResultFile(file: string, limit: number, refuse: (message: string) => Error = (message) => new Error(message)): Promise<Buffer> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => { throw refuse("guest result missing"); });
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw refuse("guest result is not a regular file");
    if (info.size > limit) throw refuse("guest result exceeds limit");
    const bytes = await handle.readFile();
    // A file still being written past the limit is refused too.
    if (bytes.length > limit) throw refuse("guest result exceeds limit");
    return bytes;
  } finally {
    await handle.close();
  }
}

/** readGuestResultFile as UTF-8 text. */
export async function readGuestResultText(file: string, limit: number, refuse?: (message: string) => Error): Promise<string> {
  return (await readGuestResultFile(file, limit, refuse)).toString("utf8");
}
