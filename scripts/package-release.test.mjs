import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { checkRelease, nextVersion, releasePackages, verifyPackageIntegrity } from "./package-release.mjs";

test("publish verification rejects different or missing registry contents", () => {
  const tarball = Buffer.from("abc");
  const integrity = "sha512-3a81oZNherrMQXNJriBBMRLm+k6JqX6iCp7u5ktV05ohkpkqJ0/BqDa6PCOj/uu9RU1EI2Q86A4qmslPpUyknw==";
  assert.equal(verifyPackageIntegrity(tarball, { dist: { integrity } }), integrity);
  assert.throws(() => verifyPackageIntegrity(Buffer.from("different bytes"), { dist: { integrity } }), /integrity/);
  assert.throws(() => verifyPackageIntegrity(tarball, {}), /integrity/);
});

test("release bumps increase stable versions", () => {
  assert.equal(nextVersion("0.1.1", "patch"), "0.1.2");
  assert.equal(nextVersion("0.1.1", "minor"), "0.2.0");
  assert.equal(nextVersion("0.1.1", "major"), "1.0.0");
  assert.equal(nextVersion("0.1.1", "0.3.0"), "0.3.0");
  for (const bump of ["0.1.1", "0.0.9", "0.1.2-beta.1", "01.2.3", "oops"]) {
    assert.throws(() => nextVersion("0.1.1", bump));
  }
});

test("release rejects mismatched tag, version drift and private packages", () => {
  const directory = mkdtempSync(join(tmpdir(), "docslurp-release-"));
  const root = pathToFileURL(`${directory}/`);
  const write = (index, overrides = {}) => {
    const path = join(directory, releasePackages[index]);
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "package.json"), JSON.stringify({ name: `package-${index}`, version: "0.1.1", publishConfig: { access: "public" }, ...overrides }));
  };
  try {
    releasePackages.forEach((_, index) => write(index));
    assert.equal(checkRelease(root, "v0.1.1").version, "0.1.1");
    assert.throws(() => checkRelease(root, "v0.1.2"), /Expected tag/);
    write(1, { version: "0.1.2" });
    assert.throws(() => checkRelease(root), /must match/);
    write(1, { private: true });
    assert.throws(() => checkRelease(root), /public publishing/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
