import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { Worker } from "node:worker_threads";

import { applyProbe, createEstimator, estimateEvents, estimateFiles, EstimatorError } from "../js/index.mjs";
import { createEstimateWorker } from "../js/client.mjs";
import { estimatePaths, quotePaths } from "../js/node.mjs";
import { READ_CHUNK_BYTES } from "../js/run.mjs";
import { lazyObjectStreamBomb } from "./hostile.mjs";

const fixturePath = (name) => new URL(`../tests/fixtures/${name}`, import.meta.url).pathname;
const fixture = (name, as = name) => new File([readFileSync(fixturePath(name))], as, { type: "application/pdf" });
const estimator = await createEstimator();
const MiB = 1024 * 1024;

/** A file the test controls: `size` bytes of zeros (no allocation up front), optional delay per read, call log. */
function synthetic(name, size, { delayMs = 0, log, fail, type } = {}) {
  return {
    name,
    size,
    ...(type ? { type } : {}),
    async open() {
      log?.opens.push(name);
      if (log) log.open += 1;
      return {
        async read(position, length) {
          if (fail) throw new Error(fail);
          if (delayMs) await sleep(delayMs);
          if (log) log.reads.push([name, position, length]);
          return new Uint8Array(Math.min(length, size - position));
        },
        close() {
          if (log) log.open -= 1;
        },
      };
    },
  };
}

function eventsByFile(events) {
  const byFile = new Map();
  for (const event of events) {
    if (!event.file) continue;
    if (!byFile.has(event.file.index)) byFile.set(event.file.index, []);
    byFile.get(event.file.index).push(event.type);
  }
  return byFile;
}

