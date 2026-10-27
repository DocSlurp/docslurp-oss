/** Dumps listWorkspaces/getWorkspace output for parity checks between arms. Usage: tsx perf-workspace-dump.ts <out.json> */
import { writeFileSync } from "node:fs";
import { sql } from "../src/db.js";
import { getWorkspace, listWorkspaces } from "../src/services/workspaces.js";
const list = await listWorkspaces("u", { refineNames: false });
const one = await getWorkspace("ws-7", "u");
writeFileSync(process.argv[2]!, JSON.stringify({ list: [...list].sort((a, b) => a.id.localeCompare(b.id)), one }, null, 1));
await sql.end({ timeout: 1 });
