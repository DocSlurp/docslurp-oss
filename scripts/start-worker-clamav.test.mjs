import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync, spawn } from "node:child_process";
import { once } from "node:events";
const startup = new URL("./start-worker.sh", import.meta.url).pathname;
const stamp = (hours) => {
  const d = new Date(Date.now() - hours * 3600000);
  return `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getUTCDay()]} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()]} ${d.getUTCDate()} ${d.toISOString().slice(11, 19)} ${d.getUTCFullYear()}`;
};
async function fixture(
  t,
  {
    age = 25,
    updateFails = false,
    version,
    daemonFails = false,
    workerCode = 0,
    workerSignal = false,
    drainMs = 0,
  } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "clam-startup-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bin = join(dir, "bin"),
    db = join(dir, "db"),
    run = join(dir, "run"),
    log = join(dir, "log");
  for (const path of [bin, db, run, log]) await mkdir(path);
  const versionFile = join(dir, "version"),
    calls = join(dir, "calls.jsonl"),
    worker = join(dir, "worker"),
    versionTZ = join(dir, "version-tz");
  await writeFile(
    join(db, "daily.cvd"),
    "synthetic definitions with a freshly copied file timestamp",
  );
  await writeFile(versionFile, version ?? `ClamAV 1.4.3/123/${stamp(age)}`);
  await writeFile(
    join(bin, "clamscan"),
    `#!${process.execPath}\nconst fs=require('node:fs');fs.appendFileSync(${JSON.stringify(versionTZ)},process.env.TZ+'\\n');console.log(fs.readFileSync(${JSON.stringify(versionFile)},'utf8'));`,
    { mode: 0o755 },
  );
  await writeFile(
    join(bin, "freshclam"),
    `#!${process.execPath}
const fs=require('node:fs');const args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify({args,secret:process.env.DATABASE_URL??null,keys:Object.keys(process.env),pid:process.pid})+'\\n');
if(args.includes('--daemon')){if(${daemonFails})process.exit(23);process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000);}
else {if(${updateFails})process.exit(23);fs.writeFileSync(${JSON.stringify(versionFile)},${JSON.stringify(`ClamAV 1.4.3/124/${stamp(1)}`)});}
`,
    { mode: 0o755 },
  );
  await writeFile(
    join(bin, "node"),
    `#!${process.execPath}
const fs=require('node:fs');if(process.argv[2]?.includes('check-worker-prerequisites'))process.exit(0);fs.writeFileSync(${JSON.stringify(worker)},'started');
${workerSignal ? `for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{fs.writeFileSync(${JSON.stringify(worker)},signal);setTimeout(()=>process.exit(0),${drainMs})});setInterval(()=>{},1000);` : `setTimeout(()=>process.exit(${workerCode}),300);`}
`,
    { mode: 0o755 },
  );
  const env = {
    ...process.env,
    PATH: bin + ":" + process.env.PATH,
    NODE_ENV: "production",
    DATABASE_URL: "synthetic-secret-must-not-reach-updater",
    DOCSLURP_WORKER_INSTALL_HEAVY_DEPS_ON_STARTUP: "false",
    DOCSLURP_CLAMAV_DB_DIR: db,
    DOCSLURP_CLAMAV_RUN_DIR: run,
    DOCSLURP_CLAMAV_LOG_DIR: log,
    DOCSLURP_CLAMAV_MANAGE_DAEMON: "false",
    DOCSLURP_CLAMAV_REQUIRE_DAEMON: "false",
    DOCSLURP_CLAMAV_UPDATE_ON_STARTUP: "if-stale",
    DOCSLURP_CLAMAV_FAIL_OPEN_ON_STALE_DB: "false",
  };
  return {
    dir,
    env,
    worker,
    calls,
    versionTZ,
    run: () => {
      const r = spawnSync("bash", [startup], {
        env,
        encoding: "utf8",
        timeout: 12000,
      });
      assert.equal(
        r.error,
        undefined,
        "startup must settle without a test timeout",
      );
      return r;
    },
    readCalls: async () => {
      try {
        return (await readFile(calls, "utf8"))
          .trim()
          .split("\n")
          .filter(Boolean)
          .map(JSON.parse);
      } catch {
        return [];
      }
    },
  };
}
test("freshly copied files cannot hide an old signature header; refresh and periodic updater receive no credentials", async (t) => {
  const f = await fixture(t);
  const r = f.run();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const calls = await f.readCalls();
  assert.ok(
    calls.some((c) => !c.args.includes("--daemon")),
    "old header requires refresh despite fresh mtime",
  );
  assert.ok(
    calls.some(
      (c) => c.args.includes("--daemon") && c.args.includes("--foreground"),
    ),
    "long-lived worker needs native updater",
  );
  for (const c of calls) {
    assert.equal(c.secret, null);
    assert.ok(c.keys.every((k) => ["PATH", "HOME", "LANG", "TZ"].includes(k)));
  }
  await readFile(f.worker);
  for (const c of calls.filter((c) => c.args.includes("--daemon")))
    assert.throws(() => process.kill(c.pid, 0), { code: "ESRCH" });
});
test("failed update with an expired header refuses worker startup despite fresh file timestamps", async (t) => {
  const f = await fixture(t, { updateFails: true });
  const r = f.run();
  assert.notEqual(r.status, 0);
  await assert.rejects(readFile(f.worker), { code: "ENOENT" });
});
for (const version of [
  "",
  "malformed",
  "ClamAV bad/123/" + stamp(1),
  "ClamAV 1.4.3/123/now",
  "ClamAV 1.4.3/123/" + stamp(-48),
])
  test(
    "invalid or future signature metadata refuses startup: " +
      version.split("/").at(-1),
    async (t) => {
      const f = await fixture(t, { version, updateFails: true });
      const r = f.run();
      assert.notEqual(r.status, 0);
      await assert.rejects(readFile(f.worker), { code: "ENOENT" });
    },
  );
