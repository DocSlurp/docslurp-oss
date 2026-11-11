"""Quarantine latency probes on Modal runtime="vm" (driver in us-west, near Fly lax).

Arms (each sandbox terminated in finally):
  A  current path: fresh VM, upload signatures, clamscan --version (freshness), clamscan one file
  B  filesystem snapshot: VM from an image with signatures baked, clamscan one file
  C  memory snapshot: VM with clamd started on the staged signatures, snapshot taken BEFORE any job input;
     each scan job restores a fresh VM from it, uploads one file, clamdscan --fdpass
  D  batch: one restored VM scans N files (one org)
usage: modal run q1.py [--arms ABCD] [--reps 3]
"""
import json, os, time, hashlib
import modal

APP = "docslurp-quarantine-latency-probe"
CPU_USD, MEM_USD = 0.00003942, 0.0000067  # sandbox per physical core-s, per GiB-s
CORES, MEM = 2, 4096  # production DOCSLURP_MODAL_CPU / MEMORY_MB defaults

img = (
    modal.Image.debian_slim(python_version="3.12")
    .apt_install("clamav", "clamav-daemon", "clamav-freshclam", "procps")
    .run_commands("freshclam --stdout || freshclam --stdout", "mkdir -p /opt/sigs && cp /var/lib/clamav/*.c[lv]d /opt/sigs/ && ls -la /opt/sigs",
                  "rm -f /var/lib/clamav/*.c[lv]d")
)
app = modal.App(APP, image=img)

EICAR = b"X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*"


def pdf_bytes(i=0):
    body = f"BT /F1 12 Tf 72 720 Td (Quarterly revenue up {i}% on strong demand) Tj ET".encode()
    objs = [b"<< /Type /Catalog /Pages 2 0 R >>", b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
            b"<< /Length %d >>\nstream\n" % len(body) + body + b"\nendstream", b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"]
    out = bytearray(b"%PDF-1.4\n"); offs = []
    for n, o in enumerate(objs, 1):
        offs.append(len(out)); out += b"%d 0 obj\n" % n + o + b"\nendobj\n"
    x = len(out); out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1)
    for o in offs: out += b"%010d 00000 n \n" % o
    out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objs) + 1, x)
    return bytes(out)


CLAMD_CONF = """LocalSocket /run/docslurp-clamd/clamd.sock
LocalSocketMode 666
DatabaseDirectory /opt/docslurp-assets/sigs
Foreground false
User root
MaxThreads 4
ConcurrentDatabaseReload no
SelfCheck 0
"""


def mk(sapp, image, region=None, **kw):
    extra = {"region": region} if region else {}
    return modal.Sandbox.create("sleep", "infinity", app=sapp, image=image, cpu=(CORES, CORES), memory=(MEM, MEM),
                                runtime="vm", block_network=True, timeout=600, **extra, **kw)


def run(sb, *argv):
    p = sb.exec(*argv); out = p.stdout.read(); err = p.stderr.read(); code = p.wait()
    return code, out, err


def upload_sigs(sb, d="/opt/docslurp-assets/sigs"):
    sb.filesystem.make_directory(d)
    for f in sorted(os.listdir("/opt/sigs")):
        sb.filesystem.copy_from_local(f"/opt/sigs/{f}", f"{d}/{f}")
    return d


def put(sb, data, remote):
    open("/tmp/_in", "wb").write(data)
    sb.filesystem.copy_from_local("/tmp/_in", remote)


