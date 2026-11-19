import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { verifyClamVolumeArgv } from "../providers/modal/clam-definition-volume.js";

// Emulate only the kernel mount metadata. The verifier itself hashes the actual files in the test directory.
const runWithMountMetadata = [
  "import builtins, io, os, sys, types",
  "script, metadata, flag, *args = sys.argv[1:]",
  "real_open = builtins.open",
  "builtins.open = lambda f, *a, **k: io.StringIO(metadata) if f == '/proc/self/mountinfo' else real_open(f, *a, **k)",
  "os.statvfs = lambda _: types.SimpleNamespace(f_flag=int(flag) * os.ST_RDONLY)",
  "sys.argv = ['verify'] + args",
  "exec(script)",
].join("\n");

describe("ClamAV volume mount verification", () => {
  let root: string;
  const hash = createHash("sha256").update("daily.cvd\0" + "4\0defs").digest("hex");

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "docslurp-clam-mount-test-"));
    writeFileSync(path.join(root, "daily.cvd"), "defs");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function mountInfo(id: number, fs: string, options: string, mount = root): string {
    return `${id} 1 0:55 / ${mount} ${options} - ${fs} source ro\n`;
  }

  function verify(metadata: string, effectiveReadOnly = true): number | null {
    const [python, isolated, command, verifier] = verifyClamVolumeArgv(hash);
    const check = spawnSync(python!, [isolated!, command!, runWithMountMetadata, verifier!, metadata, effectiveReadOnly ? "1" : "0", root, hash], { encoding: "utf8" });
    expect(check.error).toBeUndefined();
    expect(check.stderr).toBe("");
    return check.status;
  }

  it("reads a single read-only mount and Modal's two read-only layers", () => {
    const volume = mountInfo(3, "virtiofs", "ro,relatime");
    expect(verify(volume)).toBe(0);
    expect(verify(mountInfo(2, "tmpfs", "ro,nosuid,nodev,noexec") + volume)).toBe(0);
  });

  it("refuses an unsafe layer, unexpected layer stack, or nested mount", () => {
    const volume = mountInfo(3, "virtiofs", "ro,relatime");
    expect(verify(mountInfo(2, "tmpfs", "rw,nosuid") + volume)).toBe(2);
    expect(verify(mountInfo(2, "overlay", "ro") + volume)).toBe(2);
    expect(verify(mountInfo(2, "tmpfs", "ro") + volume + mountInfo(4, "tmpfs", "ro"))).toBe(2);
    expect(verify(volume + mountInfo(4, "tmpfs", "ro", `${root}/nested`))).toBe(2);
    expect(verify(volume, false)).toBe(2);
  });

  it("falls back when the mount or its exact signature content is unavailable", () => {
    expect(verify("")).toBe(1);
    writeFileSync(path.join(root, "daily.cvd"), "other");
    expect(verify(mountInfo(3, "virtiofs", "ro"))).toBe(1);
  });
});