test("a failed native updater stops the worker; worker exit status survives supervision", async (t) => {
  const failed = await fixture(t, {
    age: 1,
    daemonFails: true,
    workerSignal: true,
  });
  const r = failed.run();
  assert.notEqual(r.status, 0);
  assert.notEqual(r.error?.code, "ETIMEDOUT");
  const exited = await fixture(t, { age: 1, workerCode: 7 });
  assert.equal(exited.run().status, 7);
});

for (const zone of ["Asia/Tokyo", "America/Los_Angeles"])
  test("signature metadata always uses UTC on " + zone, async (t) => {
    const f = await fixture(t, { age: 1 });
    f.env.TZ = zone;
    const r = f.run();
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const zones = (await readFile(f.versionTZ, "utf8")).trim().split("\n");
    assert.ok(zones.length >= 2);
    assert.ok(zones.every((z) => z === "UTC"));
  });
for (const [limit, age, ok] of [["25", 24.5, true], ["48", 47, true], ["69", 60, true], ["70", 60, true], ["72", 71, true], ["48", 49, false], ["72", 73, false]])
  test(`a deployed limit of ${limit}h ${ok ? "accepts" : "refuses"} ${age}h-old signatures`, async (t) => {
    const f = await fixture(t, { age, updateFails: true });
    f.env.DOCSLURP_CLAMAV_MAX_DB_AGE_HOURS = limit;
    const r = f.run();
    if (ok) assert.equal(r.status, 0, r.stdout + r.stderr);
    else {
      assert.notEqual(r.status, 0);
      await assert.rejects(readFile(f.worker), { code: "ENOENT" });
    }
  });
test("a fractional day beyond the freshness deadline is refused", async (t) => {
  const f = await fixture(t, { age: 24.5, updateFails: true });
  const r = f.run();
  assert.notEqual(r.status, 0);
  await assert.rejects(readFile(f.worker), { code: "ENOENT" });
});

