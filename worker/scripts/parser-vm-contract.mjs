// Startup check for a trusted, pinned parser image. Does not process customer bytes.
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
for (const file of ["image-task.mjs", "pdf-structure.mjs", "quarantine-inspect.mjs", "structured-json.mjs", "html-embeds.mjs", "table-cells.mjs", "../dist/extractors/structured-json-guest.js", "../dist/routing/html-embeds-guest.js", "../dist/pipeline/table-cells-guest.js", "../dist/pipeline/html-table-limits.js", "../dist/deferred/pdf-structure-guest.js", "../dist/lib/quarantine-bytes.js"]) await access(fileURLToPath(new URL(file, import.meta.url)));
// parser-vm@2: quarantine inspection returns { sniffed, archive } (the host derives the file facts); an older image is refused.
console.log(JSON.stringify({ protocol: "parser-vm@2" }));
