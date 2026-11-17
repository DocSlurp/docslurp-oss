import { cp, link, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// An overlay root filesystem reports files on a different st_dev than their directory. Simulate it: every opened
// regular file reports dev + 1.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const stat = handle.stat.bind(handle);
      handle.stat = (async (...a: unknown[]) => {
        const info = await (stat as (...x: unknown[]) => Promise<import("node:fs").Stats>)(...a);
        return info.isFile() ? Object.assign(Object.create(Object.getPrototypeOf(info)), info, { dev: info.dev + 1 }) : info;
      }) as typeof handle.stat;
      return handle;
    },
  };
});

import { DopplerFigureRejection, disposeDopplerFigureSet, readDopplerFigureDir } from "../extractors/doppler-figures.js";

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "doppler-figures");
let work: string;
let dir: string;
beforeEach(async () => {
  work = await mkdtemp(path.join(tmpdir(), "doppler-figures-dev-"));
  dir = path.join(work, "figures");
  await cp(FIXTURE, dir, { recursive: true });
});
afterEach(async () => { await rm(work, { recursive: true, force: true }); });

describe("readDopplerFigureDir on an overlay root (files on another st_dev than their folder)", () => {
  it("accepts a valid folder", async () => {
    const set = await readDopplerFigureDir(dir, { pageCount: 10 });
    expect(set.files.length).toBeGreaterThan(0);
    await disposeDopplerFigureSet(set);
  });

  it("still refuses a symlinked figure", async () => {
    await rm(path.join(dir, "p3.1.webp"));
    await symlink("/etc/passwd", path.join(dir, "p3.1.webp"));
    await expect(readDopplerFigureDir(dir, { pageCount: 10 })).rejects.toBeInstanceOf(DopplerFigureRejection);
  });

  it("still refuses an extra file", async () => {
    await writeFile(path.join(dir, "notes.txt"), "x");
    await expect(readDopplerFigureDir(dir, { pageCount: 10 })).rejects.toBeInstanceOf(DopplerFigureRejection);
  });

  it("still refuses a hard-linked figure (reaches openFolderFile)", async () => {
    await link(path.join(dir, "p3.1.webp"), path.join(work, "alias.webp"));
    await expect(readDopplerFigureDir(dir, { pageCount: 10 })).rejects.toMatchObject({ rule: "hard-link" });
  });
});