describe("estimateFiles: events", () => {
  it("emits start, read, probe and done per file, batch-done per batch and quote-done last", async () => {
    const files = [fixture("scan_plain.pdf"), fixture("text_wrapped_with_photo.pdf"), new File(["hello world\n".repeat(50)], "notes.txt"), fixture("scan_glyph_title.pdf")];
    const events = [];
    const result = await estimateFiles(estimator, files, { batchSize: 3, onProgress: (event) => events.push(event) });

    assert.equal(events.at(-1).type, "quote-done");
    assert.equal(events.filter((event) => event.type === "quote-done").length, 1);
    assert.equal(events.filter((event) => event.type === "batch-done").length, 2);
    for (const [index, types] of eventsByFile(events)) {
      const compact = types.filter((type, at) => type !== "read-progress" || types[at - 1] !== "read-progress");
      assert.deepEqual(compact, ["file-start", "read-progress", "probe-start", "probe-done", "file-done"], `file ${index}`);
    }
    // Counters only move forward and the last event agrees with the result.
    for (let at = 1; at < events.length; at += 1) {
      assert.ok(events[at].files.completed >= events[at - 1].files.completed);
      assert.ok(events[at].bytes.read >= events[at - 1].bytes.read);
      assert.ok(events[at].elapsedMs >= events[at - 1].elapsedMs);
    }
    const last = events.at(-1);
    assert.deepEqual(last.files, { total: 4, completed: 4, probed: 4, failed: 0, skipped: 0 });
    assert.equal(result.stats.files.probed, 4);
    assert.equal(result.partial, false);
    assert.equal(result.cancelled, false);
  });

  it("reports measurable work as bytes and opaque probe work as stage and time only", async () => {
    const files = [fixture("scan_plain.pdf"), new File(["x".repeat(3 * MiB)], "big.txt")];
    const events = [];
    const result = await estimateFiles(estimator, files, { onProgress: (event) => events.push(event) });
    for (const event of events) {
      const json = JSON.stringify(event, (key, value) => (key === "result" || key === "quote" ? undefined : value));
      assert.doesNotMatch(json, /"[a-z]*(percent|ratio|fraction)[a-z]*":/i, `${event.type} carries no invented percentage`);
    }
    for (const event of events.filter((candidate) => candidate.type === "probe-start" || candidate.type === "probe-done")) assert.equal(event.stage, "probe");
    // Bytes read are exactly the read plans, chunk by chunk.
    const planned = files.reduce((sum, file) => {
      const plan = estimator.readPlan({ name: file.name, size: file.size, type: file.type || undefined });
      return sum + plan.head + plan.tail;
    }, 0);
    assert.equal(events[0].bytes.planned, planned);
    assert.equal(result.stats.bytes.read, planned);
    const big = events.filter((event) => event.type === "read-progress" && event.file.index === 1);
    assert.equal(big.length, Math.ceil(files[1].size / READ_CHUNK_BYTES));
    assert.equal(big.at(-1).fileBytesRead, big.at(-1).filePlannedBytes);
    const probeDone = events.filter((event) => event.type === "probe-done");
    assert.ok(probeDone.every((event) => typeof event.probeMs === "number" && event.probeMs >= 0));
  });

  it("reads only the head and tail of large media, and says so in the stats", async () => {
    const log = { opens: [], reads: [], open: 0 };
    const film = synthetic("film.mov", 2e9, { log });
    const result = await estimateFiles(estimator, [film]);
    assert.equal(result.stats.bytes.files, 2e9);
    assert.equal(result.stats.bytes.read, 12 * MiB);
    assert.equal(result.stats.bytes.planned, 12 * MiB);
    assert.ok(result.stats.bytes.readShare < 0.01);
    assert.equal(Math.max(...log.reads.map(([, , length]) => length)), READ_CHUNK_BYTES);
    assert.equal(log.reads.at(-1)[1] + log.reads.at(-1)[2], 2e9, "the tail ends at the end of the file");
  });

  it("quotes exactly what the simple API quotes for the same files", async () => {
    const files = [fixture("scan_plain.pdf"), fixture("text_wrapped_with_photo.pdf"), new File(["a,b\n1,2\n"], "rows.csv")];
    const simple = await estimator.quoteFiles(files);
    const result = await estimateFiles(estimator, files);
    assert.deepEqual(result.quote.estimate, simple.estimate);
    assert.deepEqual(result.files.map((file) => file.probe), simple.probes);
    assert.deepEqual(result.files.map((file) => file.quoteFile), files.map((file, index) => applyProbe({ name: file.name, size: file.size, ...(file.type ? { type: file.type } : {}) }, simple.probes[index])));
    const paths = await estimatePaths(estimator, [fixturePath("scan_plain.pdf"), fixturePath("text_wrapped_with_photo.pdf")]);
    const viaPaths = await quotePaths(estimator, [fixturePath("scan_plain.pdf"), fixturePath("text_wrapped_with_photo.pdf")]);
    assert.deepEqual(paths.quote.estimate, viaPaths.estimate);
  });

  it("summarizes pages, mix confidence, timing and throughput", async () => {
    const files = [fixture("scan_plain.pdf"), fixture("text_wrapped_with_photo.pdf")];
    const { stats } = await estimateFiles(estimator, files);
    assert.equal(stats.pages.found, 2);
    assert.equal(stats.pages.files, 2);
    assert.equal(stats.mixConfidence.files, 2);
    assert.ok(stats.mixConfidence.min > 0 && stats.mixConfidence.max <= 1);
    assert.ok(stats.probeMs.p50 <= stats.probeMs.p95 && stats.probeMs.p95 <= stats.probeMs.max);
    assert.ok(stats.throughput.filesPerSecond > 0 && stats.throughput.megabytesPerSecond > 0);
    assert.deepEqual(stats.estimator, { crashes: 0, resets: 0 });
  });

  it("works as an async iterator ending with the result", async () => {
    const types = [];
    let result;
    for await (const event of estimateEvents(estimator, [fixture("scan_plain.pdf")])) {
      types.push(event.type);
      if (event.type === "quote-done") result = event.result;
    }
    assert.deepEqual(types, ["file-start", "read-progress", "probe-start", "probe-done", "file-done", "batch-done", "quote-done"]);
    assert.equal(result.stats.files.probed, 1);
  });

  it("refuses a profile from a newer card before reading anything", async () => {
    const log = { opens: [], reads: [], open: 0 };
    const card = estimator.card();
    await assert.rejects(
      estimateFiles(estimator, [synthetic("a.pdf", 10, { log })], { profile: { ...card.defaultProfile, quality: "ultra" } }),
      (error) => error instanceof EstimatorError && error.code === "unsupported_rules",
    );
    assert.equal(log.opens.length, 0);
  });
});

