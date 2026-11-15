import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { readFileSync } from "node:fs";

// Execute the real source without building unrelated worker/native dependencies.
const shared = new URL("../packages/shared/src/", import.meta.url);
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "@docslurp/shared") {
      function setEnv(t, key, value) {
  const old = process.env[key];
  t.after(() => { if (old === undefined) delete process.env[key]; else process.env[key] = old; });
  process.env[key] = value;
}
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
