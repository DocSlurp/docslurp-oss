import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { readGuestResultFile, readGuestResultText } from "./guest-result.js";

/** A guest can write anything into its job directory (a local provider's is on this host): only a bounded regular file is read. */
describe("readGuestResultFile", () => {
  let dir: string;
  beforeAll(async () => { dir = await mkdtemp(path.join(tmpdir(), "guest-result-")); });
  afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

  it("reads a regular file within the limit", async () => {
    await writeFile(path.join(dir, "ok.json"), "{\"a\":1}");
    expect(await readGuestResultText(path.join(dir, "ok.json"), 64)).toBe("{\"a\":1}");
  });

  it("refuses a link (to a host secret, say), a directory, a missing file and an oversized one", async () => {
    await writeFile(path.join(dir, "secret"), "credentials");
    await symlink(path.join(dir, "secret"), path.join(dir, "link.json"));
    await mkdir(path.join(dir, "dir.json"));
    await writeFile(path.join(dir, "big.json"), "x".repeat(65));
    const refuse = (message: string) => Object.assign(new Error(message), { name: "GuestRefused" });
    await expect(readGuestResultFile(path.join(dir, "link.json"), 64, refuse)).rejects.toMatchObject({ name: "GuestRefused" });
    await expect(readGuestResultFile(path.join(dir, "dir.json"), 64, refuse)).rejects.toMatchObject({ name: "GuestRefused", message: "guest result is not a regular file" });
    await expect(readGuestResultFile(path.join(dir, "none.json"), 64, refuse)).rejects.toMatchObject({ message: "guest result missing" });
    await expect(readGuestResultFile(path.join(dir, "big.json"), 64, refuse)).rejects.toMatchObject({ message: "guest result exceeds limit" });
  });
});
