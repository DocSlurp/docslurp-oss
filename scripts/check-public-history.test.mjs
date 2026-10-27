import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const source = readFileSync(new URL("./check-public-history.sh", import.meta.url), "utf8");
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "history-guard-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-b", "main");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "user.name", "Fixture");
  git("commit", "--allow-empty", "-m", "root");
  const root = git("rev-parse", "HEAD");
  // Substitute only the fixture root; production has no configurable bypass.
  const script = join(dir, "guard.sh");
  writeFileSync(script, source.replace("146c5d4531a495ccaf90aab1f503b53016cd65fe", root));
  const run = (...refs) => spawnSync("bash", [script, ...refs], { cwd: dir, encoding: "utf8" });
  const add = (name) => {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), "fixture");
    git("add", name);
    git("commit", "-m", "add fixture");
  };
  return { dir, git, root, run, add };
}
test("valid history passes; invalid refs and shallow inspection fail closed", (t) => {
  const f = fixture(t);
  assert.equal(f.run("HEAD").status, 0);
  assert.equal(f.run("missing").status, 2);
  assert.equal(f.run("HEAD", "missing").status, 2);
  writeFileSync(join(f.dir, ".git/shallow"), f.root + "\n");
  assert.equal(f.run("HEAD").status, 2);
});
test("foreign root is refused", (t) => {
  const f = fixture(t);
  f.git("checkout", "--orphan", "foreign");
  f.git("commit", "--allow-empty", "-m", "foreign root");
  assert.equal(f.run("HEAD").status, 1);
});
test("private paths remain forbidden when deleted or already in base", (t) => {
  const f = fixture(t);
  f.add("app/private.txt");
  assert.equal(f.run("HEAD", "HEAD").status, 1);
  f.git("rm", "app/private.txt");
  f.git("commit", "-m", "delete");
  assert.equal(f.run("HEAD").status, 1);
});
test("nested env and unusual private filenames are detected", (t) => {
  const f = fixture(t);
  f.add("server/.env");
  assert.equal(f.run("HEAD").status, 1);
});
test("private file introduced only in merge resolution is detected", (t) => {
  const f = fixture(t);
  f.git("checkout", "-b", "side");
  f.add("side.txt");
  f.git("checkout", "main");
  f.add("main.txt");
  f.git("merge", "--no-commit", "--no-ff", "side");
  f.add("app/private\nname.txt");
  assert.equal(f.git("rev-list", "--parents", "-n", "1", "HEAD").split(" ").length, 3);
  assert.equal(f.run("HEAD").status, 1);
});

test("private second-parent history cannot be hidden by a clean merge tree", (t) => {
  const f = fixture(t);
  f.git("checkout", "-b", "side");
  f.add("app/private.txt");
  f.git("checkout", "main");
  f.add("main.txt");
  f.git("merge", "--no-commit", "--no-ff", "side");
  f.git("rm", "-f", "app/private.txt");
  f.git("commit", "-m", "merge with clean tree");
  assert.equal(f.run("HEAD").status, 1);
});