describe("estimateFiles: cancellation", () => {
  it("stops between files and quotes the finished ones plus size-only assumptions for the rest", async () => {
    const controller = new AbortController();
    const files = Array.from({ length: 200 }, (_, index) => synthetic(`doc-${index}.txt`, 4_000, { delayMs: 2 }));
    const events = [];
    let abortedAt = 0;
    const result = await estimateFiles(estimator, files, {
      signal: controller.signal,
      batchSize: 8,
      onProgress: (event) => {
        events.push(event);
        if (event.type === "file-done" && event.files.completed === 10) {
          abortedAt = performance.now();
          controller.abort();
        }
      },
    });
    const stoppedAfterMs = performance.now() - abortedAt;
    assert.ok(stoppedAfterMs < 100, `stopped ${stoppedAfterMs} ms after the abort`);
    assert.equal(result.cancelled, true);
    assert.equal(result.partial, true);
    assert.ok(result.stats.files.probed >= 10 && result.stats.files.probed <= 11, `probed ${result.stats.files.probed}`);
    assert.equal(result.stats.files.probed + result.stats.files.skipped, 200);
    assert.equal(result.sizeOnlyFiles, result.stats.files.skipped);
    // No file starts after the abort; every file is in the quote, measured or not.
    const abortIndex = events.findIndex((event) => event.type === "file-done" && event.files.completed === 10);
    assert.ok(events.slice(abortIndex + 1).filter((event) => event.type === "file-start").length <= 1);
    assert.equal(result.quote.estimate.documents, 200);
    const skipped = result.files.filter((file) => file.status === "skipped");
    assert.ok(skipped.every((file) => file.reason.code === "cancelled" && !file.measured && file.quoteFile.pages === undefined));
    assert.ok(result.files.slice(0, 10).every((file) => file.status === "probed" && file.measured && file.quoteFile.pages > 0));
    assert.equal(events.at(-1).type, "quote-done");
    assert.equal(events.at(-1).cancelled, true);
  });

  it("stops in the middle of a large read", async () => {
    const controller = new AbortController();
    const log = { opens: [], reads: [], open: 0 };
    const big = synthetic("huge.pdf", 60 * MiB, { delayMs: 5, log });
    setTimeout(() => controller.abort(), 40);
    const started = performance.now();
    const result = await estimateFiles(estimator, [big, synthetic("next.pdf", 10)], { signal: controller.signal, concurrency: 1 });
    assert.ok(performance.now() - started < 200);
    assert.equal(result.files[0].status, "skipped");
    assert.equal(result.files[0].reason.code, "cancelled");
    assert.ok(result.files[0].bytesRead > 0 && result.files[0].bytesRead < 60 * MiB);
    assert.equal(log.open, 0, "the file was closed");
    assert.equal(result.files[1].status, "skipped");
    assert.ok(result.quote, "still quoted from sizes");
  });

  it("returns at once for a signal that is already aborted", async () => {
    const result = await estimateFiles(estimator, [fixture("scan_plain.pdf")], { signal: AbortSignal.abort() });
    assert.equal(result.cancelled, true);
    assert.equal(result.files[0].status, "skipped");
    assert.equal(result.stats.bytes.read, 0);
  });
});

