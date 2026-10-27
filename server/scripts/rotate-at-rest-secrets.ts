import "../src/env.js";
import { rotateStoredSecrets } from "../src/lib/secret-rotation.js";

const args = process.argv.slice(2);
if (args.some((arg) => arg !== "--apply" && arg !== "--dry-run" && !/^--limit=\d+$/.test(arg)) ||
    (args.includes("--apply") && args.includes("--dry-run"))) {
  throw new Error("Usage: tsx server/scripts/rotate-at-rest-secrets.ts [--dry-run | --apply] [--limit=100] (max 10000 per store)");
}
const apply = args.includes("--apply");
const limit = Number(args.find((arg) => arg.startsWith("--limit="))?.slice(8) ?? 100);
// Import DB only after argument validation. Never print secret values or key material.
const { sql } = await import("../src/db.js");
try {
  console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", limitPerStore: limit,
    results: await rotateStoredSecrets(sql, { apply, limit }) }, null, 2));
} finally {
  await sql.end();
}
