/** Dumps listProjects/getProject output for parity checks between arms. Usage: tsx perf-project-dump.ts <out.json> */
import { writeFileSync } from "node:fs";
import { sql } from "../src/db.js";
import { getProject, listProjects } from "../src/services/projects.js";
const list = await listProjects("u", { refineNames: false });
const one = await getProject("ws-7", "u");
writeFileSync(process.argv[2]!, JSON.stringify({ list: [...list].sort((a, b) => a.id.localeCompare(b.id)), one }, null, 1));
await sql.end({ timeout: 1 });
