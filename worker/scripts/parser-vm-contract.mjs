// Startup check for a trusted, pinned parser image. Does not process customer bytes.
import { access, constants } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
for (const file of ["image-task.mjs", "pdf-structure.mjs", "quarantine-inspect.mjs", "structured-json.mjs", "html-embeds.mjs", "table-cells.mjs", "../dist/extractors/structured-json-guest.js", "../dist/routing/html-embeds-guest.js", "../dist/pipeline/table-cells-guest.js", "../dist/pipeline/html-table-limits.js", "../dist/deferred/pdf-structure-guest.js", "../dist/lib/quarantine-bytes.js"]) await access(fileURLToPath(new URL(file, import.meta.url)));
// parser-vm@2: quarantine inspection returns { sniffed, archive } (the host derives the file facts); an older image is refused.
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
// uid: the user the host launched this as; the host refuses root (parser commands drop privileges in the VM).
console.log(JSON.stringify({ protocol: "parser-vm@2", uid: process.getuid?.() ?? null, tools, links }));