for (const signal of ["SIGTERM", "SIGINT"])
  test("parent " + signal + " drains worker and reaps updater", async (t) => {
    const f = await fixture(t, { age: 1, workerSignal: true });
    const child = spawn("bash", [startup], {
      env: f.env,
      stdio: ["ignore", "ignore", "ignore"],
    });
    t.after(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    });
    const end = Date.now() + 5000;
    let calls = [];
    while (Date.now() < end) {
      calls = await f.readCalls();
      try {
        await readFile(f.worker);
        if (calls.some((c) => c.args.includes("--daemon"))) break;
      } catch {}
      await new Promise((r) => setTimeout(r, 10));
    }
    const updater = calls.find((c) => c.args.includes("--daemon"));
    assert.ok(updater, "managed updater started");
    // Let the synthetic worker install its own graceful handlers before delivery.
    await new Promise((r) => setTimeout(r, 50));
    const exit = once(child, "exit");
    child.kill(signal);
    const timeout = setTimeout(() => child.kill("SIGKILL"), 5000);
    const [code, terminatedBy] = await exit;
    clearTimeout(timeout);
    assert.equal(terminatedBy, null);
    assert.equal(code, signal === "SIGTERM" ? 143 : 130);
    assert.equal(await readFile(f.worker, "utf8"), signal);
    assert.throws(() => process.kill(updater.pid, 0), { code: "ESRCH" });
  });
test("external updater opt-out keeps worker execution and startup freshness enforcement", async (t) => {
  const f = await fixture(t, { age: 1 });
  f.env.DOCSLURP_CLAMAV_MANAGE_UPDATER = "false";
  assert.equal(f.run().status, 0);
  assert.ok(!(await f.readCalls()).some((c) => c.args.includes("--daemon")));
});

for (const disabled of ["false", "0", "no", "off"])
  test(
    "explicit update opt-out " +
      disabled +
      " prevents periodic network updater",
    async (t) => {
      const f = await fixture(t, { age: 1 });
      f.env.DOCSLURP_CLAMAV_UPDATE_ON_STARTUP = disabled;
      assert.equal(f.run().status, 0);
      assert.deepEqual(await f.readCalls(), []);
    },
  );

for (const target of ["WORKER_PID", "FRESHCLAM_PID"])
  for (const signal of ["TERM", "INT"])
    test(
      signal + " during " + target + " capture reaps the owned child",
      async (t) => {
        const f = await fixture(t, { age: 1, workerSignal: true });
        const pidFile = join(f.dir, "race-child-pid");
        // Capture the worker's actual PID before accepting the injected signal.
        await writeFile(
          join(f.dir, "bin", "node"),
          `#!${process.execPath}
const fs=require('node:fs');if(process.argv[2]?.includes('check-worker-prerequisites'))process.exit(0);fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>process.exit(0));setInterval(()=>{},1000);`,
          { mode: 0o755 },
        );
        const envFile = join(f.dir, "bash-env");
        const ready = target === "WORKER_PID" ? pidFile : f.calls;
        await writeFile(
          envFile,
          `qa_inject_signal() {
  if [[ "$1" == '${target}="$!"' ]]; then
    for attempt in {1..100}; do [[ -s ${JSON.stringify(ready)} ]] && break; sleep 0.01; done
    kill -${signal} "$$"
  fi
}
set -T
trap 'qa_inject_signal "$BASH_COMMAND"' DEBUG
`,
        );
        f.env.BASH_ENV = envFile;
        const child = spawn("bash", [startup], {
          env: f.env,
          stdio: ["ignore", "ignore", "ignore"],
        });
        const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
        const [code, endedBy] = await once(child, "exit");
        clearTimeout(timer);
        const calls = await f.readCalls();
        const pids = calls
          .filter((c) => c.args.includes("--daemon"))
          .map((c) => c.pid);
        try {
          pids.push(Number(await readFile(pidFile, "utf8")));
        } catch {}
        let survivors = [];
        for (const pid of pids) {
          try {
            process.kill(pid, 0);
            survivors.push(pid);
            process.kill(pid, "SIGKILL");
          } catch {}
        }
        assert.equal(endedBy, null);
        assert.equal(code, signal === "TERM" ? 143 : 130);
        assert.ok(pids.length > 0);
        assert.deepEqual(survivors, [], "no child survives its supervisor");
      },
    );

