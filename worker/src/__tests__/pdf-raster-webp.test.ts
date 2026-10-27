import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Document } from "../models.js";
import { resetPageImageFormatFallbackWarning } from "../pipeline/page-image-format.js";
import { PdfRasterCache, type PdfSourceCache } from "../pipeline/pdf-asset-cache.js";
import { SandboxRunError, type SandboxCommand, type SandboxSession } from "../sandbox/types.js";
import { CommandRunner } from "../tools/runner.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const fixture = path.join(root, "worker/testdata/pdf-fixtures/multicolumn-figures-report.pdf");
const available = ["pdfinfo", "pdftoppm", "cwebp"].every((binary) => spawnSync(binary, ["-h"]).error === undefined);

type Stored = { bytes: Buffer; mimeType: string };

function memoryStorage() {
  const objects = new Map<string, Stored>();
  return {
    objects,
    async objectSize(key: string) { return objects.get(key)?.bytes.byteLength ?? null; },
    async putBytes(key: string, bytes: Uint8Array, mimeType: string) { objects.set(key, { bytes: Buffer.from(bytes), mimeType }); },
    uri(key: string) { return `s3://test/${key}`; },
  };
}

/**
 * A sandbox session that records every command it is asked to run, then runs it like the
 * development `none` provider. `refuse` makes the session reject a binary as a sandbox failure.
 */
function recordingRunner(options: { refuse?: string } = {}) {
  const commands: SandboxCommand[] = [];
  const session: SandboxSession = {
    providerId: "recording",
    isolation: { filesystem: false, network: "none", processes: false, location: "local" },
    spawn(command, signal) {
      commands.push(command);
      if (options.refuse && path.basename(command.binary) === options.refuse) {
        throw new SandboxRunError(`sandbox refused ${options.refuse}`);
      }
      return spawn(command.binary, command.args, { env: command.env, stdio: ["ignore", "pipe", "pipe"], signal });
    },
    async close() {},
  };
  const runner = new CommandRunner({ openSession: async () => session });
  return { runner, commands };
}

function document(overrides: Partial<Document> = {}): Document {
  return {
    id: "doc", userId: "user", runId: "run", filename: "report.pdf", mimeType: "application/pdf",
    sourceKey: "sources/report.pdf", status: "processing", extractionMode: "auto", pageCount: 1,
    createdAt: new Date(), updatedAt: new Date(), ...overrides,
  };
}

const sources = { get: async () => ({ path: fixture, sha256: "x", sizeBytes: 1, cacheHit: true }) } as unknown as PdfSourceCache;

async function rawPixels(bytes: Buffer) {
  const { data, info } = await sharp(bytes).raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: info.channels };
}

