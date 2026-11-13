// Prepare the chart guest's optional V8 compile cache (`compileCacheDir`) ahead of time, for example at image build:
//
//   node --disallow-code-generation-from-strings scripts/chart-guest-compile-cache.mjs <dir>
//
// It compiles the guest bundle at its installed path and writes the cache. Node keys the cache by file, source, flags
// and uid, so run this as the user the guest runs as, with the same flag.
// The guest only reads a cache it cannot write and does not own (council r10 L3): afterwards, chown it to root and
// mount it read-only.
import module from "node:module";
import path from "node:path";

const dir = process.argv[2];
if (!dir || !path.isAbsolute(dir) || path.normalize(dir) !== dir) throw new Error("usage: chart-guest-compile-cache.mjs <absolute dir>");
const status = module.enableCompileCache(dir);
await import("../dist/chart-export/guest.bundle.mjs");
module.flushCompileCache();
console.log(JSON.stringify({ dir: module.getCompileCacheDir() ?? null, status: status?.status ?? null }));
