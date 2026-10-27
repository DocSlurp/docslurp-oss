import assert from "node:assert/strict";
import { test, mock } from "node:test";
import fs from "node:fs";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logoutCommand, loginCommand } from "../dist/auth/commands.js";
import { resolveAuth } from "../dist/auth/resolve.js";
import { credentialAccount, credentialsFile, deleteCredential, loadCredential, saveCredential } from "../dist/auth/credentials.js";

test("fallback stays authoritative and logout blocks a surviving stale keychain grant", async () => {
  const directory = await mkdtemp(join(tmpdir(), "credential-fallback-"));
  const previous = { ...process.env };
  const originalExists = fs.existsSync;
  const credential = { version: 1, apiUrl: "https://example.test", profile: "default", clientId: "docslurp-cli", accessToken: "old-access", accessTokenExpiresAt: "2030-01-01T00:00:00Z", refreshToken: "old-refresh", scopes: ["search"], updatedAt: "2030-01-01T00:00:00Z" };
  let stored = null;
  let writable = true;
  let readable = true;
  let providerCalls = [];
  let revokeFails = false;
  const revoked = [];
  mock.method(globalThis, "fetch", async (url, options) => {
    providerCalls.push(String(url));
    const origin = credential.apiUrl;
    if (String(url).endsWith("/.well-known/oauth-authorization-server")) return Response.json({ issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, revocation_endpoint: `${origin}/revoke`, device_authorization_endpoint: `${origin}/device` });
    if (String(url).endsWith("/device")) return Response.json({ device_code: "device", user_code: "CODE", verification_uri: `${origin}/verify`, expires_in: 60, interval: 1 });
    if (String(url).endsWith("/revoke")) {
      revoked.push(new URLSearchParams(options.body).get("token"));
      return Response.json({}, { status: revokeFails ? 503 : 200 });
    }
    if (String(url).endsWith("/token")) return Response.json({ access_token: "explicit-access", refresh_token: "explicit-refresh", token_type: "Bearer", expires_in: 900, scope: "search" });
    return Response.json({});
  });
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
      if (args[0] === "lookup" && stored && readable) child.stdout.write(stored);
      queueMicrotask(() => child.emit("close", args[0] === "clear" || (args[0] === "store" && !writable) ? 1 : 0));
    });
    return child;
  });
  syncBuiltinESMExports();
  try {
    process.env.XDG_CONFIG_HOME = directory;
    process.env.DOCSLURP_CREDENTIAL_STORE = "auto";
    process.env.DBUS_SESSION_BUS_ADDRESS = "test";
    delete process.env.DOCSLURP_API_KEY;
    delete process.env.DOCSLURP_TOKEN;
    const account = credentialAccount("default", credential.apiUrl);
    await saveCredential(account, credential);
    assert.equal((await loadCredential(account)).credential.refreshToken, "old-refresh");
    const capturedA = await resolveAuth({}, credential.apiUrl);
    writable = false;
    const rotated = { ...credential, accessToken: "new-access", refreshToken: "new-refresh" };
    assert.match(await saveCredential(account, rotated), /^file /);
    assert.equal((await loadCredential(account)).credential.refreshToken, "new-refresh");
    writable = true;
    await saveCredential(account, { ...rotated, refreshToken: "third-refresh" });
    assert.equal((await loadCredential(account)).credential.refreshToken, "third-refresh");
    // The keychain still holds grant A; the fallback is a distinct login B.
    // A failed removal must never let recovery of A undo logout of B.
    providerCalls = [];
    await assert.rejects(capturedA.token({ forceRefresh: true }), /changed or was signed out/);
    assert.deepEqual(providerCalls, [], "captured A cannot refresh a different active login B");
    await logoutCommand({}, credential.apiUrl);
    assert.deepEqual(revoked, ["third-refresh"]);
    providerCalls = [];
    await assert.rejects(capturedA.token({ forceRefresh: true }), /changed or was signed out/);
    assert.deepEqual(providerCalls, [], "captured A cannot refresh after logout of fallback B");
    assert.equal(JSON.parse(await readFile(credentialsFile(), "utf8")).credentials[account], null);
    assert.equal(await loadCredential(account), null);
    process.env.DOCSLURP_CREDENTIAL_STORE = "keychain";
    assert.equal(await loadCredential(account), null);
    process.env.DOCSLURP_CREDENTIAL_STORE = "auto";
    await saveCredential(account, { ...rotated, refreshToken: "deliberate-new-login" });
    assert.equal((await loadCredential(account)).credential.refreshToken, "deliberate-new-login");
    const capturedSame = await resolveAuth({}, credential.apiUrl);
    revokeFails = true;
    await logoutCommand({ force: true }, credential.apiUrl);
    revokeFails = false;
    providerCalls = [];
    await assert.rejects(capturedSame.token({ forceRefresh: true }), /changed or was signed out/);
    assert.deepEqual(providerCalls, []);
    assert.equal(await loadCredential(account), null);
    await loginCommand({ device: true }, credential.apiUrl);
    assert.equal((await loadCredential(account)).credential.refreshToken, "explicit-refresh");
    // No available keychain at logout is the same hazard as failed removal.
    delete process.env.DBUS_SESSION_BUS_ADDRESS;
    delete process.env.XDG_RUNTIME_DIR;
    await deleteCredential(account);
    process.env.DBUS_SESSION_BUS_ADDRESS = "test";
    assert.equal(await loadCredential(account), null);
    // An explicit successful keychain login deliberately clears the marker.
    process.env.DOCSLURP_CREDENTIAL_STORE = "keychain";
    await saveCredential(account, { ...rotated, refreshToken: "keychain-new-login" });
    assert.equal((await loadCredential(account)).credential.refreshToken, "keychain-new-login");
    const keychainOnly = await resolveAuth({}, credential.apiUrl);
    readable = false;
    process.env.DOCSLURP_CREDENTIAL_STORE = "auto";
    providerCalls = [];
    await logoutCommand({ force: true }, credential.apiUrl);
    assert.deepEqual(providerCalls, [], "inaccessible credential cannot be revoked remotely");
    readable = true;
    assert.equal(await loadCredential(account), null, "keychain recovery cannot undo command logout");
    assert.equal(JSON.parse(await readFile(credentialsFile(), "utf8")).credentials[account], null);
    await assert.rejects(keychainOnly.token({ forceRefresh: true }), /changed or was signed out/);
    assert.deepEqual(providerCalls, []);
    await loginCommand({ device: true }, credential.apiUrl);
    assert.equal((await loadCredential(account)).credential.refreshToken, "explicit-refresh");
  } finally {
    mock.restoreAll(); syncBuiltinESMExports();
    process.env = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test("logout waits for an admitted refresh and revokes its rotated token", async () => {
  const directory = await mkdtemp(join(tmpdir(), "credential-logout-race-"));
  const previous = { ...process.env };
  const apiUrl = "https://race.example.test";
  const credential = { version: 1, apiUrl, profile: "default", clientId: "docslurp-cli", accessToken: "old-access", accessTokenExpiresAt: "2030-01-01T00:00:00Z", refreshToken: "old-refresh", scopes: ["search"], updatedAt: "2030-01-01T00:00:00Z" };
  let enterRefresh, releaseRefresh;
  const entered = new Promise((resolve) => { enterRefresh = resolve; });
  const released = new Promise((resolve) => { releaseRefresh = resolve; });
  const revoked = [];
  mock.method(globalThis, "fetch", async (url, options) => {
    if (String(url).endsWith("/.well-known/oauth-authorization-server")) return Response.json({ issuer: apiUrl, authorization_endpoint: `${apiUrl}/authorize`, token_endpoint: `${apiUrl}/token`, revocation_endpoint: `${apiUrl}/revoke` });
    if (String(url).endsWith("/token")) {
      enterRefresh();
      await released;
      return Response.json({ access_token: "new-access", refresh_token: "new-refresh", token_type: "Bearer", expires_in: 900, scope: "search" });
    }
    assert.equal(String(url), `${apiUrl}/revoke`);
    revoked.push(new URLSearchParams(options.body).get("token"));
    return Response.json({});
  });
  try {
    process.env.XDG_CONFIG_HOME = directory;
    process.env.DOCSLURP_CREDENTIAL_STORE = "file";
    delete process.env.DOCSLURP_API_KEY;
    delete process.env.DOCSLURP_TOKEN;
    const account = credentialAccount("default", apiUrl);
    await saveCredential(account, credential);
    const auth = await resolveAuth({}, apiUrl);
    const refresh = auth.token({ forceRefresh: true });
    await entered;
    let logoutFinished = false;
    const logout = logoutCommand({}, apiUrl).then(() => { logoutFinished = true; });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(logoutFinished, false, "logout waits for the refresh lock");
    assert.deepEqual(revoked, [], "logout must not revoke the pre-rotation token");
    releaseRefresh();
    assert.equal(await refresh, "new-access");
    await logout;
    assert.deepEqual(revoked, ["new-refresh"]);
    assert.equal(await loadCredential(account), null);
    await assert.rejects(auth.token({ forceRefresh: true }), /changed or was signed out/);
  } finally {
    releaseRefresh();
    mock.restoreAll();
    process.env = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
