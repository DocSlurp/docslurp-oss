import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { mkdtemp, writeFile, access, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";

// Execute the real source without building unrelated worker/native dependencies.
const shared = new URL("../packages/shared/src/", import.meta.url);
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "@docslurp/shared") {
      const source = `export * from "${new URL("runtime-environment.ts", shared)}"; export * from "${new URL("parse-source-decision.ts", shared)}";`;
      return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
    }
    if (specifier.endsWith(".js") && context.parentURL?.endsWith(".ts")) {
      return next(specifier.slice(0, -3) + ".ts", context);
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.endsWith(".ts")) return { format: "module", source: stripTypeScriptTypes(readFileSync(new URL(url), "utf8"), { mode: "transform" }), shortCircuit: true };
    return next(url, context);
  },
});
function setEnv(t, key, value) {
  const old = process.env[key];
  t.after(() => { if (old === undefined) delete process.env[key]; else process.env[key] = old; });
  process.env[key] = value;
}
const source = await import("../worker/src/lib/parse-source.ts");
const integrity = await import("../worker/src/sandbox/source-integrity.ts");
const registry = await import("../worker/src/sandbox/registry.ts");

for (const env of [
  { NODE_ENV: "production" }, { NODE_ENV: "staging" }, { NODE_ENV: "preview" },
  { NODE_ENV: "prodution" }, { NODE_ENV: "\u00a0development" },
  { NODE_ENV: "test", DOCSLURP_SERVICE_PROFILE: "worker-service" },
]) {
  test(`missing scan decision is refused: ${JSON.stringify(env)}`, async (t) => {
    setEnv(t, "NODE_ENV", env.NODE_ENV);
    setEnv(t, "DOCSLURP_SERVICE_PROFILE", env.DOCSLURP_SERVICE_PROFILE ?? "");
    const document = { id: "unscanned-hostile-upload", sourceKey: "tenant/run/upload" };
    assert.equal(source.effectiveParseSourceDecision(document), "unscanned");
    assert.throws(() => source.pdfBytesForParsing(document), integrity.UnscannedParseSourceError);
    assert.throws(() => source.originalSourceForQuarantine(document), /no upload binding/);
    assert.throws(() => integrity.verifyStagedSource(document, "a".repeat(64)), integrity.UnscannedParseSourceError);
    let reads = 0;
    await assert.rejects(integrity.readSourceBytes({ getBytes: async () => { reads++; return Buffer.from("malicious"); } }, document), integrity.UnscannedParseSourceError);
    await assert.rejects(integrity.stageSourceFile({ downloadToTempFile: async () => { reads++; throw new Error("must not download"); } }, document, "unused"), integrity.UnscannedParseSourceError);
    assert.equal(reads, 0);
    assert.equal(source.effectiveParseSourceDecision(document, { NODE_ENV: "development" }), "unscanned");
    assert.doesNotThrow(() => integrity.verifyStagedSource({ ...document, parseSourceDecision: "original", sourceSha256: "a".repeat(64) }, "a".repeat(64)));
  });
}
test("development fixtures retain their explicit environment exemption", (t) => {
  setEnv(t, "NODE_ENV", "development");
  setEnv(t, "DOCSLURP_SERVICE_PROFILE", "");
  assert.equal(source.effectiveParseSourceDecision({}), undefined);
});
test("sandbox ids normalize ASCII whitespace only", () => {
  assert.equal(registry.resolveSandboxProviderId({ DOCSLURP_PARSER_SANDBOX: " \tMODAL\r" }, "linux"), "modal");
  assert.throws(() => registry.resolveSandboxProviderId({ DOCSLURP_PARSER_SANDBOX: "\u00a0modal" }, "linux"), /Unknown/);
});

