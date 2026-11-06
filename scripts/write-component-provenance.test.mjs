import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { dopplerComponent, engineComponent, writeProvenance } from "./write-component-provenance.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pin = JSON.parse(readFileSync(path.join(root, "worker/doppler.json"), "utf8"));

test("the image labels name the commit, repository and license pinned in worker/doppler.json", () => {
  assert.match(pin.commit, /^[0-9a-f]{40}$/);
  assert.equal(pin.repository, "https://github.com/DocSlurp/doppler");
  for (const name of ["Dockerfile.lean", "Dockerfile.full"]) {
    const dockerfile = readFileSync(path.join(root, "worker", name), "utf8");
    assert.ok(dockerfile.includes(`io.docslurp.doppler.commit="${pin.commit}"`), name);
    assert.ok(dockerfile.includes(`io.docslurp.doppler.source="${pin.repository}"`), name);
    assert.ok(dockerfile.includes(`io.docslurp.doppler.license="${pin.license}"`), name);
    assert.ok(dockerfile.includes(`io.docslurp.doppler.corresponding-source="${pin.repository}/tree/${pin.commit}"`), name);
    assert.ok(dockerfile.includes("write-component-provenance.mjs"), name);
  }
});

test("writes license texts, PROVENANCE.json and an SPDX document for Doppler and an engine", () => {
  const dir = mkdtempSync(path.join(process.env.TMPDIR || tmpdir(), "provenance-"));
  try {
    const prefix = path.join(dir, "usr/local");
    mkdirSync(path.join(prefix, "bin"), { recursive: true });
    mkdirSync(path.join(prefix, "lib"), { recursive: true });
    mkdirSync(path.join(prefix, "share/doc/doppler"), { recursive: true });
    writeFileSync(path.join(prefix, "bin/pdftotext"), "elf");
    writeFileSync(path.join(prefix, "lib/libpoppler.so.165"), "elf");
    writeFileSync(path.join(prefix, "share/doc/doppler/COPYING"), "GNU GENERAL PUBLIC LICENSE Version 2");
    writeFileSync(path.join(prefix, "share/doc/doppler/COPYING3"), "GNU GENERAL PUBLIC LICENSE Version 3");
    const engine = path.join(dir, "engine");
    mkdirSync(engine);
    writeFileSync(path.join(engine, "LICENSE"), "MIT License");
    writeFileSync(path.join(engine, "binding.node"), "elf");
    const manifest = { package: "@example/engine", version: "1.0.0", repository: "https://github.com/Example/engine", commit: "a".repeat(40), license: "MIT", tarball: "e.tgz", sha256: "b".repeat(64) };
    const components = [dopplerComponent(pin, prefix), engineComponent(manifest, engine)];
    const licenses = path.join(dir, "licenses");
    const sbomPath = path.join(dir, "sbom.spdx.json");
    writeProvenance({ components, licensesDir: licenses, sbomPath, created: "2026-11-05T00:00:00Z" });
    assert.match(readFileSync(path.join(licenses, "doppler/COPYING"), "utf8"), /GENERAL PUBLIC LICENSE/);
    const doppler = JSON.parse(readFileSync(path.join(licenses, "doppler/PROVENANCE.json"), "utf8"));
    assert.equal(doppler.commit, pin.commit);
    assert.match(doppler.source.note, new RegExp(`${pin.repository}/tree/${pin.commit}`));
    assert.equal(doppler.files.length, 2);
    assert.equal(readFileSync(path.join(licenses, "example-engine/LICENSE"), "utf8"), "MIT License");
    const sbom = JSON.parse(readFileSync(sbomPath, "utf8"));
    assert.equal(sbom.spdxVersion, "SPDX-2.3");
    assert.deepEqual(sbom.packages.map((entry) => [entry.licenseDeclared, entry.downloadLocation]), [
      [pin.license, `git+${pin.repository}.git@${pin.commit}`],
      ["MIT", `git+https://github.com/Example/engine.git@${"a".repeat(40)}`],
    ]);
    assert.equal(sbom.files.length, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("refuses an engine whose manifest lacks a public repository or commit", () => {
  const base = { package: "@example/engine", version: "1.0.0", repository: "https://github.com/Example/engine", commit: "a".repeat(40), license: "MIT" };
  assert.throws(() => engineComponent({ ...base, commit: undefined }, "/nonexistent"), /lacks commit/);
  assert.throws(() => engineComponent({ ...base, commit: "8709e8c" }, "/nonexistent"), /40-hex commit/);
  assert.throws(() => engineComponent({ ...base, repository: "file:///srv/private" }, "/nonexistent"), /public repository/);
});