describe("estimateFiles: failures stay per file", () => {
  it("prices corrupt, unreadable and crashing files from their size and finishes the batch", async () => {
    const fresh = await createEstimator();
    const bomb = lazyObjectStreamBomb();
    const files = [
      fixture("scan_plain.pdf"),
      new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0, 1, 2, 3])], "corrupt.pdf", { type: "application/pdf" }),
      synthetic("gone.pdf", 5_000, { fail: "NotReadableError: the file changed on disk" }),
      new File([bomb], "bomb.pdf", { type: "application/pdf" }),
      fixture("text_wrapped_with_photo.pdf"),
    ];
    const result = await estimateFiles(fresh, files);
    assert.equal(result.files.length, 5);
    assert.equal(result.files[0].status, "probed");
    assert.equal(result.files[4].status, "probed");
    assert.equal(result.files[2].status, "failed");
    assert.equal(result.files[2].reason.code, "read_failed");
    assert.deepEqual(result.files[2].quoteFile, { name: "gone.pdf", size: 5_000 });
    // The first oversized parse on a fresh memory traps; the estimator resets and the next file still probes.
    const crashed = result.files[3];
    assert.equal(result.stats.estimator.crashes, fresh.health().crashes);
    if (crashed.status === "failed") {
      assert.equal(crashed.reason.code, "crashed");
      assert.equal(result.stats.estimator.resets, 1);
    }
    assert.ok(result.quote.estimate.credits.high > 0);
    assert.equal(result.partial, result.files.some((file) => !file.measured));
  });

  it("isolates an estimator crash with a reason", async () => {
    const crashing = Object.create(estimator);
    crashing.probe = (file, head, tail) => {
      if (file.name === "trap.pdf") throw new EstimatorError("crashed", "the estimator stopped on this input (unreachable)");
      return estimator.probe(file, head, tail);
    };
    const events = [];
    const result = await estimateFiles(crashing, [fixture("trap.pdf".replace("trap", "scan_plain"), "trap.pdf"), fixture("scan_plain.pdf")], { onProgress: (event) => events.push(event) });
    assert.equal(result.files[0].status, "failed");
    assert.equal(result.files[0].reason.code, "crashed");
    assert.match(result.files[0].reason.message, /priced from name, type and size/);
    assert.equal(result.files[1].status, "probed");
    const done = events.find((event) => event.type === "probe-done" && event.file.index === 0);
    assert.equal(done.ok, false);
    assert.equal(result.stats.files.failed, 1);
  });
});

describe("estimateFiles: bounds", () => {
  it("keeps reads, buffered bytes and open files within their caps over many files", async () => {
    const log = { opens: [], reads: [], open: 0 };
    let maxOpen = 0;
    const files = Array.from({ length: 600 }, (_, index) => {
      const source = synthetic(`f-${index}.txt`, MiB, { log, delayMs: index % 7 === 0 ? 1 : 0 });
      const open = source.open;
      source.open = async () => {
        const handle = await open();
        maxOpen = Math.max(maxOpen, log.open);
        return handle;
      };
      return source;
    });
    let events = 0;
    const result = await estimateFiles(estimator, files, { concurrency: 3, batchSize: 50, maxBufferedBytes: 2 * MiB, onProgress: () => (events += 1) });
    assert.equal(result.stats.files.probed, 600);
    assert.ok(result.stats.bounds.peakInFlight <= 3);
    assert.ok(maxOpen <= 3, `max open ${maxOpen}`);
    assert.ok(result.stats.bounds.peakBufferedBytes <= 2 * MiB, `peak ${result.stats.bounds.peakBufferedBytes}`);
    // Five events per one-chunk file, one per batch, one quote-done.
    assert.equal(events, 600 * 5 + 12 + 1);
  });

  it("pauses the run when an event consumer falls behind, instead of queueing", async () => {
    const log = { opens: [], reads: [], open: 0 };
    const files = Array.from({ length: 300 }, (_, index) => synthetic(`f-${index}.txt`, 100, { log }));
    let consumed = 0;
    let maxAhead = 0;
    for await (const event of estimateEvents(estimator, files, { highWaterMark: 16 })) {
      consumed += 1;
      // Each opened file produces at least two events before its read can finish.
      maxAhead = Math.max(maxAhead, log.opens.length * 5 - consumed);
      if (event.type === "file-done" && event.files.completed % 50 === 0) await sleep(5);
    }
    assert.equal(log.opens.length, 300);
    assert.ok(maxAhead <= 16 + 5 * 2, `the run got ${maxAhead} events ahead`);
  });
});