const policy = await import("../worker/src/sandbox/policy.ts");
for (const env of [
  { NODE_ENV: "production" }, { NODE_ENV: "staging" }, { NODE_ENV: "preview" },
  { NODE_ENV: "prodution" }, { NODE_ENV: "\u00a0development" }, { NODE_ENV: "\ufeffdevelopment" },
  { NODE_ENV: "test", DOCSLURP_SERVICE_PROFILE: "worker-service" },
]) {
  test(`VM and affirmative decision policy: ${JSON.stringify(env)}`, async (t) => {
    setEnv(t, "NODE_ENV", env.NODE_ENV);
    setEnv(t, "DOCSLURP_SERVICE_PROFILE", env.DOCSLURP_SERVICE_PROFILE ?? "");
    assert.equal(registry.resolveSandboxProviderId({}, "linux"), "modal");
    const isolation = { processes: true, filesystem: true, network: "full", location: "local" };
    for (const providerId of ["bubblewrap", "landlock", "none"]) {
      assert.throws(() => policy.assertSandboxPolicy({ providerId, isolation, env }), /VM boundary|allowed only in development/);
      assert.throws(() => policy.assertSandboxPolicy({ providerId, isolation, env: { NODE_ENV: "development" } }), /VM boundary|allowed only in development/);
    }
    assert.doesNotThrow(() => policy.assertSandboxPolicy({ providerId: "modal", isolation: { ...isolation, location: "remote" }, env }));
    for (const decision of [undefined, null, "bogus", "unscanned-allowed", "original", "scanned-copy"]) {
      for (const hash of [undefined, null, "", "garbage"]) {
        const doc = { id: "invalid", sourceKey: "tenant/upload", parseSourceDecision: decision, sourceSha256: hash };
        let reads = 0;
        assert.throws(() => source.pdfBytesForParsing(doc), integrity.UnscannedParseSourceError);
        await assert.rejects(integrity.readSourceBytes({ getBytes: async () => { reads++; return Buffer.from("hostile"); } }, doc), integrity.UnscannedParseSourceError);
        await assert.rejects(integrity.stageSourceFile({ downloadToTempFile: async () => { reads++; throw Error("download"); } }, doc, "unused"), integrity.UnscannedParseSourceError);
        assert.equal(reads, 0);
        assert.throws(() => source.originalSourceForQuarantine(doc), /no upload binding/);
      }
    }
  });
}
for (const nodeEnv of ["development", "test", ""]) {
  test(`development fixture lifecycle: ${nodeEnv || "unset"}`, async (t) => {
    setEnv(t, "NODE_ENV", nodeEnv);
    setEnv(t, "DOCSLURP_SERVICE_PROFILE", "");
    const bytes = Buffer.from("fixture");
    const doc = { id: "fixture", sourceKey: "fixture", sourceSha256: integrity.sha256Bytes(bytes) };
    integrity.verifyQuarantineUpload(source.originalSourceForQuarantine(doc), doc.sourceSha256);
    assert.equal(source.pdfBytesForParsing(doc).key, "fixture");
    assert.deepEqual(await integrity.readSourceBytes({ getBytes: async () => bytes }, doc), bytes);
    await assert.rejects(integrity.readSourceBytes({ getBytes: async () => Buffer.from("changed") }, doc), integrity.SourceIntegrityError);
    assert.equal(source.effectiveParseSourceDecision({}, { NODE_ENV: "staging" }), "unscanned");
  });
}
for (const env of [{ NODE_ENV: "production" }, { NODE_ENV: "staging" }, { NODE_ENV: "production", DOCSLURP_SERVICE_PROFILE: "worker-service" }]) {
  test(`loader-owned quarantine lifecycle: ${JSON.stringify(env)}`, async (t) => {
    setEnv(t, "NODE_ENV", env.NODE_ENV);
    setEnv(t, "DOCSLURP_SERVICE_PROFILE", env.DOCSLURP_SERVICE_PROFILE ?? "");
    const bytes = Buffer.from("original");
    const copy = Buffer.from("normalized");
    const hash = integrity.sha256Bytes(bytes);
    const doc = { id: "owned", ...source.resolveDocumentSource({ id: "owned", source_key: "upload", source_sha256: hash }) };
    source.bindDocumentUpload(doc, { source_key: "upload", source_sha256: hash });
    const upload = source.originalSourceForQuarantine(doc);
    integrity.verifyQuarantineUpload(upload, hash);
    assert.throws(() => integrity.verifyQuarantineUpload({ ...upload }, hash), /not issued/);
    assert.throws(() => source.originalSourceForQuarantine({ ...doc }), /no upload binding/);
    source.applyParseSource(doc, { copy: null, scannedSha256: hash });
    assert.deepEqual(await integrity.readSourceBytes({ getBytes: async () => bytes }, doc), bytes);
    source.applyParseSource(doc, { copy: { key: "scanned", sha256: integrity.sha256Bytes(copy) }, scannedSha256: hash });
    assert.deepEqual(await integrity.readSourceBytes({ getBytes: async () => copy }, doc), copy);
    await assert.rejects(integrity.readSourceBytes({ getBytes: async () => bytes }, doc), integrity.ParseSourceError);
    assert.throws(() => source.originalSourceForQuarantine({ ...doc }), /no upload binding/);
    const directory = await mkdtemp(path.join(tmpdir(), "docslurp-integrity-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const filename = path.join(directory, "source");
    await writeFile(filename, bytes);
    await assert.rejects(integrity.stageSourceFile({ downloadToTempFile: async () => filename }, doc, "unused"), integrity.ParseSourceError);
    await assert.rejects(access(directory), { code: "ENOENT" });
  });
}
