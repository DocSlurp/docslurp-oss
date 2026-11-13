// Startup check for a trusted, pinned parser image. Does not process customer bytes (the chart probe inputs are built in).
import { access, constants } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
for (const file of ["image-task.mjs", "pdf-structure.mjs", "quarantine-inspect.mjs", "chart-inline.mjs", "chart-inline-worker.mjs", "../dist/chart-export/inline-guest.js", "structured-json.mjs", "html-embeds.mjs", "table-cells.mjs", "vision-tables.mjs", "table-routing.mjs", "chart-export-extract.mjs", "../dist/chart-export/guest.bundle.mjs", "../dist/chart-export/extractors/index.js", "../dist/extractors/structured-json-guest.js", "../dist/routing/html-embeds-guest.js", "../dist/pipeline/table-cells-guest.js", "../dist/pipeline/vision-tables-guest.js", "../dist/pipeline/table-routing-guest.js", "../dist/pipeline/html-table-limits.js", "../dist/deferred/pdf-structure-guest.js", "../dist/lib/quarantine-bytes.js", "../dist/lib/archive-nesting.js", "../dist/lib/pdf-encryption-structure.js"]) await access(fileURLToPath(new URL(file, import.meta.url)));
// The chart-export guest runs one bundled module: refuse a stale bundle (worker dist changed after it was built), then
// import it and extract a built-in SVG and XLSX, so a bundle that is present but broken fails here, not per document.
const { probeChartGuestBundle, probeInlineCharts, verifyChartGuestBundle, verifyCompileCache } = await import("./chart-guest-bundle.mjs");
await verifyChartGuestBundle();
await probeChartGuestBundle();
// Inline charts (quarantine guest): the module imports and answers a built-in SVG; a shipped compile cache matches this
// Node binary and bundle.
await probeInlineCharts();
await verifyCompileCache();
// The table-routing guest scans with @docslurp/shared's scanner: the package must resolve from this image's worker.
await access(fileURLToPath(import.meta.resolve("@docslurp/shared/page-table-routing")));
// The chart-export and quarantine guests load only these @docslurp/shared modules (not the package index: ~0.3 s of CPU per run).
for (const sub of ["chart-export", "file-sniff"]) await access(fileURLToPath(import.meta.resolve(`@docslurp/shared/${sub}`)));
// parser-vm@4: quarantine inspection returns { sniffed, archive, pdf } (pdf: the /Encrypt check that sends an encrypted PDF to
// the in-VM qpdf decryption, and encryptConflict, the council N-H1 structure check; archive: the nested-archive walk, which
// walks tar and refuses nested 7z, bzip2 and xz); an older image is refused. qpdfVersion: the image's qpdf,
// which quarantine needs (the host refuses an image without it).
// tools: the command-line tools present in this image (PATH and the Python venv), so the host decides availability from the
// VM, not its own PATH (validation N7).
const TOOLS = ["pandoc", "clamscan", "clamdscan", "pdfinfo", "pdftotext", "pdftoppm", "pdfimages", "pdfseparate", "pdfunite", "pdftohtml", "qpdf", "tiffcp", "catdoc", "unrtf", "xlsx2csv", "prlimit", "python3", "node", "ffmpeg", "ffprobe"];
const dirs = [...(process.env.PATH ?? "").split(path.delimiter), path.join(process.env.PYTHON_VENV || "/app/.venv", "bin")].filter(Boolean);
const tools = [];
for (const tool of TOOLS) {
  for (const dir of dirs) {
    try { await access(path.join(dir, tool), constants.X_OK); tools.push(tool); break; } catch { /* next */ }
  }
}
// links: the kernel's hardlink and symlink protections (1 on, 0 off, null unknown); the host refuses 0.
import { readFile } from "node:fs/promises";
const sysctl = async (name) => { try { const value = Number((await readFile(`/proc/sys/fs/${name}`, "utf8")).trim()); return Number.isInteger(value) ? value : null; } catch { return null; } };
const links = { hardlinks: await sysctl("protected_hardlinks"), symlinks: await sysctl("protected_symlinks") };
// dumps / ptrace (recheck S #5): fs.suid_dumpable (the host requires 0) and kernel.yama.ptrace_scope (null without Yama;
// the host requires at least 1 when present). cgroupV2: whether per-command cgroups (and cgroup.kill) are possible.
const kernel = async (file) => { try { const value = Number((await readFile(file, "utf8")).trim()); return Number.isInteger(value) ? value : null; } catch { return null; } };
const hardening = { suidDumpable: await kernel("/proc/sys/fs/suid_dumpable"), ptraceScope: await kernel("/proc/sys/kernel/yama/ptrace_scope") };
let cgroupV2 = false;
try { await access("/sys/fs/cgroup/cgroup.controllers"); cgroupV2 = true; } catch { /* no unified hierarchy */ }
// uid: the user the host launched this as; the host refuses root (parser commands drop privileges in the VM).
import { execFileSync } from "node:child_process";
let qpdfVersion = null;
try { qpdfVersion = /^qpdf version (\d+\.\d+\.\d+)/m.exec(execFileSync("qpdf", ["--version"], { encoding: "utf8", timeout: 10_000 }))?.[1] ?? null; } catch { /* absent */ }
console.log(JSON.stringify({ protocol: "parser-vm@4", uid: process.getuid?.() ?? null, tools, links, hardening, cgroupV2, qpdfVersion }));