describe("estimate worker", () => {
  const startWorker = () => new Worker(new URL("./node-worker.mjs", import.meta.url));

  it("posts the same events and result from a worker thread", async () => {
    const client = createEstimateWorker(startWorker());
    try {
      const events = [];
      const result = await client.estimate([fixture("scan_plain.pdf"), fixture("text_wrapped_with_photo.pdf")], { onProgress: (event) => events.push(event) });
      assert.equal(result.stats.files.probed, 2);
      assert.equal(events.at(-1).type, "quote-done");
      assert.equal(events.at(-1).result, undefined, "the result travels once");
      assert.deepEqual(result.quote.estimate, (await estimateFiles(estimator, [fixture("scan_plain.pdf"), fixture("text_wrapped_with_photo.pdf")])).quote.estimate);
    } finally {
      client.terminate();
    }
  });

  it("keeps the calling thread responsive while the worker probes heavy files", async () => {
    const bomb = lazyObjectStreamBomb(8, 15_900_000);
    const files = Array.from({ length: 4 }, (_, index) => new File([bomb], `heavy-${index}.pdf`, { type: "application/pdf" }));
    const measure = async (run) => {
      const histogram = monitorEventLoopDelay({ resolution: 5 });
      histogram.enable();
      const started = performance.now();
      const result = await run();
      histogram.disable();
      return { result, maxMs: histogram.max / 1e6, p99Ms: histogram.percentile(99) / 1e6, wallMs: performance.now() - started };
    };
    const inline = await measure(async () => estimateFiles(await createEstimator(), files));
    const client = createEstimateWorker(startWorker());
    let threaded;
    try {
      await client.estimate([fixture("scan_plain.pdf")]); // compile the module before measuring
      threaded = await measure(() => client.estimate(files));
    } finally {
      client.terminate();
    }
    console.log(`event-loop delay while probing 4 heavy PDFs: inline max ${inline.maxMs.toFixed(1)} ms (p99 ${inline.p99Ms.toFixed(1)}), worker max ${threaded.maxMs.toFixed(1)} ms (p99 ${threaded.p99Ms.toFixed(1)}); wall ${inline.wallMs.toFixed(0)} vs ${threaded.wallMs.toFixed(0)} ms`);
    assert.equal(threaded.result.files.length, 4);
    assert.ok(inline.maxMs > 100, `inline probing blocks the loop (${inline.maxMs} ms)`);
    assert.ok(threaded.maxMs < 50, `worker keeps the loop free (${threaded.maxMs} ms)`);
    assert.ok(threaded.maxMs * 4 < inline.maxMs);
  });

  it("returns a partial result when aborted, and stops a worker that does not answer in time", async () => {
    const client = createEstimateWorker(startWorker());
    try {
      const controller = new AbortController();
      const files = [fixture("scan_plain.pdf"), ...Array.from({ length: 40 }, (_, index) => new File(["word ".repeat(400)], `n-${index}.txt`))];
      const result = await client.estimate(files, {
        signal: controller.signal,
        batchSize: 4,
        onProgress: (event) => {
          if (event.type === "file-done" && event.files.completed === 3) controller.abort();
        },
      });
      assert.equal(result.cancelled, true);
      assert.ok(result.quote, "the worker answered with its own partial quote");
      assert.ok(result.stats.files.skipped > 0 && result.stats.files.probed >= 3);
    } finally {
      client.terminate();
    }

    const stuck = createEstimateWorker(startWorker());
    const controller = new AbortController();
    const bomb = lazyObjectStreamBomb();
    const pending = stuck.estimate([fixture("scan_plain.pdf"), new File([bomb], "slow.pdf", { type: "application/pdf" })], {
      signal: controller.signal,
      concurrency: 1,
      abortGraceMs: 30,
      onProgress: (event) => {
        if (event.type === "probe-start" && event.file.index === 1) controller.abort();
      },
    });
    const started = performance.now();
    const result = await pending;
    assert.ok(performance.now() - started < 400, "a stuck worker is stopped after the grace period");
    assert.equal(result.quote, null);
    assert.equal(result.files[0].status, "probed", "files finished before the abort are kept");
    assert.equal(result.files[1].status, "skipped");
    await assert.rejects(stuck.estimate([fixture("scan_plain.pdf")]), (error) => error.code === "worker_failed");
  });
});