for (const first of ["SIGTERM", "SIGINT"])
  for (const repeated of ["SIGTERM", "SIGINT"])
    test(
      repeated +
        " during " +
        first +
        " drain coalesces without orphaning children",
      async (t) => {
        const f = await fixture(t, {
          age: 1,
          workerSignal: true,
          drainMs: 400,
        });
        const child = spawn("bash", [startup], {
          env: f.env,
          stdio: ["ignore", "ignore", "ignore"],
        });
        t.after(() => {
          if (child.exitCode === null) child.kill("SIGKILL");
        });
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
          try {
            if ((await readFile(f.worker, "utf8")) === "started") break;
          } catch {}
          await new Promise((r) => setTimeout(r, 10));
        }
        await new Promise((r) => setTimeout(r, 50));
        const exit = once(child, "exit");
        child.kill(first);
        while (Date.now() < deadline) {
          if ((await readFile(f.worker, "utf8")) === first) break;
          await new Promise((r) => setTimeout(r, 10));
        }
        assert.equal(await readFile(f.worker, "utf8"), first);
        child.kill(repeated);
        const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
        const [code, endedBy] = await exit;
        clearTimeout(timer);
        assert.equal(endedBy, null);
        assert.equal(code, first === "SIGTERM" ? 143 : 130);
        assert.equal(await readFile(f.worker, "utf8"), first);
        for (const c of (await f.readCalls()).filter((c) =>
          c.args.includes("--daemon"),
        ))
          assert.throws(() => process.kill(c.pid, 0), { code: "ESRCH" });
      },
    );

// #398: development-only settings that weaken untrusted-file protection stop startup anywhere else, before ClamAV
// refreshes or the worker starts, and are never silently ignored.
const unsafeOverrides = [
  "DOCSLURP_PARSER_SANDBOX_ALLOW_UNISOLATED",
  "DOCSLURP_SANDBOX_ALLOW_UNFILTERED_SOCKETS",
  "QUARANTINE_FAIL_OPEN_ON_TOOL_MISSING",
  "DOCSLURP_CLAMAV_FAIL_OPEN_ON_STALE_DB",
];
for (const name of unsafeOverrides)
  for (const [label, envPatch] of [
    ["NODE_ENV=production", { NODE_ENV: "production" }],
    ["NODE_ENV=staging", { NODE_ENV: "staging" }],
    ["the service profile", { NODE_ENV: "", DOCSLURP_SERVICE_PROFILE: "service" }],
    ["DOCSLURP_PROFILE=service", { NODE_ENV: "", DOCSLURP_PROFILE: "service" }],
    ["DOCSLURP_PROFILE=dev under NODE_ENV=production", { NODE_ENV: "production", DOCSLURP_PROFILE: "dev" }],
  ])
    for (const value of ["true", "1", " TRUE ", "ture"])
      test(`${name}=${JSON.stringify(value)} under ${label} refuses startup`, async (t) => {
        const f = await fixture(t, { age: 1 });
        Object.assign(f.env, envPatch, { [name]: value });
        const r = f.run();
        assert.equal(r.status, 1, r.stdout + r.stderr);
        assert.match(r.stderr, new RegExp(`error: .*${name}.*Refusing to start`));
        await assert.rejects(readFile(f.worker), { code: "ENOENT" });
        assert.deepEqual(await f.readCalls(), [], "refused before any ClamAV work");
      });

for (const value of ["", "false", "0", "off", "no"])
  test(`explicit off value ${JSON.stringify(value)} for every override starts in production`, async (t) => {
    const f = await fixture(t, { age: 1 });
    for (const name of unsafeOverrides) f.env[name] = value;
    const r = f.run();
    assert.equal(r.status, 0, r.stdout + r.stderr);
    await readFile(f.worker);
  });

test("stale signatures fail closed by default in development", async (t) => {
  const f = await fixture(t, { updateFails: true });
  f.env.NODE_ENV = "development";
  delete f.env.DOCSLURP_CLAMAV_FAIL_OPEN_ON_STALE_DB;
  const r = f.run();
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /error: ClamAV signature database is stale/);
  await assert.rejects(readFile(f.worker), { code: "ENOENT" });
});

