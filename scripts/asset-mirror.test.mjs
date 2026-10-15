import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";

import { ensureFixtures } from "./fetch-fixtures.mjs";
import { assetMirrorConfig, contentKey, downloadFromMirror, headMirror } from "./lib/pinned-assets.mjs";

const bytes = Buffer.from("private-bytes");
const sha = createHash("sha256").update(bytes).digest("hex");
const pin = { sha256: sha, size: bytes.length };
const env = { DOCSLURP_ASSET_MIRROR: "s3://bucket/pre", DOCSLURP_ASSET_S3_ENDPOINT: "https://s3.example.org", DOCSLURP_ASSET_S3_REGION: "r", DOCSLURP_ASSET_S3_ACCESS_KEY_ID: "id", DOCSLURP_ASSET_S3_SECRET_ACCESS_KEY: "secret" };
const tmp = () => mkdtempSync(path.join(tmpdir(), "mirror-"));

function fakeS3(objects, calls = []) {
  return () => ({
    destroy() {},
    async send(cmd) {
      calls.push(cmd.input);
      const body = objects[`${cmd.input.Bucket}/${cmd.input.Key}`];
      if (!body) throw Object.assign(new Error("nope"), { name: "NoSuchKey", $metadata: { httpStatusCode: 404 } });
      return { ContentLength: body.length, Body: Readable.from([body]) };
    },
  });
}

const fixtureManifest = { dir: "fx", privateMirror: { envBaseUrl: "TEST_FIXTURE_BASE" }, files: {
  "a.pdf": { ...pin, source: "private-mirror", mirrorKey: contentKey("fixtures", sha, "a.pdf") },
  "up.pdf": { ...pin, source: "upstream", url: "https://example.org/up.pdf", mirrorKey: "fixtures/x/up.pdf" },
} };

test("assetMirrorConfig is off when unset, validates when set, and never needs a placeholder", () => {
  assert.equal(assetMirrorConfig({}), undefined);
  assert.deepEqual({ ...assetMirrorConfig(env), accessKeyId: undefined, secretAccessKey: undefined }, { bucket: "bucket", prefix: "pre", endpoint: "https://s3.example.org", region: "r", accessKeyId: undefined, secretAccessKey: undefined });
  assert.throws(() => assetMirrorConfig({ DOCSLURP_ASSET_MIRROR: "s3://b" }), /ENDPOINT/);
  assert.throws(() => assetMirrorConfig({ ...env, DOCSLURP_ASSET_MIRROR: "https://b" }), /s3:\/\//);
});

test("downloadFromMirror verifies size + sha256 and leaves no partial file on mismatch", async () => {
  const root = tmp();
  const mirror = assetMirrorConfig(env);
  const calls = [];
  await downloadFromMirror(mirror, "k/a", path.join(root, "a"), pin, { s3Factory: fakeS3({ "bucket/pre/k/a": bytes }, calls) });
  assert.equal(readFileSync(path.join(root, "a")).toString(), "private-bytes");
  assert.deepEqual(calls[0], { Bucket: "bucket", Key: "pre/k/a" });
  await assert.rejects(downloadFromMirror(mirror, "k/a", path.join(root, "b"), pin, { s3Factory: fakeS3({ "bucket/pre/k/a": Buffer.from("tampered-byte") }) }), /does not match/);
  assert.ok(!existsSync(path.join(root, "b")) && !existsSync(path.join(root, "b.part")));
  await assert.rejects(downloadFromMirror(mirror, "missing", path.join(root, "c"), pin, { s3Factory: fakeS3({}) }), /object not found/);
  assert.equal((await headMirror(mirror, "k/a", pin, { s3Factory: fakeS3({ "bucket/pre/k/a": bytes }) })).ok, true);
});

test("fixtures: private-mirror files are skipped with a clear message without the mirror, fetched with it, upstream first", async () => {
  const root = tmp();
  const none = await ensureFixtures({ manifest: fixtureManifest, root, only: ["a.pdf"], env: {} });
  assert.equal(none.failed.length, 0);
  assert.match(none.skipped[0], /private asset, not available/);
  const s3Factory = fakeS3({ ["bucket/pre/" + fixtureManifest.files["a.pdf"].mirrorKey]: bytes, "bucket/pre/fixtures/x/up.pdf": bytes });
  const got = await ensureFixtures({ manifest: fixtureManifest, root, env, s3Factory, fetchImpl: async () => ({ ok: false, status: 503 }) });
  assert.deepEqual(got.failed, []);
  assert.equal(got.fetched.length, 2); // a.pdf from the mirror, up.pdf via the mirror fallback after upstream 503
  assert.ok(existsSync(path.join(root, "fx", "a.pdf")) && existsSync(path.join(root, "fx", "up.pdf")));
});

