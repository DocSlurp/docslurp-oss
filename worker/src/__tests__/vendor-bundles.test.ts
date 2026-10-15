import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, stat, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { zstdCompressSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildAllowlistedEnv, defaultParserEnvAllowlist, defaultPythonPoolEnvAllowlist } from "../tools/process-env.js";
import { extractTarSafely, safeMemberPath, safeSymlinkTarget } from "../tools/safe-tar.js";
import {
  FORBIDDEN_ENV,
  bundleObjectKey,
  bundleObjectUrl,
  prefetchVendorBundles,
  redactVendorBundleText,
  resolveS3BundleSource,
  currentBundlePlatform,
  ensureVendorBundle,
  findBundleForBinary,
  findBundleForPythonModule,
  installedVendorBundle,
  resetVendorBundleStateForTests,
  resolveBundleBaseUrl,
  validateManifest,
  vendorBundlesEnabled,
  type VendorBundleManifest,
} from "../tools/vendor-bundles.js";

type Entry = { name: string; type?: string; body?: string; link?: string; mode?: number };

function header(name: string, type: string, size: number, mode: number, link = ""): Buffer {
  const block = Buffer.alloc(512);
  block.write(name.slice(0, 100), 0, "utf8");
  block.write(`${mode.toString(8).padStart(7, "0")}\0`, 100);
  block.write("0000000\0", 108);
  block.write("0000000\0", 116);
  block.write(`${size.toString(8).padStart(11, "0")}\0`, 124);
  block.write("00000000000\0", 136);
  block.write("        ", 148);
  block.write(type, 156);
  block.write(link.slice(0, 100), 157, "utf8");
  block.write("ustar\0", 257);
  block.write("00", 263);
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  return block;
}

