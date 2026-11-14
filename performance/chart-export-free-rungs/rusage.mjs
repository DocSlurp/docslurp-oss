// Preload (`node --import`) for bench.mjs: on exit, write this process's CPU time and peak RSS to $BENCH_RUSAGE.
import { writeFileSync } from "node:fs";

const out = process.env.BENCH_RUSAGE;
if (out) {
  process.on("exit", () => {
    const r = process.resourceUsage();
    writeFileSync(out, JSON.stringify({ userMs: r.userCPUTime / 1000, systemMs: r.systemCPUTime / 1000, maxRssKb: r.maxRSS }));
  });
}
