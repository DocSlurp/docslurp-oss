// Runs only inside a parser sandbox. Never import this module into the worker.
import sharp from "sharp";
import { readFile, stat, writeFile } from "node:fs/promises";
const MAX_BYTES = 64 * 1024 * 1024;
const methods = new Set(["rotate", "flatten", "resize", "png", "jpeg", "webp", "raw", "extract", "composite", "greyscale", "grayscale", "toColourspace", "toColorspace"]);
function revive(value) {
  if (Array.isArray(value)) return value.map(revive);
  if (value && typeof value === "object") {
    if (typeof value.$bytes === "string") return Buffer.from(value.$bytes, "base64");
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, revive(v)]));
  }
  return value;
}
function encode(value) {
  if (value instanceof Uint8Array) return { $bytes: Buffer.from(value).toString("base64") };
  if (Array.isArray(value)) return value.map(encode);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, encode(v)]));
  return value;
}
const [requestFile, resultFile] = process.argv.slice(2);
if ((await stat(requestFile)).size > MAX_BYTES) throw new Error("image request exceeds limit");
const request = revive(JSON.parse(await readFile(requestFile, "utf8")));
if (!["metadata", "toBuffer"].includes(request.terminal) || !Array.isArray(request.operations) || request.operations.length > 32) throw new Error("invalid image task");
// Strings would let a compromised caller select paths or invoke special image loaders.
if (!(request.input instanceof Uint8Array) && !request.input?.create) throw new Error("image input must be bytes or a generated canvas");
const options = { ...request.options, limitInputPixels: 40_000_000 };
let image = request.input instanceof Uint8Array
  ? sharp(request.input, options)
  : sharp({ ...options, create: request.input.create });
for (const op of request.operations) {
  if (!methods.has(op.method) || !Array.isArray(op.args)) throw new Error("invalid image operation");
  image = Reflect.apply(Reflect.get(image, op.method), image, op.args);
}
const output = JSON.stringify(encode(await Reflect.apply(Reflect.get(image, request.terminal), image, request.args)));
if (Buffer.byteLength(output) > MAX_BYTES) throw new Error("image result exceeds limit");
await writeFile(resultFile, output, { mode: 0o600 });