function makeTar(entries: Entry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    const body = Buffer.from(entry.body ?? "");
    const type = entry.type ?? "0";
    parts.push(header(entry.name, type, type === "0" ? body.length : 0, entry.mode ?? 0o644, entry.link));
    if (type === "0" && body.length) {
      parts.push(body, Buffer.alloc((512 - (body.length % 512)) % 512));
    }
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

let work: string;
beforeEach(async () => {
  work = await mkdtemp(path.join(tmpdir(), "docslurp-vendor-bundles-"));
  resetVendorBundleStateForTests();
});
afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

async function writeArchive(name: string, entries: Entry[]): Promise<string> {
  const file = path.join(work, name);
  await writeFile(file, zstdCompressSync(makeTar(entries)));
  return file;
}

const limits = { maxBytes: 1 << 20, maxEntries: 100 };

describe("safe tar extraction", () => {
  it("extracts files, directories and contained symlinks with sanitized modes", async () => {
    const archive = await writeArchive("ok.tar.zst", [
      { name: "bin/", type: "5", mode: 0o777 },
      { name: "bin/tool", body: "#!/bin/sh\necho hi\n", mode: 0o4777 },
      { name: "site-packages/pkg/__init__.py", body: "x = 1\n", mode: 0o666 },
      { name: "site-packages/alias", type: "2", link: "pkg" },
    ]);
    const out = path.join(work, "out");
    await mkdir(out);
    const result = await extractTarSafely(archive, out, limits);
    expect(result).toMatchObject({ files: 2, directories: 1, symlinks: 1 });
    expect((await stat(path.join(out, "bin/tool"))).mode & 0o7777).toBe(0o755);
    expect((await stat(path.join(out, "site-packages/pkg/__init__.py"))).mode & 0o7777).toBe(0o644);
    expect(await readlink(path.join(out, "site-packages/alias"))).toBe("pkg");
  });

  it.each([
    [[{ name: "../evil", body: "x" }], /parent traversal/],
    [[{ name: "a/../../evil", body: "x" }], /parent traversal/],
    [[{ name: "/etc/evil", body: "x" }], /absolute path/],
    [[{ name: "link", type: "2", link: "/etc" }], /absolute symlink/],
    [[{ name: "a/link", type: "2", link: "../../etc" }], /escapes the bundle/],
    [[{ name: "link", type: "2", link: "sub" }, { name: "link/payload", body: "x" }], /through symlink/],
    [[{ name: "hard", type: "1", link: "x" }], /unsupported entry type "1"/],
    [[{ name: "dev", type: "3" }], /unsupported entry type "3"/],
    [[{ name: "dup", body: "a" }, { name: "dup", body: "b" }], /duplicate entry/],
  ] as Array<[Entry[], RegExp]>)("refuses unsafe archive %#", async (entries, message) => {
    const archive = await writeArchive("bad.tar.zst", entries);
    const out = path.join(work, "out");
    await mkdir(out);
    await expect(extractTarSafely(archive, out, limits)).rejects.toThrow(message);
    // Nothing escaped the destination.
    expect(await readdir(work)).toEqual(expect.arrayContaining(["bad.tar.zst", "out"]));
    expect((await readdir(work)).length).toBe(2);
  });

  it("enforces size and entry limits and detects truncation", async () => {
    const big = await writeArchive("big.tar.zst", [{ name: "f", body: "x".repeat(2000) }]);
    await mkdir(path.join(work, "o1"));
    await expect(extractTarSafely(big, path.join(work, "o1"), { maxBytes: 1000, maxEntries: 10 })).rejects.toThrow(/unpacked size/);
    const many = await writeArchive("many.tar.zst", [{ name: "a", body: "1" }, { name: "b", body: "2" }, { name: "c", body: "3" }]);
    await mkdir(path.join(work, "o2"));
    await expect(extractTarSafely(many, path.join(work, "o2"), { maxBytes: 1000, maxEntries: 2 })).rejects.toThrow(/more than 2 entries/);
    const truncated = path.join(work, "trunc.tar.zst");
    await writeFile(truncated, zstdCompressSync(makeTar([{ name: "a", body: "1" }]).subarray(0, 1024)));
    await mkdir(path.join(work, "o3"));
    await expect(extractTarSafely(truncated, path.join(work, "o3"), limits)).rejects.toThrow(/truncated/);
  });

  it("normalizes member paths and symlink targets", () => {
    expect(safeMemberPath("./a//b/./c")).toBe("a/b/c");
    expect(() => safeMemberPath("a\\..\\b")).toThrow(/invalid characters/);
    expect(safeSymlinkTarget("a/b/link", "../c")).toBe("../c");
    expect(() => safeSymlinkTarget("a/link", "../../c")).toThrow(/escapes/);
  });
});

describe("vendor bundles", () => {
  async function publish(entries: Entry[]): Promise<{ manifest: VendorBundleManifest; baseDir: string; sha256: string }> {
    const bytes = zstdCompressSync(makeTar(entries));
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const baseDir = path.join(work, "bucket");
    await mkdir(path.join(baseDir, "docling"), { recursive: true });
    await writeFile(path.join(baseDir, "docling", `${sha256}.tar.zst`), bytes);
    const manifest = validateManifest({
      schemaVersion: 1,
      bundles: {
        docling: {
          binaries: ["docling"],
          pythonModules: ["docling", "docling_core"],
          distributions: ["docling"],
          env: { HF_HUB_OFFLINE: "1", DOCLING_ARTIFACTS_PATH: "./models/docling" },
          artifacts: [{ platform: currentBundlePlatform({}), sha256, size: bytes.length, unpackedSize: 4096 }],
        },
      },
    });
    return { manifest, baseDir, sha256 };
  }

  const bundleEntries: Entry[] = [
    { name: "bin/docling", body: "#!/usr/bin/env python3\n", mode: 0o755 },
    { name: "site-packages/docling/__init__.py", body: "" },
  ];

  it("is off without a base URL or with the off switch", () => {
    expect(vendorBundlesEnabled({})).toBe(false);
    expect(vendorBundlesEnabled({ DOCSLURP_VENDOR_BUNDLE_BASE_URL: "https://x.example/b" })).toBe(true);
    expect(vendorBundlesEnabled({ DOCSLURP_VENDOR_BUNDLE_BASE_URL: "https://x.example/b", DOCSLURP_VENDOR_BUNDLES: "off" })).toBe(false);
    const only = { DOCSLURP_VENDOR_BUNDLE_BASE_URL: "https://x.example/b", DOCSLURP_VENDOR_BUNDLES: "unstructured" };
    expect(vendorBundlesEnabled(only, "unstructured")).toBe(true);
    expect(vendorBundlesEnabled(only, "docling")).toBe(false);
  });

  it("only accepts https, file and loopback http base URLs and content-addresses objects", () => {
    expect(() => resolveBundleBaseUrl("http://bucket.example/b")).toThrow(/https/);
    expect(resolveBundleBaseUrl("http://127.0.0.1:9000/b").href).toBe("http://127.0.0.1:9000/b/");
    const sha = "a".repeat(64);
    expect(bundleObjectUrl(resolveBundleBaseUrl("https://h.example/vendor"), "docling", sha).href).toBe(`https://h.example/vendor/docling/${sha}.tar.zst`);
  });

  it("validates manifests", () => {
    expect(() => validateManifest({ schemaVersion: 1, bundles: { "../x": { artifacts: [] } } })).toThrow(/invalid vendor bundle name/);
    expect(() => validateManifest({ schemaVersion: 1, bundles: { x: { artifacts: [{ platform: "linux-x64-py3.13", sha256: "nope", size: 1, unpackedSize: 1 }] } } })).toThrow(/sha256/);
    expect(() => validateManifest({ schemaVersion: 1, bundles: { x: { binaries: ["../sh"], artifacts: [] } } })).toThrow(/invalid binary/);
    for (const key of ["LD_PRELOAD", "PATH", "PYTHONPATH", "AWS_SECRET_ACCESS_KEY", "OPENAI_API_KEY", "lower"]) {
      expect(() => validateManifest({ schemaVersion: 1, bundles: { x: { env: { [key]: "1" }, artifacts: [] } } })).toThrow(/may not set env/);
    }
    expect(() => validateManifest({ schemaVersion: 1, bundles: { x: { env: { HF_HOME: "./../../etc" }, artifacts: [] } } })).toThrow(/invalid value/);
  });

  it("downloads, verifies, unpacks once and reuses the cache across calls", async () => {
    const { manifest, baseDir, sha256 } = await publish(bundleEntries);
    const env = { DOCSLURP_VENDOR_BUNDLE_BASE_URL: pathToFileURL(baseDir).href, DOCSLURP_VENDOR_BUNDLE_DIR: path.join(work, "cache") };
    expect(findBundleForBinary("docling", manifest, currentBundlePlatform(env))).toBe("docling");
    expect(findBundleForPythonModule("docling_core", manifest, currentBundlePlatform(env))).toBe("docling");
    expect(await installedVendorBundle("docling", { env, manifest })).toBeNull();
    const [a, b] = await Promise.all([ensureVendorBundle("docling", { env, manifest }), ensureVendorBundle("docling", { env, manifest })]);
    expect(a.root).toBe(b.root);
    expect(a.sha256).toBe(sha256);
    expect(await readFile(path.join(a.binDir, "docling"), "utf8")).toContain("python3");
    expect(a.env).toEqual({ HF_HUB_OFFLINE: "1", DOCLING_ARTIFACTS_PATH: path.join(a.root, "models/docling") });
    expect((await installedVendorBundle("docling", { env, manifest }))?.root).toBe(a.root);
    // No temp files, staging dirs or locks are left behind.
    expect((await readdir(path.join(work, "cache"))).sort()).toEqual([path.basename(a.root)]);
    resetVendorBundleStateForTests();
    await rm(path.join(baseDir, "docling"), { recursive: true });
    expect((await ensureVendorBundle("docling", { env, manifest })).root).toBe(a.root);
  });

  it("rejects an archive whose digest does not match the pinned sha256", async () => {
    const { manifest, baseDir, sha256 } = await publish(bundleEntries);
    await writeFile(path.join(baseDir, "docling", `${sha256}.tar.zst`), zstdCompressSync(makeTar([{ name: "bin/docling", body: "#!/bin/sh\nevil\n" }])).subarray(0, manifest.bundles.docling!.artifacts[0]!.size));
    const env = { DOCSLURP_VENDOR_BUNDLE_BASE_URL: pathToFileURL(baseDir).href, DOCSLURP_VENDOR_BUNDLE_DIR: path.join(work, "cache") };
    await expect(ensureVendorBundle("docling", { env, manifest })).rejects.toThrow(/mismatch/);
    expect(await readdir(path.join(work, "cache"))).toEqual([]);
    // The failure is cached briefly so every candidate does not re-download.
    await expect(ensureVendorBundle("docling", { env, manifest })).rejects.toThrow(/cached failure/);
  });

  it("fails fast with a clear error when the cache dir is not writable", async () => {
    const { manifest, baseDir } = await publish(bundleEntries);
    const readOnly = path.join(work, "ro");
    await mkdir(readOnly);
    await chmod(readOnly, 0o555);
    const env = { DOCSLURP_VENDOR_BUNDLE_BASE_URL: pathToFileURL(baseDir).href, DOCSLURP_VENDOR_BUNDLE_DIR: path.join(readOnly, "cache") };
    const started = Date.now();
    const isRoot = process.getuid?.() === 0;
    if (!isRoot) {
      await expect(ensureVendorBundle("docling", { env, manifest })).rejects.toThrow(/EACCES/);
      expect(Date.now() - started).toBeLessThan(5000);
    }
    await chmod(readOnly, 0o755);
  });

  it("explains why a bundle is unavailable", async () => {
    const { manifest } = await publish(bundleEntries);
    await expect(ensureVendorBundle("docling", { env: {}, manifest })).rejects.toThrow(/disabled/);
    await expect(ensureVendorBundle("nope", { env: { DOCSLURP_VENDOR_BUNDLE_BASE_URL: "https://x.example" }, manifest })).rejects.toThrow(/not declared/);
    await expect(ensureVendorBundle("docling", { env: { DOCSLURP_VENDOR_BUNDLE_BASE_URL: "https://x.example", DOCSLURP_VENDOR_BUNDLE_PYTHON: "2.7" }, manifest })).rejects.toThrow(/no artifact published/);
  });

  it("ships a valid manifest in the worker package", async () => {
    const { loadVendorBundleManifest } = await import("../tools/vendor-bundles.js");
    expect(loadVendorBundleManifest().schemaVersion).toBe(1);
    expect((await lstat(path.resolve(__dirname, "../../vendor-bundles.json"))).isFile()).toBe(true);
  });
});

describe("vendor bundle install races", () => {
  it("keeps an install another process completed and replaces a partial one", async () => {
    const bytes = zstdCompressSync(makeTar([{ name: "bin/tool", body: "new", mode: 0o755 }]));
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const bucket = path.join(work, "bucket2");
    await mkdir(path.join(bucket, "tool"), { recursive: true });
    await writeFile(path.join(bucket, "tool", `${sha256}.tar.zst`), bytes);
    const manifest = validateManifest({ schemaVersion: 1, bundles: { tool: { binaries: ["tool"], artifacts: [{ platform: currentBundlePlatform({}), sha256, size: bytes.length, unpackedSize: 100 }] } } });
    const cache = path.join(work, "cache2");
    const env = { DOCSLURP_VENDOR_BUNDLE_BASE_URL: pathToFileURL(bucket).href, DOCSLURP_VENDOR_BUNDLE_DIR: cache };
    const root = path.join(cache, `tool-${sha256.slice(0, 16)}`);
    // A partial directory without a marker (crash mid-install) is replaced, and
    // orphaned download/staging leftovers for the same sha are cleaned up.
    await mkdir(path.join(root, "bin"), { recursive: true });
    await writeFile(path.join(root, "bin", "tool"), "partial");
    await writeFile(path.join(cache, `.download-${sha256}-1-dead.tar.zst`), "junk");
    await mkdir(path.join(cache, `.staging-${sha256}-1-dead`));
    const installed = await ensureVendorBundle("tool", { env, manifest });
    expect(await readFile(path.join(installed.binDir, "tool"), "utf8")).toBe("new");
    expect(await readdir(cache)).toEqual([path.basename(root)]);
  });
});

describe("private S3 vendor bundle source", () => {
  const ACCESS = "AKIATESTACCESS0001";
  const SECRET = "s3cr3t/ValueDoNotLeak+42";

  async function startFakeS3(handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void) {
    const { createServer } = await import("node:http");
    const requests: { url: string; auth: string }[] = [];
    const server = createServer((req, res) => {
      requests.push({ url: req.url ?? "", auth: String(req.headers.authorization ?? "") });
      handler(req, res);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as import("node:net").AddressInfo).port;
    return { endpoint: `http://127.0.0.1:${port}`, requests, close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }) };
  }

  function s3Env(endpoint: string, extra: Record<string, string> = {}) {
    return {
      DOCSLURP_VENDOR_BUNDLE_BASE_URL: "s3://docslurp-vendor-bundles/prod",
      DOCSLURP_VENDOR_BUNDLE_S3_ENDPOINT: endpoint,
      DOCSLURP_VENDOR_BUNDLE_S3_REGION: "us-west-004",
      DOCSLURP_VENDOR_BUNDLE_S3_ACCESS_KEY_ID: ACCESS,
      DOCSLURP_VENDOR_BUNDLE_S3_SECRET_ACCESS_KEY: SECRET,
      DOCSLURP_VENDOR_BUNDLE_DIR: path.join(work, "cache"),
      ...extra,
    };
  }

  function bundle(body = "#!/bin/sh\necho hi\n") {
    const bytes = zstdCompressSync(makeTar([{ name: "bin/tool", body, mode: 0o755 }]));
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const manifest = validateManifest({ schemaVersion: 1, bundles: { tool: { binaries: ["tool"], artifacts: [{ platform: currentBundlePlatform({}), sha256, size: bytes.length, unpackedSize: 4096 }] } } });
    return { bytes, sha256, manifest };
  }

  it("parses the s3 base and requires credentials", () => {
    const env = s3Env("https://s3.us-west-004.backblazeb2.com");
    expect(resolveS3BundleSource("s3://docslurp-vendor-bundles/a/b/", env)).toMatchObject({ bucket: "docslurp-vendor-bundles", prefix: "a/b", region: "us-west-004" });
    expect(bundleObjectKey({ prefix: "a/b" }, "docling", "f".repeat(64))).toBe(`a/b/docling/${"f".repeat(64)}.tar.zst`);
    expect(bundleObjectKey({ prefix: "" }, "docling", "f".repeat(64))).toBe(`docling/${"f".repeat(64)}.tar.zst`);
    expect(() => resolveS3BundleSource("s3://b/p", { ...env, DOCSLURP_VENDOR_BUNDLE_S3_SECRET_ACCESS_KEY: "" })).toThrow(/SECRET_ACCESS_KEY/);
    expect(() => resolveS3BundleSource("s3://u:p@b/p", env)).toThrow(/credentials/);
    expect(() => resolveS3BundleSource("s3://b/p", { ...env, DOCSLURP_VENDOR_BUNDLE_S3_ENDPOINT: "http://example.com" })).toThrow(/https/);
    expect(vendorBundlesEnabled(env, "tool")).toBe(true);
  });

  it("downloads from a signed GetObject, verifies and installs", async () => {
    const { bytes, sha256, manifest } = bundle();
    const s3 = await startFakeS3((_req, res) => {
      res.writeHead(200, { "content-length": bytes.length, "content-type": "application/zstd" });
      res.end(bytes);
    });
    try {
      const installed = await ensureVendorBundle("tool", { env: s3Env(s3.endpoint), manifest });
      expect(await readFile(path.join(installed.binDir, "tool"), "utf8")).toContain("echo hi");
      expect(s3.requests).toHaveLength(1);
      expect(s3.requests[0]!.url.split("?")[0]).toBe(`/docslurp-vendor-bundles/prod/tool/${sha256}.tar.zst`);
      expect(s3.requests[0]!.auth).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIATESTACCESS0001\/\d{8}\/us-west-004\/s3\/aws4_request/);
      expect(s3.requests[0]!.auth).not.toContain(SECRET);
      expect((await readdir(path.join(work, "cache"))).sort()).toEqual([path.basename(installed.root)]);
    } finally {
      await s3.close();
    }
  });

  it("rejects a wrong digest before unpacking", async () => {
    const { bytes, manifest } = bundle();
    const tampered = Buffer.from(bytes);
    tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 0xff;
    const s3 = await startFakeS3((_req, res) => {
      res.writeHead(200, { "content-length": tampered.length });
      res.end(tampered);
    });
    try {
      await expect(ensureVendorBundle("tool", { env: s3Env(s3.endpoint), manifest })).rejects.toThrow(/sha256 mismatch/);
      expect(await readdir(path.join(work, "cache"))).toEqual([]);
    } finally {
      await s3.close();
    }
  });

  it("stops an oversized body", async () => {
    const { bytes, manifest } = bundle();
    const big = Buffer.concat([bytes, Buffer.alloc(4096, 1)]);
    const s3 = await startFakeS3((_req, res) => {
      res.writeHead(200, { "content-length": big.length });
      res.end(big);
    });
    try {
      await expect(ensureVendorBundle("tool", { env: s3Env(s3.endpoint), manifest })).rejects.toThrow(/pinned size/);
      expect(await readdir(path.join(work, "cache"))).toEqual([]);
    } finally {
      await s3.close();
    }
  });

  it("reports a missing object and an access failure without leaking credentials", async () => {
    const { manifest } = bundle();
    const xml = (code: string) => `<?xml version="1.0"?><Error><Code>${code}</Code><Message>${code}</Message></Error>`;
    for (const [status, code, pattern] of [[404, "NoSuchKey", /object not found/], [403, "AccessDenied", /access denied/]] as const) {
      resetVendorBundleStateForTests();
      const s3 = await startFakeS3((_req, res) => {
        res.writeHead(status, { "content-type": "application/xml" });
        res.end(xml(code));
      });
      try {
        const error = await ensureVendorBundle("tool", { env: s3Env(s3.endpoint), manifest }).catch((e: unknown) => e as Error);
        expect(String(error)).toMatch(pattern);
        expect(String(error)).not.toContain(SECRET);
        expect(String(error)).not.toContain(ACCESS);
      } finally {
        await s3.close();
      }
    }
  });

  it("redacts signed URL queries and credential values from logged text", () => {
    const env = s3Env("https://s3.example.com");
    const text = `GET https://s3.example.com/b/k?X-Amz-Signature=abc&X-Amz-Credential=${ACCESS} failed with ${SECRET}`;
    const out = redactVendorBundleText(text, env);
    expect(out).not.toMatch(/X-Amz|abc/);
    expect(out).not.toContain(SECRET);
    expect(out).not.toContain(ACCESS);
    expect(out).toContain("https://s3.example.com/b/k?<redacted>");
  });

  it("logs failures without credentials", async () => {
    const { manifest } = bundle();
    const logs: string[] = [];
    const spy = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => void logs.push(args.join(" ")));
    const s3 = await startFakeS3((_req, res) => {
      res.writeHead(403);
      res.end();
    });
    try {
      await prefetchVendorBundles({ env: { ...s3Env(s3.endpoint), DOCSLURP_VENDOR_BUNDLE_PREFETCH: "tool,missing" }, manifest });
      expect(logs.join("\n")).toMatch(/prefetch failed bundle=tool/);
      expect(logs.join("\n")).toMatch(/prefetch failed bundle=missing/);
      expect(logs.join("\n")).not.toContain(SECRET);
      expect(logs.join("\n")).not.toContain(ACCESS);
    } finally {
      spy.mockRestore();
      await s3.close();
    }
  });

  it("prefetch installs listed bundles in the background and never rejects", async () => {
    const { bytes, manifest } = bundle();
    const s3 = await startFakeS3((_req, res) => {
      res.writeHead(200, { "content-length": bytes.length });
      res.end(bytes);
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const env = { ...s3Env(s3.endpoint), DOCSLURP_VENDOR_BUNDLE_PREFETCH: "tool" };
      await prefetchVendorBundles({ env, manifest });
      expect((await installedVendorBundle("tool", { env, manifest }))?.name).toBe("tool");
      await expect(prefetchVendorBundles({ env: {}, manifest })).resolves.toBeUndefined();
    } finally {
      log.mockRestore();
      await s3.close();
    }
  });

  it("never forwards the S3 credentials to bundle env or child processes", () => {
    for (const key of ["DOCSLURP_VENDOR_BUNDLE_S3_ACCESS_KEY_ID", "DOCSLURP_VENDOR_BUNDLE_S3_SECRET_ACCESS_KEY", "DOCSLURP_VENDOR_BUNDLE_S3_ENDPOINT", "DOCSLURP_VENDOR_BUNDLE_BASE_URL", "AWS_ACCESS_KEY_ID", "B2_APPLICATION_KEY_ID", "SOME_ACCESS_KEY_ID"]) {
      expect(FORBIDDEN_ENV.test(key), key).toBe(true);
      expect(() => validateManifest({ schemaVersion: 1, bundles: { x: { env: { [key]: "1" }, artifacts: [] } } })).toThrow(/may not set env/);
    }
    const sourceEnv = { ...s3Env("https://s3.example.com"), PATH: "/usr/bin", LANG: "C" };
    for (const defaultAllowlist of [defaultParserEnvAllowlist, defaultPythonPoolEnvAllowlist]) {
      const child = buildAllowlistedEnv({ defaultAllowlist, sourceEnv });
      expect(Object.keys(child).filter((key) => key.startsWith("DOCSLURP_VENDOR_BUNDLE"))).toEqual([]);
      expect(JSON.stringify(child)).not.toContain(SECRET);
      expect(JSON.stringify(child)).not.toContain(ACCESS);
    }
  });
});
