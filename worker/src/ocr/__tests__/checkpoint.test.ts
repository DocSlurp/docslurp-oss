import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OcrDocumentInput } from "../read-document.js";
import { ocrDocument } from "../read-document.js";
import { cleanOcrCheckpoint } from "../checkpoint.js";
import { PipelineUsageEventLedger } from "../../pipeline/usage-ledger.js";
import { fakeOcrRunner } from "../../test/fake-ocr.js";
import type { ProjectRun } from "../../models.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), "ocr-retry-test-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

async function fixture() {
  const source = path.join(dir, "source.pdf");
  await writeFile(source, "synthetic opaque source");
  const objects = new Map<string, Buffer>();
  const storage = {
    getBytes: vi.fn(async (key: string) => {
      const value = objects.get(key);
      if (!value) throw Object.assign(new Error("absent"), { name: "NoSuchKey" });
      return value;
    }),
    putBytes: vi.fn(async (key: string, bytes: Uint8Array) => { objects.set(key, Buffer.from(bytes)); }),
    deleteKeys: vi.fn(async (keys: string[]) => { keys.forEach(key => objects.delete(key)); }),
  };
  const fake = fakeOcrRunner(() => [{ frame: 1, text: "Read once" }]);
  const state = () => {
    const usageLedger = new PipelineUsageEventLedger();
    usageLedger.runId = "run";
    return { usageLedger, run: { orgId: "org", userId: "user", id: "run" } as ProjectRun };
  };
  const input = { runner: fake.runner, state: state(), checkpointStorage: storage,
    documentId: "doc", source, kind: "pdf" as const, pages: [1], stage: "extract-markdown",
    env: { DOCSLURP_OCR_MODE: "vm", DOCSLURP_OCR_SCRATCH_DIR: dir, DOCSLURP_OCR_PAGE_READER: "off", DOCSLURP_OCR_ESCALATION: "off" } };
  return { input, state, objects, storage, fake };
}

it("reuses base text across a failed publication and fresh worker ledger, charges Rich once per run/page and deletes after completion", async () => {
  const { input, state, objects, fake } = await fixture();
  const publish = vi.fn().mockRejectedValueOnce(new Error("injected publication outage")).mockResolvedValue(undefined);
  const first = await ocrDocument(input);
  await expect(publish(first)).rejects.toThrow("outage");
  const retry: OcrDocumentInput = { ...input, state: state() };
  const second = await ocrDocument(retry);
  await publish(second);
  expect(second.pages).toEqual(first.pages);
  expect(fake.jobs).toHaveLength(1);
  expect(second.chargedPages).toEqual([1]);
  await cleanOcrCheckpoint(retry.state, "doc", input.stage);
  expect(objects.size).toBe(0);
});

it.each(["tenant", "document", "settings", "hash"])("does not reuse when %s changes", async change => {
  const { input, state, fake } = await fixture();
  await ocrDocument(input);
  const retry: OcrDocumentInput = { ...input, state: state() };
  if (change === "tenant") retry.state.run!.orgId = "another";
  if (change === "document") retry.documentId = "another";
  if (change === "settings") retry.languageSetting = "eng";
  if (change === "hash") await writeFile(input.source, "different source");
  await ocrDocument(retry);
  expect(fake.jobs).toHaveLength(2);
});

it("refuses corrupted checkpoints without a new provider read", async () => {
  const { input, objects, fake } = await fixture();
  await ocrDocument(input);
  for (const key of objects.keys()) objects.set(key, Buffer.from('{"payload":"corrupt"}'));
  await expect(ocrDocument(input)).rejects.toThrow();
  expect(fake.jobs).toHaveLength(1);
});

it("cancellation refuses both cache hits and new reads", async () => {
  const { input, fake } = await fixture();
  await ocrDocument(input);
  await expect(ocrDocument({ ...input, signal: AbortSignal.abort() })).rejects.toThrow();
  expect(fake.jobs).toHaveLength(1);
});

