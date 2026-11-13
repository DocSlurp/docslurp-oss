/** Image codecs run through the parser VM in production, including metadata and generated rasters. */
import type sharp from "sharp";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveScriptsDir } from "./scripts-dir.js";
import { vmOnlyParsing } from "../lib/vm-only-parsing.js";
import { GUEST_NODE_FLAGS } from "../sandbox/guest-node-flags.js";

const MAX_BYTES = 64 * 1024 * 1024;
const METHODS = new Set(["rotate", "flatten", "resize", "png", "jpeg", "webp", "raw", "extract", "composite", "greyscale", "grayscale", "toColourspace", "toColorspace"]);
interface Operation { method: string; args: unknown[] }

async function encode(value: unknown): Promise<unknown> {
  if (value instanceof Uint8Array) {
    if (value.byteLength > MAX_BYTES) throw new Error("image task exceeds input limit");
    return { $bytes: Buffer.from(value).toString("base64") };
  }
  if (Array.isArray(value)) return Promise.all(value.map(encode));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      // Composite file inputs are bytes in the request, never arbitrary guest paths.
      out[key] = await encode(key === "input" && typeof child === "string" ? await boundedRead(child) : child);
    }
    return out;
  }
  return value;
}

function decode(value: unknown, depth = 0): unknown {
  if (depth > 16) throw new Error("image result exceeds nesting limit");
  if (Array.isArray(value)) return value.map((child) => decode(child, depth + 1));
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (typeof obj.$bytes === "string") return Buffer.from(obj.$bytes, "base64");
    return Object.fromEntries(Object.entries(obj).map(([key, child]) => [key, decode(child, depth + 1)]));
  }
  return value;
}

async function boundedRead(file: string): Promise<Buffer> {
  if ((await stat(file)).size > MAX_BYTES) throw new Error("image task exceeds file limit");
  const bytes = await readFile(file);
  if (bytes.length > MAX_BYTES) throw new Error("image task exceeds file limit");
  return bytes;
}

async function execute(input: unknown, options: unknown, operations: Operation[], terminal: string, args: unknown[]): Promise<unknown> {
  if (!vmOnlyParsing()) {
    const { default: localSharp } = await import("sharp");
    let image = localSharp(input as never, options as never);
    for (const op of operations) image = Reflect.apply(Reflect.get(image, op.method), image, op.args);
    return Reflect.apply(Reflect.get(image, terminal), image, args);
  }
  const source = typeof input === "string" ? await boundedRead(input) : input;
  const request = JSON.stringify(await encode({ input: source, options, operations, terminal, args }));
  if (Buffer.byteLength(request) > MAX_BYTES) throw new Error("image task exceeds request limit");
  const dir = await mkdtemp(path.join(tmpdir(), "docslurp-image-"));
  try {
    const requestFile = path.join(dir, "request.json");
    const resultFile = path.join(dir, "result.json");
    await writeFile(requestFile, request, { mode: 0o600 });
    const { CommandRunner } = await import("./runner.js");
    const runner = new CommandRunner();
    await runner.run({ binary: "node", args: [...GUEST_NODE_FLAGS, path.join(resolveScriptsDir(), "image-task.mjs"), requestFile, resultFile], available: true, readOnlyInputs: true, timeoutMs: 60_000 });
    const result = decode(JSON.parse((await boundedRead(resultFile)).toString("utf8")));
    if (terminal === "metadata" || (args[0] as { resolveWithObject?: boolean } | undefined)?.resolveWithObject) {
      const info = (terminal === "metadata" ? result : (result as { info?: unknown })?.info) as Record<string, unknown> | undefined;
      if (!info || typeof info !== "object") throw new Error("invalid image metadata result");
      for (const key of ["width", "height", "channels"] as const) if (info[key] !== undefined && (!Number.isSafeInteger(info[key]) || (info[key] as number) < 1 || (info[key] as number) > 40_000_000)) throw new Error("invalid image dimensions");
      if (typeof info.width === "number" && typeof info.height === "number" && info.width * info.height > 40_000_000) throw new Error("image result exceeds pixel limit");
    }
    if (terminal === "toBuffer") {
      const data = (args[0] as { resolveWithObject?: boolean } | undefined)?.resolveWithObject ? (result as { data?: unknown })?.data : result;
      if (!(data instanceof Uint8Array)) throw new Error("invalid image bytes result");
    }
    return result;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const isolatedSharp = ((input: unknown, options?: unknown) => {
  const operations: Operation[] = [];
  const chain = new Proxy({}, {
    get(_target, method: string) {
      if (method === "metadata" || method === "toBuffer") return (...args: unknown[]) => execute(input, options, operations, method, args);
      if (method === "toFile") return async (file: string) => {
        const result = await execute(input, options, operations, "toBuffer", [{ resolveWithObject: true }]) as { data: Buffer; info: unknown };
        await writeFile(file, result.data);
        return result.info;
      };
      if (!METHODS.has(method)) throw new Error(`unsupported isolated image operation: ${method}`);
      return (...args: unknown[]) => { operations.push({ method, args }); return chain; };
    },
  });
  return chain;
}) as typeof sharp;

export default isolatedSharp;
