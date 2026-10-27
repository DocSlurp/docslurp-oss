import assert from "node:assert/strict";
import { test, mock } from "node:test";
import fs from "node:fs";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { credentialAccount, loadCredential, saveCredential } from "../dist/auth/credentials.js";

test("auto storage reads the rotated fallback when stale keychain reads succeed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "credential-fallback-"));
  const previous = { ...process.env };
  const originalExists = fs.existsSync;
  const credential = { version: 1, apiUrl: "https://example.test", profile: "default", clientId: "docslurp-cli", accessToken: "old-access", accessTokenExpiresAt: "2030-01-01T00:00:00Z", refreshToken: "old-refresh", scopes: ["search"], updatedAt: "2030-01-01T00:00:00Z" };
  let stored = null;
  let writable = true;
  mock.method(fs, "existsSync", (path) => String(path) === "/usr/bin/secret-tool" || originalExists(path));
  mock.method(childProcess, "spawn", (_tool, args) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => {};
    child.stdin = new Writable({ write(_chunk, _encoding, done) { done(); } });
    let input = "";
    child.stdin._write = (chunk, _encoding, done) => { input += chunk; done(); };
    child.stdin.on("finish", () => {
      if (args[0] === "store" && writable) stored = input;
      if (args[0] === "lookup" && stored) child.stdout.write(stored);
      queueMicrotask(() => child.emit("close", args[0] === "store" && !writable ? 1 : 0));
    });
    return child;
  });
  syncBuiltinESMExports();
  try {
    process.env.XDG_CONFIG_HOME = directory;
    process.env.DOCSLURP_CREDENTIAL_STORE = "auto";
    process.env.DBUS_SESSION_BUS_ADDRESS = "test";
    const account = credentialAccount("default", credential.apiUrl);
    await saveCredential(account, credential);
    assert.equal((await loadCredential(account)).credential.refreshToken, "old-refresh");
    writable = false;
    const rotated = { ...credential, accessToken: "new-access", refreshToken: "new-refresh" };
    assert.match(await saveCredential(account, rotated), /^file /);
    assert.equal((await loadCredential(account)).credential.refreshToken, "new-refresh");
    writable = true;
    await saveCredential(account, { ...rotated, refreshToken: "third-refresh" });
    assert.equal((await loadCredential(account)).credential.refreshToken, "third-refresh");
  } finally {
    mock.restoreAll(); syncBuiltinESMExports();
    process.env = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
