import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile, copyFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { decodeTextBytes, measuredTextPages } from "@docslurp/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { TextEvidenceCounter, validateTextPagesInspection } from "./text-page-count.js";

const run = promisify(execFile);
const workerRoot = fileURLToPath(new URL("../../", import.meta.url));
const built = existsSync(path.join(workerRoot, "dist/lib/text-pages-guest.js")) && existsSync(path.join(workerRoot, "dist/lib/quarantine-bytes.js"));
if (process.env.CI && !built) throw new Error("CI must build the worker before the worker tests: the text pages guest is missing");

const policy = { quarantineFailOpenOnToolMissing: false, quarantineMaxArchiveEntries: 2000, quarantineMaxArchiveDepth: 12, quarantineMaxTotalUncompressedBytes: 1 << 30, quarantineMaxSingleEntryBytes: 1 << 29, quarantineMaxExpansionRatio: 100 };
const utf16 = (text: string) => new Uint8Array(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]));

/**
 * The real guest entrypoint (scripts/quarantine-inspect.mjs) on fixture files, through the built worker and the built
 * @docslurp/shared subpaths it loads, compared with the shared rule in this process.
 */
describe.skipIf(!built)("the quarantine inspection's text count (real guest script)", () => {
  let dir: string;
  beforeAll(async () => { dir = await mkdtemp(path.join(process.env.TMPDIR || os.tmpdir(), "text-pages-guest-")); });
  afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

  async function inspect(root: string, name: string, content: Uint8Array, text: unknown): Promise<Record<string, unknown>> {
    const input = path.join(dir, name), options = path.join(dir, `${name}.options.json`), output = path.join(dir, `${name}.result.json`);
    await writeFile(input, content);
    await writeFile(options, JSON.stringify({ filename: name, policy, ...(text === undefined ? {} : { text }) }));
    await run(process.execPath, [path.join(root, "scripts/quarantine-inspect.mjs"), input, options, output], { cwd: root });
    return JSON.parse(await readFile(output, "utf8")) as Record<string, unknown>;
  }

  const fixtures: Array<[string, Uint8Array, boolean]> = [
    ["lines.txt", new Uint8Array(Buffer.alloc(200_000, "\n")), false],
    ["long.txt", new Uint8Array(Buffer.alloc(200_000, "x")), false],
    ["rows.csv", new TextEncoder().encode(Array.from({ length: 5000 }, (_, i) => `row${i},value${i}`).join("\r\n")), false],
    ["utf16.csv", utf16(Array.from({ length: 5000 }, (_, i) => `row${i},value${i}`).join("\r\n")), false],
    ["cjk.md", new TextEncoder().encode("日本語の文章。".repeat(3000)), false],
    ["page.html", new TextEncoder().encode(`<html><head><style>${"a{color:red}".repeat(2000)}</style></head><body>${"<p>para</p>\n".repeat(500)}</body></html>`), true],
    ["hostile.txt", new Uint8Array(Buffer.concat([Buffer.from([0xc3, 0x28, 0x00, 0xa0, 0xe2, 0x28]), Buffer.from("<script>".repeat(10_000))])), true],
    ["empty.txt", new Uint8Array(0), false],
  ];

  it.each(fixtures)("%s: the guest's count equals the shared rule and passes the host's bounds", async (name, content, markup) => {
    const result = await inspect(workerRoot, name, content, { markup, force: true });
    const sniffed = result.sniffed as { encoding: Parameters<typeof decodeTextBytes>[1] };
    const decoded = content.length ? decodeTextBytes(content, sniffed.encoding ?? undefined) : "";
    const expected = { bytes: content.length, pages: content.length ? measuredTextPages(decoded) : 1, ...(markup ? { markupPages: content.length ? measuredTextPages(decoded, { markup: true }) : 1 } : {}) };
    expect(result.text).toEqual(expected);
    const counter = new TextEvidenceCounter();
    counter.update(content);
    expect(validateTextPagesInspection(result, counter.result(), sniffed.encoding ?? null)).toEqual(expected);
  });

  it("measures nothing when not asked, or for binary bytes without force", async () => {
    expect(await inspect(workerRoot, "plain.txt", new TextEncoder().encode("hello\n"), undefined)).not.toHaveProperty("text");
    expect((await inspect(workerRoot, "bin.dat", new Uint8Array([0, 1, 2, 3, 0xff, 0, 0, 7]), { markup: false, force: false })).text).toBeNull();
  });

  it("refuses a request it does not expect (the command fails, as any inspection failure)", async () => {
    await expect(inspect(workerRoot, "odd.txt", new TextEncoder().encode("x"), { markup: "yes", force: true })).rejects.toThrow();
  });

  it("an image without the text module still inspects every file; the answer key is only absent", async () => {
    // A minimal image root: this guest script and its inspection module, without lib/text-pages-guest.js.
    const root = path.join(dir, "old-image");
    await mkdir(path.join(root, "scripts"), { recursive: true });
    await mkdir(path.join(root, "dist/lib"), { recursive: true });
    await copyFile(path.join(workerRoot, "scripts/quarantine-inspect.mjs"), path.join(root, "scripts/quarantine-inspect.mjs"));
    await writeFile(path.join(root, "dist/lib/quarantine-bytes.js"), "export function inspectQuarantineBytes() { return { sniffed: { mimeType: \"text/plain\", container: null, encoding: \"utf-8\" }, archive: null, pdf: null }; }\n");
    const result = await inspect(root, "notes.txt", new TextEncoder().encode("a\nb\n"), { markup: false, force: true });
    expect(result.sniffed).toEqual({ mimeType: "text/plain", container: null, encoding: "utf-8" });
    expect(result).not.toHaveProperty("text");
  });
});
