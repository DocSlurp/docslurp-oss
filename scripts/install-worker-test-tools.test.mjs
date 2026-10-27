import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const script = resolve("scripts/install-worker-test-tools.sh");
function run(scenario) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? process.env.RUNNER_TEMP, "ci-mirror-test."));
  try {
    const bin = join(dir, "bin"); mkdirSync(bin);
    const stub = (name, code) => writeFileSync(join(bin, name), "#!/bin/bash\nset -eu\n" + code, { mode: 0o755 });
    stub("sudo", 'exec "$@"\n');
    stub("timeout", `printf '%s\\n' "$*" >> "$TEST_DIR/timeouts"
count=0; [[ ! -f "$TEST_DIR/count" ]] || count=$(cat "$TEST_DIR/count")
count=$((count+1)); echo "$count" > "$TEST_DIR/count"
if [[ "$SCENARIO" == timeout && "$count" == 1 ]]; then exit 124; fi
shift 3
exec "$@"
`);
    stub("apt-get", `printf '%s\\n' "$*" >> "$TEST_DIR/apt"
if [[ "$*" == *"Dir::Etc::sourcelist="* ]]; then
  for arg in "$@"; do
    if [[ "$arg" == Dir::Etc::sourcelist=* ]]; then cp "\${arg#*=}" "$TEST_DIR/sources"; fi
  done
  [[ "$SCENARIO" != bothfail ]] || exit 100
elif [[ "$SCENARIO" == installfail && "$*" == *" install "* ]]; then
  exit 100
elif [[ "$SCENARIO" != success && "$SCENARIO" != installfail ]]; then
  exit 100
fi
`);
    // Mock only host identity so the same test exercises fallback on non-Ubuntu developer hosts.
    const command = 'source "$1"; assert_supported_runner() { :; }; main';
    const result = spawnSync("bash", ["-c", command, "--", script], {
      env: { ...process.env, PATH: bin + ":" + process.env.PATH, RUNNER_TEMP: dir, TMPDIR: dir, TEST_DIR: dir, SCENARIO: scenario }, encoding: "utf8",
    });
    const read = (name) => { try { return readFileSync(join(dir, name), "utf8"); } catch { return ""; } };
    return { status: result.status, apt: read("apt"), attempts: Number(read("count")), timeouts: read("timeouts"), sources: read("sources"), leftovers: readdirSync(dir).filter(n => n.startsWith("worker-test-apt.")) };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
test("successful primary installation needs no fallback", () => {
  const r = run("success"); assert.equal(r.status, 0);
  assert.equal(r.sources, ""); assert.equal(r.attempts, 1);
  assert.match(r.apt, /update --error-on=any/);
  assert.match(r.apt, /install -y --no-install-recommends bubblewrap poppler-data poppler-utils pandoc tesseract-ocr tesseract-ocr-eng ffmpeg/);
});
for (const scenario of ["primaryfail", "installfail", "timeout"]) test(`${scenario} retries bounded official signed sources successfully`, () => {
  const r = run(scenario); assert.equal(r.status, 0);
  assert.equal(r.attempts, 2);
  assert.equal((r.timeouts.match(/--signal=TERM --kill-after=15s 5m/g) ?? []).length, 2);
  assert.match(r.sources, /URIs: https:\/\/archive.ubuntu.com\/ubuntu\//);
  assert.match(r.sources, /URIs: https:\/\/security.ubuntu.com\/ubuntu\//);
  assert.equal((r.sources.match(/Signed-By: \/usr\/share\/keyrings\/ubuntu-archive-keyring.gpg/g) ?? []).length, 2);
  assert.match(r.apt, /Dir::Etc::sourceparts=-/); assert.match(r.apt, /Dir::State::lists=/);
  assert.doesNotMatch(r.apt + r.sources, /allow-unauthenticated|trusted=yes|AllowInsecure/);
  assert.deepEqual(r.leftovers, []);
});
test("both mirrors failing fails CI and cleans temporary sources", () => {
  const r = run("bothfail"); assert.notEqual(r.status, 0);
  assert.equal(r.attempts, 2);
  assert.doesNotMatch(r.apt, /install /); assert.deepEqual(r.leftovers, []);
});