@app.function(region="us-west", cpu=2, memory=4096, timeout=3000)
def probe(arms: str, reps: int):
    sapp = modal.App.lookup(APP + "-sbx", create_if_missing=True)
    vm_img = img
    out = {"sigs": {f: os.path.getsize(f"/opt/sigs/{f}") for f in sorted(os.listdir("/opt/sigs"))}}
    secs = 0.0
    sigdir = "/opt/docslurp-assets/sigs"
    sigargs = []
    for f in sorted(os.listdir("/opt/sigs")):
        sigargs += ["--database", f"{sigdir}/{f}"]
    pdf = pdf_bytes()

    if "A" in arms:
        rows = []
        for r in range(reps):
            t0 = time.perf_counter(); sb = mk(sapp, vm_img)
            try:
                run(sb, "true"); t1 = time.perf_counter()
                upload_sigs(sb); t2 = time.perf_counter()
                c, v, _ = run(sb, "clamscan", "--database", sigdir, "--version"); t3 = time.perf_counter()
                put(sb, pdf, "/tmp/job.pdf"); t4 = time.perf_counter()
                c2, so, se = run(sb, "clamscan", *sigargs, "--no-summary", "--infected", "/tmp/job.pdf"); t5 = time.perf_counter()
                rows.append(dict(create_ready=t1 - t0, upload_sigs=t2 - t1, version_exec=t3 - t2, upload_file=t4 - t3, clamscan=t5 - t4,
                                 total=t5 - t0, version=v.strip(), scan_exit=c2))
            finally:
                sb.terminate(); secs += time.perf_counter() - t0
        out["A_current"] = rows

    if "B" in arms:
        t0 = time.perf_counter(); sb = mk(sapp, vm_img)
        try:
            run(sb, "true"); upload_sigs(sb); t1 = time.perf_counter()
            fimg = sb.snapshot_filesystem(); out["B_fs_snapshot_take_s"] = time.perf_counter() - t1
        finally:
            sb.terminate(); secs += time.perf_counter() - t0
        rows = []
        for r in range(reps):
            t0 = time.perf_counter(); sb = mk(sapp, fimg)
            try:
                run(sb, "true"); t1 = time.perf_counter()
                put(sb, pdf, "/tmp/job.pdf"); t2 = time.perf_counter()
                c2, so, se = run(sb, "clamscan", *sigargs, "--no-summary", "--infected", "/tmp/job.pdf"); t3 = time.perf_counter()
                rows.append(dict(create_ready=t1 - t0, upload_file=t2 - t1, clamscan=t3 - t2, total=t3 - t0, scan_exit=c2))
            finally:
                sb.terminate(); secs += time.perf_counter() - t0
        out["B_fs_snapshot"] = rows

    if "C" in arms or "D" in arms:
        build = {}
        t0 = time.perf_counter(); sb = mk(sapp, vm_img, region="us", _experimental_enable_snapshot=True)
        try:
            run(sb, "true"); t1 = time.perf_counter(); build["create_ready"] = t1 - t0
            upload_sigs(sb); t2 = time.perf_counter(); build["upload_sigs"] = t2 - t1
            put(sb, CLAMD_CONF.encode(), "/etc/docslurp-clamd.conf")
            run(sb, "mkdir", "-p", "/run/docslurp-clamd")
            c, o, e = run(sb, "clamd", "-c", "/etc/docslurp-clamd.conf"); t3 = time.perf_counter(); build["clamd_start_db_load"] = t3 - t2
            build["clamd_start"] = [c, o[-300:], e[-300:]]
            c, o, e = run(sb, "sh", "-c", "printf 'zVERSION\\0' | python3 -c \"import socket,sys;s=socket.socket(socket.AF_UNIX);s.connect('/run/docslurp-clamd/clamd.sock');s.sendall(b'zVERSION\\0');print(s.recv(200))\"")
            build["clamd_version"] = o.strip()
            c, o, e = run(sb, "sh", "-c", "ls /tmp /run | head; ps -eo rss,comm | sort -n | tail -3")
            build["pre_snapshot_state"] = o
            t4 = time.perf_counter(); snap = sb._experimental_snapshot(); build["snapshot_take"] = time.perf_counter() - t4
            build["snapshot_id"] = snap.object_id
        finally:
            sb.terminate(); secs += time.perf_counter() - t0
        out["C_build"] = build
        rows = []
        for r in range(reps if "C" in arms else 0):
            t0 = time.perf_counter(); sb = modal.Sandbox._experimental_from_snapshot(snap)
            try:
                run(sb, "true"); t1 = time.perf_counter()
                put(sb, pdf, "/tmp/job.pdf"); t2 = time.perf_counter()
                c, so, se = run(sb, "clamdscan", "--config-file=/etc/docslurp-clamd.conf", "--fdpass", "--no-summary", "--infected", "/tmp/job.pdf"); t3 = time.perf_counter()
                put(sb, EICAR, "/tmp/eicar.txt")
                ce, eo, ee = run(sb, "clamdscan", "--config-file=/etc/docslurp-clamd.conf", "--fdpass", "--no-summary", "--infected", "/tmp/eicar.txt"); t4 = time.perf_counter()
                cn, no, ne = run(sb, "python3", "-c", "import socket;s=socket.socket();s.settimeout(3)\ntry:\n s.connect(('1.1.1.1',443));print('NET-OPEN')\nexcept Exception as e:\n print('NET-BLOCKED',type(e).__name__)")
                cs, st, _ = run(sb, "sh", "-c", "ls /tmp; nproc; head -1 /proc/meminfo")
                rows.append(dict(restore_ready=t1 - t0, upload_file=t2 - t1, clamdscan=t3 - t2, eicar_scan=t4 - t3, scan_exit=c, eicar_exit=ce,
                                 eicar_out=eo.strip()[-120:], net=no.strip(), state=st, total_clean=t3 - t0))
            finally:
                sb.terminate(); secs += time.perf_counter() - t0
        out["C_mem_snapshot"] = rows
        if "D" in arms:
            t0 = time.perf_counter(); sb = modal.Sandbox._experimental_from_snapshot(snap)
            try:
                run(sb, "true"); t1 = time.perf_counter()
                per = []
                for i in range(10):
                    a = time.perf_counter(); put(sb, pdf_bytes(i), f"/tmp/job{i}.pdf"); b = time.perf_counter()
                    c, so, se = run(sb, "clamdscan", "--config-file=/etc/docslurp-clamd.conf", "--fdpass", "--no-summary", "--infected", f"/tmp/job{i}.pdf")
                    per.append(dict(upload=b - a, scan=time.perf_counter() - b, exit=c))
                files = " ".join(f"/tmp/job{i}.pdf" for i in range(10))
                a = time.perf_counter(); c, so, se = run(sb, "sh", "-c", f"clamdscan --config-file=/etc/docslurp-clamd.conf --fdpass --no-summary --infected {files}")
                out["D_batch"] = dict(restore_ready=t1 - t0, per_file=per, one_exec_10_files=time.perf_counter() - a, one_exec_exit=c)
            finally:
                sb.terminate(); secs += time.perf_counter() - t0
    out["sandbox_seconds"] = secs
    out["usd"] = secs * (CORES * CPU_USD + MEM / 1024 * MEM_USD)
    return out


@app.local_entrypoint()
def main(arms: str = "ABCD", reps: int = 3):
    t = time.time()
    res = probe.remote(arms, reps)
    wall = time.time() - t
    res["driver_wall_s"] = wall
    drv = wall * (2 * 0.0000131 + 4 * 0.00000222)
    print(json.dumps(res, indent=1, default=str))
    out_dir = os.environ.get("Q1_OUT_DIR", ".")
    with open(os.path.join(out_dir, "q1.jsonl"), "a") as f:
        f.write(json.dumps(res, default=str) + "\n")
    with open(os.path.join(out_dir, "ledger.jsonl"), "a") as f:
        f.write(json.dumps(dict(ts=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), track="quarantine-latency", label=f"q1 probe arms={arms} reps={reps}",
                                sandbox_usd=round(res["usd"], 4), driver_usd=round(drv, 4), usd=round(res["usd"] + drv, 4))) + "\n")
