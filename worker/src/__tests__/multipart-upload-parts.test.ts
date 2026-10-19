import { describe, expect, it } from "vitest";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import { ArtifactStore } from "../tools/storage.js";

const MIB = 1024 * 1024;
const PART = 5 * MIB;

type Call = { name: string; input: Record<string, any> };

/** Fake S3 client that records commands and enforces R2's "equal non-trailing parts" rule on Complete. */
function createFakeClient(opts: { failOnPart?: number } = {}) {
  const calls: Call[] = [];
  const parts = new Map<number, { size: number; hash: string }>();
  const client = {
    async send(command: { constructor: { name: string }; input: Record<string, any> }) {
      const name = command.constructor.name;
      calls.push({ name, input: command.input });
      if (name === "CreateMultipartUploadCommand") return { UploadId: "u1" };
      if (name === "UploadPartCommand") {
        if (opts.failOnPart === command.input.PartNumber) throw new Error("boom");
        const body = Buffer.from(command.input.Body as Uint8Array);
        expect(command.input.ContentLength).toBe(body.length);
        parts.set(command.input.PartNumber, { size: body.length, hash: createHash("sha256").update(body).digest("hex") });
        return { ETag: `"e${command.input.PartNumber}"` };
      }
      if (name === "CompleteMultipartUploadCommand") {
        const list = command.input.MultipartUpload.Parts as Array<{ PartNumber: number }>;
        const sizes = list.map((p) => parts.get(p.PartNumber)!.size);
        for (const s of sizes.slice(0, -1)) {
          if (s !== sizes[0]) throw new Error("InvalidPart: All non-trailing parts must have the same length");
        }
        return {};
      }
      return {};
    },
  };
  return { client, calls };
}

function makeStore(client: unknown) {
  const store = Object.create(ArtifactStore.prototype) as Record<string, unknown>;
  store.bucket = "b";
  store.client = client;
  return store as unknown as ArtifactStore;
}

async function run(writes: number[], opts: { failOnPart?: number } = {}) {
  const { client, calls } = createFakeClient(opts);
  const store = makeStore(client);
  const upload = store.createMultipartUploadStream("k", "application/octet-stream", { partSizeBytes: PART });
  const source = createHash("sha256");
  const chunks = writes.map((n, i) => {
    const buf = Buffer.alloc(n, i % 251);
    source.update(buf);
    return buf;
  });
  await Promise.all([
    new Promise<void>((resolve, reject) => {
      Readable.from(chunks, { objectMode: false }).pipe(upload.writable).on("finish", resolve).on("error", reject);
    }),
    upload.done,
  ]);
  const partCalls = calls.filter((c) => c.name === "UploadPartCommand");
  return { calls, sizes: partCalls.map((c) => (c.input.Body as Uint8Array).length) };
}

function expectEqualNonTrailing(sizes: number[], total: number) {
  expect(sizes.reduce((a, b) => a + b, 0)).toBe(total);
  for (const s of sizes.slice(0, -1)) expect(s).toBe(PART);
  expect(sizes.at(-1)!).toBeGreaterThan(0);
  expect(sizes.at(-1)!).toBeLessThanOrEqual(PART);
}

describe("MultipartUploadWriter part sizing", () => {
  it("cuts equal parts when writes straddle part boundaries", async () => {
    const writes = [3 * MIB, 4 * MIB, 6 * MIB, 1 * MIB, 7 * MIB, 123];
    const { sizes } = await run(writes);
    expectEqualNonTrailing(sizes, writes.reduce((a, b) => a + b, 0));
  });

  it("splits a single huge write into equal parts", async () => {
    const { sizes } = await run([23 * MIB + 17]);
    expect(sizes).toEqual([PART, PART, PART, PART, 3 * MIB + 17]);
  });

  it("handles many tiny writes", async () => {
    const writes = Array.from({ length: 12_000 }, () => 1000);
    const { sizes } = await run(writes);
    expectEqualNonTrailing(sizes, 12_000_000);
  });

  it("emits no short trailing part when total is exactly N x partSize", async () => {
    const { sizes, calls } = await run([PART, 2 * MIB, 3 * MIB, PART]);
    expect(sizes).toEqual([PART, PART, PART]);
    expect(calls.at(-1)!.name).toBe("CompleteMultipartUploadCommand");
  });

  it("uploads a sub-part-size object as a single trailing part", async () => {
    const { sizes } = await run([1000, 2000]);
    expect(sizes).toEqual([3000]);
  });

  it("writes an empty object with a plain PutObject", async () => {
    const { calls } = await run([]);
    expect(calls.map((c) => c.name)).toEqual(["PutObjectCommand"]);
  });

  it("aborts the multipart upload when a part fails", async () => {
    await expect(run([PART, PART, PART], { failOnPart: 2 })).rejects.toThrow("boom");
  });

  it("aborts and reports the failure (abort command sent)", async () => {
    const { client, calls } = createFakeClient({ failOnPart: 2 });
    const upload = makeStore(client).createMultipartUploadStream("k", "x", { partSizeBytes: PART });
    const done = upload.done.catch((e) => e);
    upload.writable.on("error", () => {});
    upload.writable.write(Buffer.alloc(PART));
    upload.writable.write(Buffer.alloc(PART));
    upload.writable.end(Buffer.alloc(PART));
    expect(((await done) as Error).message).toBe("boom");
    expect(calls.some((c) => c.name === "AbortMultipartUploadCommand")).toBe(true);
  });
});
