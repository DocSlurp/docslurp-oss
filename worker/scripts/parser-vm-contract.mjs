// Startup check for a trusted, pinned parser image. Does not process customer bytes.
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
for (const file of ["image-task.mjs", "pdf-structure.mjs", "quarantine-inspect.mjs", "../dist/deferred/pdf-structure-guest.js", "../dist/lib/quarantine-bytes.js"]) await access(fileURLToPath(new URL(file, import.meta.url)));
console.log(JSON.stringify({ protocol: "parser-vm@1" }));