for (const nodeEnv of ["development", "test", ""])
  test(`an explicit stale-signature opt-in warns and starts under NODE_ENV=${nodeEnv || "unset"}`, async (t) => {
    const f = await fixture(t, { updateFails: true });
    f.env.NODE_ENV = nodeEnv;
    f.env.DOCSLURP_CLAMAV_FAIL_OPEN_ON_STALE_DB = "true";
    f.env.DOCSLURP_SANDBOX_ALLOW_UNFILTERED_SOCKETS = "1";
    const r = f.run();
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stderr, /warning: ClamAV signature database is stale/);
    await readFile(f.worker);
  });

// #398 council: disabling quarantine and the unisolated `none` parser sandbox are development-only too.
const deployedEnvironments = [
  ["NODE_ENV=production", { NODE_ENV: "production" }],
  ["NODE_ENV=staging", { NODE_ENV: "staging" }],
  ["NODE_ENV=Preview", { NODE_ENV: "Preview" }],
  ["NODE_ENV=<NBSP>development", { NODE_ENV: " development" }],
  ["NODE_ENV=<BOM>", { NODE_ENV: "﻿" }],
  ["NODE_ENV=dev elopment", { NODE_ENV: "dev elopment" }],
  ["the service profile", { NODE_ENV: "", DOCSLURP_SERVICE_PROFILE: "service" }],
  ["DOCSLURP_PROFILE=service", { NODE_ENV: "development", DOCSLURP_PROFILE: " Service " }],
  ["DOCSLURP_PROFILE=selfhost under NODE_ENV=staging", { NODE_ENV: "staging", DOCSLURP_PROFILE: "selfhost" }],
];
for (const [name, value] of [
  ["QUARANTINE_ENABLED", "false"],
  ["QUARANTINE_ENABLED", " OFF "],
  ["QUARANTINE_ENABLED", "0"],
  ["QUARANTINE_ENABLED", "flase"],
  ["DOCSLURP_PARSER_SANDBOX", "none"],
  ["DOCSLURP_PARSER_SANDBOX", " None "],
])
  for (const [label, envPatch] of deployedEnvironments)
    test(`${name}=${JSON.stringify(value)} under ${label} refuses startup`, async (t) => {
      const f = await fixture(t, { age: 1 });
      Object.assign(f.env, envPatch, { [name]: value });
      const r = f.run();
      assert.equal(r.status, 1, r.stdout + r.stderr);
      assert.match(r.stderr, new RegExp(`error: .*${name}.*Refusing to start`));
      await assert.rejects(readFile(f.worker), { code: "ENOENT" });
      assert.deepEqual(await f.readCalls(), [], "refused before any ClamAV work");
    });

for (const [name, value] of [["QUARANTINE_ENABLED", "true"], ["QUARANTINE_ENABLED", ""], ["DOCSLURP_PARSER_SANDBOX", "bubblewrap"], ["DOCSLURP_PARSER_SANDBOX", "landlock"], ["DOCSLURP_PARSER_SANDBOX", "modal"]])
  test(`${name}=${JSON.stringify(value)} starts in production`, async (t) => {
    const f = await fixture(t, { age: 1 });
    f.env[name] = value;
    const r = f.run();
    assert.equal(r.status, 0, r.stdout + r.stderr);
    await readFile(f.worker);
  });

for (const [name, value] of [["QUARANTINE_ENABLED", "false"], ["DOCSLURP_PARSER_SANDBOX", "none"]])
  test(`${name}=${value} is allowed in development`, async (t) => {
    const f = await fixture(t, { age: 1 });
    Object.assign(f.env, { NODE_ENV: "development", [name]: value });
    const r = f.run();
    assert.equal(r.status, 0, r.stdout + r.stderr);
    await readFile(f.worker);
  });