describe.skipIf(!available)("lossless WebP page images", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetPageImageFormatFallbackWarning();
  });

  it("renders a real PDF page, stores WebP and decodes it pixel-identically to the PNG", async () => {
    const storage = memoryStorage();
    const { runner, commands } = recordingRunner();
    const webpCache = new PdfRasterCache(runner, storage, sources, { engine: "pdftoppm", format: "webp" });
    const pngCache = new PdfRasterCache(runner, storage, sources, { engine: "pdftoppm", format: "png" });

    const [webp] = await webpCache.renderSelectedPages({ document: document(), runId: "run", pageNumbers: [1] });
    const [png] = await pngCache.renderSelectedPages({ document: document(), runId: "run", pageNumbers: [1] });

    expect(webp!.mimeType).toBe("image/webp");
    expect(webp!.artifactKey).toBe("user/run/images/doc/v2-150dpi-webp/page-1.webp");
    expect(storage.objects.get(webp!.artifactKey)!.mimeType).toBe("image/webp");
    expect(png!.artifactKey).toBe("user/run/images/doc/v2-150dpi/page-1.png");
    expect(webp!.sizeBytes).toBeLessThan(png!.sizeBytes);
    expect([webp!.widthPx, webp!.heightPx]).toEqual([png!.widthPx, png!.heightPx]);

    const stored = storage.objects.get(webp!.artifactKey)!.bytes;
    expect((await sharp(stored).metadata()).format).toBe("webp");
    const fromWebp = await rawPixels(stored);
    const fromPng = await rawPixels(storage.objects.get(png!.artifactKey)!.bytes);
    expect([fromWebp.width, fromWebp.height, fromWebp.channels]).toEqual([fromPng.width, fromPng.height, fromPng.channels]);
    expect(fromWebp.data.equals(fromPng.data)).toBe(true);

    // Read back: the stored WebP is a cache hit, nothing renders again.
    const before = commands.length;
    const [again] = await webpCache.renderSelectedPages({ document: document(), runId: "run", pageNumbers: [1] });
    expect(again).toMatchObject({ cacheHit: true, mimeType: "image/webp", artifactKey: webp!.artifactKey });
    expect(commands.length).toBe(before);
  });

  it("encodes through the sandbox session with the effort chosen by retention", async () => {
    const storage = memoryStorage();
    const { runner, commands } = recordingRunner();
    const cache = new PdfRasterCache(runner, storage, sources, { engine: "pdftoppm", format: "webp" });

    await cache.renderSelectedPages({ document: document({ artifactRetentionHours: 48 }), runId: "short", pageNumbers: [1] });
    await cache.renderSelectedPages({ document: document({ artifactRetentionHours: null }), runId: "kept", pageNumbers: [1] });

    const encodes = commands.filter((command) => path.basename(command.binary) === "cwebp");
    expect(encodes).toHaveLength(2);
    expect(encodes.map((command) => command.args[command.args.indexOf("-z") + 1])).toEqual(["1", "6"]);
    for (const command of encodes) {
      expect(command.args).toEqual(expect.arrayContaining(["-lossless", "-exact", "--"]));
      // The PNG is a declared input and the output directory a declared writable path, so a
      // remote provider uploads and copies back exactly these.
      const input = command.args.at(-1)!;
      expect(command.inputPaths).toContain(input);
      expect(command.writablePaths.some((dir) => input.startsWith(`${dir}${path.sep}`))).toBe(true);
      expect(command.env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    }
  });

  it("fails closed when the sandbox refuses the encoder, storing nothing", async () => {
    const storage = memoryStorage();
    const { runner } = recordingRunner({ refuse: "cwebp" });
    const cache = new PdfRasterCache(runner, storage, sources, { engine: "pdftoppm", format: "webp" });
    await expect(cache.renderSelectedPages({ document: document(), runId: "run", pageNumbers: [1] })).rejects.toThrow("sandbox refused cwebp");
    expect(storage.objects.size).toBe(0);
  });

  it("stores PNG with a loud warning when cwebp is missing", async () => {
    const storage = memoryStorage();
    const { runner, commands } = recordingRunner();
    vi.spyOn(runner, "encodeLosslessWebp").mockImplementation(async () => ({ binary: "cwebp", args: [], available: false }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cache = new PdfRasterCache(runner, storage, sources, { engine: "pdftoppm", format: "webp" });

    const [page] = await cache.renderSelectedPages({ document: document(), runId: "run", pageNumbers: [1] });

    expect(page).toMatchObject({ mimeType: "image/png", artifactKey: "user/run/images/doc/v2-150dpi/page-1.png", cacheHit: false });
    expect(storage.objects.get(page!.artifactKey)!.mimeType).toBe("image/png");
    expect(commands.some((command) => path.basename(command.binary) === "cwebp")).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("[page-image] WARNING storing PNG instead of WebP status=unavailable"));
  });

  it("serves an existing PNG object instead of re-rendering it as WebP", async () => {
    const storage = memoryStorage();
    const { runner, commands } = recordingRunner();
    const [legacy] = await new PdfRasterCache(runner, storage, sources, { engine: "pdftoppm", format: "png" })
      .renderSelectedPages({ document: document(), runId: "run", pageNumbers: [1] });
    const before = commands.length;

    const [page] = await new PdfRasterCache(runner, storage, sources, { engine: "pdftoppm", format: "webp" })
      .renderSelectedPages({ document: document(), runId: "run", pageNumbers: [1] });

    expect(page).toMatchObject({ cacheHit: true, mimeType: "image/png", artifactKey: legacy!.artifactKey });
    expect(commands.length).toBe(before);
  });
});
