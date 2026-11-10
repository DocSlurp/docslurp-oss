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
