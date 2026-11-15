// Free local diagnostic: run each arm in a fresh process. Not an ingestion benchmark.
import { spawnSync } from "node:child_process";
const helper = new URL("../../worker/src/lib/text-counts.ts", import.meta.url).href;
for (const mode of ["legacy", "bounded"]) {
  for (let run = 0; run < 3; run += 1) {
    const code = `import { countWhitespaceAndWords } from ${JSON.stringify(helper)};
      const text = ('alpha beta gamma delta\\n').repeat(Math.ceil(10*1024*1024/23)).slice(0,10*1024*1024);
      const start = performance.now();
      const counts = ${JSON.stringify(mode)} === 'legacy'
        ? {whitespaceCount:(text.match(/\\s/g)??[]).length, words:text.trim().split(/\\s+/).filter(Boolean).length}
        : countWhitespaceAndWords(text);
      console.log(JSON.stringify({mode:${JSON.stringify(mode)},node:process.version,bytes:Buffer.byteLength(text),...counts,ms:performance.now()-start,maxRssKiB:process.resourceUsage().maxRSS}));`;
    const result = spawnSync(process.execPath, ["--input-type=module", "-"], { input: code, encoding: "utf8" });
    if (result.error || result.status !== 0) throw new Error(result.stderr || "diagnostic child failed");
    process.stdout.write(result.stdout);
  }
}