// #398 council: every ClamAV preparation and refresh failure fails closed outside development (the same normalized
// development rule as the worker), not only under an exact NODE_ENV=production; development stays lenient.
const lenientOnlyInDevelopment = [
  ["NODE_ENV=staging", { NODE_ENV: "staging" }],
  ["NODE_ENV=Production", { NODE_ENV: "Production" }],
  ["NODE_ENV=<NBSP>development", { NODE_ENV: " development" }],
  ["NODE_ENV=dev elopment", { NODE_ENV: "dev elopment" }],
];
async function uncreatableDir(f) {
  const blocker = join(f.dir, "blocker");
  await writeFile(blocker, "a file where a directory parent should be");
  return join(blocker, "clamav");
}
for (const [label, envPatch] of lenientOnlyInDevelopment) {
  test(`a missing, uncreatable ClamAV directory refuses startup under ${label}`, async (t) => {
    const f = await fixture(t, { age: 1 });
    Object.assign(f.env, envPatch, { DOCSLURP_CLAMAV_LOG_DIR: await uncreatableDir(f) });
    const r = f.run();
    assert.notEqual(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stderr, /error: ClamAV directory .* is missing and cannot be created/);
    await assert.rejects(readFile(f.worker), { code: "ENOENT" });
  });

  test(`a failed freshclam refresh with stale signatures refuses startup under ${label}`, async (t) => {
    const f = await fixture(t, { updateFails: true });
    Object.assign(f.env, envPatch);
    const r = f.run();
    assert.notEqual(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stderr, /error: freshclam failed to update signatures/);
    await assert.rejects(readFile(f.worker), { code: "ENOENT" });
  });

  test(`the managed signature updater runs by default under ${label}`, async (t) => {
    const f = await fixture(t, { age: 1 });
    Object.assign(f.env, envPatch);
    const r = f.run();
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok((await f.readCalls()).some((c) => c.args.includes("--daemon")), "freshclam --daemon started");
  });
}

test("development stays lenient: a missing ClamAV directory warns and the worker starts", async (t) => {
  const f = await fixture(t, { age: 1 });
  Object.assign(f.env, { NODE_ENV: "development", DOCSLURP_CLAMAV_LOG_DIR: await uncreatableDir(f) });
  const r = f.run();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stderr, /warning: ClamAV directory .* is missing and cannot be created/);
  await readFile(f.worker);
});

test("development stays lenient: a failed refresh only warns before the freshness check", async (t) => {
  const f = await fixture(t, { updateFails: true });
  Object.assign(f.env, { NODE_ENV: " Development ", DOCSLURP_CLAMAV_FAIL_OPEN_ON_STALE_DB: "true" });
  const r = f.run();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stderr, /warning: freshclam failed to update signatures/);
  await readFile(f.worker);
});

test("development runs no managed updater by default", async (t) => {
  const f = await fixture(t, { age: 1 });
  f.env.NODE_ENV = "development";
  const r = f.run();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(!(await f.readCalls()).some((c) => c.args.includes("--daemon")));
});

for (const nodeEnv of ["production", "staging", "preview", "prodution", "\u00a0development"]) {
  for (const [name, value] of [
    ["DOCSLURP_CLAMAV_ENABLED", "false"],
    ["DOCSLURP_CLAMAV_ENABLED", "typo"],
    ["DOCSLURP_CLAMAV_MAX_DB_AGE_HOURS", "999999"],
    ["DOCSLURP_CLAMAV_MAX_DB_AGE_HOURS", "73"],
    ["DOCSLURP_CLAMAV_MAX_DB_AGE_HOURS", "100"],
    ["DOCSLURP_CLAMAV_MAX_DB_AGE_HOURS", "0"],
    ["DOCSLURP_CLAMAV_MAX_DB_AGE_HOURS", "072"],
    ["DOCSLURP_CLAMAV_MAX_DB_AGE_HOURS", "7.2"],
    // Digits from another script: [0-9] would match them under a UTF-8 locale.
    ["DOCSLURP_CLAMAV_MAX_DB_AGE_HOURS", "\u0664\u0668"],
    ["DOCSLURP_CLAMAV_MAX_DB_AGE_HOURS", "1+999"],
  ]) {
    test(`startup refuses ${name}=${value} in ${nodeEnv}`, () => {
      const result = spawnSync("bash", [startup], { env: { ...process.env, LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8", NODE_ENV: nodeEnv, [name]: value }, encoding: "utf8", timeout: 5000 });
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, new RegExp(name));
      assert.match(result.stderr, /Refusing to start/);
    });
  }
}