it("storage lookup outage never silently starts another provider read", async () => {
  const { input, storage, fake } = await fixture();
  storage.getBytes.mockRejectedValueOnce(new Error("injected storage outage"));
  await expect(ocrDocument(input)).rejects.toThrow("checkpoint lookup failed");
  expect(fake.jobs).toHaveLength(0);
});

it("restores escalation frames while retaining the established second-read accounting path", async () => {
  const { input, state, fake } = await fixture();
  const low = fakeOcrRunner(() => [{ frame: 1, text: "Base words", meanConfidence: 0.2, image: true }]);
  const read = vi.fn(async (page: { imagePath: string }) => {
    const { readFile } = await import("node:fs/promises");
    expect((await readFile(page.imagePath)).length).toBeGreaterThan(0);
    return { text: "Escalated words", model: "test-hosted", inputTokens: 1, outputTokens: 1, costCents: 1 };
  });
  const request = { ...input, runner: low.runner, env: { ...input.env, DOCSLURP_OCR_ESCALATION: "on" }, hostedReader: { read } };
  await ocrDocument(request);
  const retry = { ...request, state: state() };
  const result = await ocrDocument(retry);
  expect(result.pages[0]!.text).toBe("Escalated words");
  expect(low.jobs).toHaveLength(1);
  // Both calls enter the existing hosted reader, which owns durable escalation-read reuse and cost recording.
  expect(read).toHaveBeenCalledTimes(2);
  expect(fake.jobs).toHaveLength(0);
});

it("replays the same deterministic charge id without replaying measured base compute", async () => {
  const { input, state } = await fixture();
  await ocrDocument(input);
  const retry = { ...input, state: state() };
  await ocrDocument(retry);
  const rich = (ledger: PipelineUsageEventLedger) => ledger.snapshot().filter(event => event.metric === "ingest-page-rich");
  expect(rich(retry.state.usageLedger).map(event => event.id)).toEqual(rich(input.state.usageLedger).map(event => event.id));
  expect(rich(retry.state.usageLedger)).toHaveLength(1);
  expect(retry.state.usageLedger.snapshot().filter(event => event.metric === "ocr-compute")).toHaveLength(0);
});

it("a refused tenant scope starts no provider and reads no checkpoint", async () => {
  const { input, storage, fake } = await fixture();
  input.state.run.orgId = "../other-tenant";
  await expect(ocrDocument(input)).rejects.toThrow("tenant scope");
  expect(storage.getBytes).not.toHaveBeenCalled();
  expect(fake.jobs).toHaveLength(0);
});

it("checkpoint write failure is retryable infrastructure and publishes no result", async () => {
  const { input, storage, fake } = await fixture();
  storage.putBytes.mockRejectedValueOnce(new Error("injected checkpoint storage outage"));
  await expect(ocrDocument(input)).rejects.toMatchObject({ name: "OcrInfrastructureError" });
  expect(fake.jobs).toHaveLength(1);
});

it("malformed checkpoint page numbers refuse reuse before a provider call", async () => {
  const { input, objects, fake } = await fixture();
  const { sha256Bytes } = await import("../../sandbox/source-integrity.js");
  await ocrDocument(input);
  for (const [key, bytes] of objects) {
    const envelope = JSON.parse(bytes.toString());
    const value = JSON.parse(envelope.payload);
    value.pages[0].pageNumber = -1;
    envelope.payload = JSON.stringify(value);
    envelope.digest = sha256Bytes(Buffer.from(envelope.payload));
    objects.set(key, Buffer.from(JSON.stringify(envelope)));
  }
  await expect(ocrDocument(input)).rejects.toThrow("Invalid OCR checkpoint page");
  expect(fake.jobs).toHaveLength(1);
});

it("binds auto language to its effective environment setting", async () => {
  const { input, fake } = await fixture();
  const first = { ...input, languageSetting: "auto", env: { ...input.env, DOCSLURP_OCR_LANGUAGE: "eng" } };
  await ocrDocument(first);
  await ocrDocument({ ...first, env: { ...first.env, DOCSLURP_OCR_LANGUAGE: "kor" } });
  expect(fake.jobs).toHaveLength(2);
});
