#!/usr/bin/env node
/**
 * Re-records worker/src/test/fixtures/page-box-equivalence.json: each case's crafted PDF (worker/src/test/page-box-pdf.ts,
 * built from the case spec) measured by pdfinfo and rendered by pdftoppm -png -cropbox in each Poppler build, plus Doppler's
 * page facts. Every build runs in a local container with no network, as the calling user, on generated PDFs only.
 *
 *   POPPLER_IMAGE=<worker image>  DOPPLER_IMAGE=<Doppler VM image> \
 *   node --experimental-strip-types worker/scripts/page-box-equivalence.mjs [--write]
 *
 * Binary paths default to /usr/bin (POPPLER_BIN) and /opt/doppler/bin (DOPPLER_BIN). Prints the table; --write updates the
 * fixture (the build labels inside it are kept: set POPPLER_LABEL / DOPPLER_LABEL when versions change).
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(here, "../src/test/fixtures/page-box-equivalence.json");
const { pageBoxPdf } = await import(path.join(here, "../src/test/page-box-pdf.ts"));
const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
const cases = Object.entries(fixture).filter(([name]) => name !== "_meta");

const builds = [
  { key: process.env.POPPLER_LABEL ?? "poppler-25.03", image: process.env.POPPLER_IMAGE, bin: process.env.POPPLER_BIN ?? "/usr/bin", facts: false },
  { key: process.env.DOPPLER_LABEL ?? "doppler-26.10.90", image: process.env.DOPPLER_IMAGE, bin: process.env.DOPPLER_BIN ?? "/opt/doppler/bin", facts: true },
];
for (const build of builds) if (!build.image) throw new Error(`set the image for ${build.key} (POPPLER_IMAGE / DOPPLER_IMAGE)`);

const root = mkdtempSync(path.join(process.env.TMPDIR ?? tmpdir(), "page-box-equivalence-"));
try {
  const input = path.join(root, "in");
  execFileSync("mkdir", ["-p", input]);
  for (const [name, entry] of cases) writeFileSync(path.join(input, `${name}.pdf`), pageBoxPdf(entry.spec));
  const probe = [
    'set -u; for f in /in/*.pdf; do n=$(basename "$f" .pdf); o=/out/$n;',
    '"$BIN/pdfinfo" "$f" > "$o.pdfinfo" 2>/dev/null;',
    'r=144; [ "$n" = huge ] && r=7.2;',
    '"$BIN/pdftoppm" -png -cropbox -r "$r" -f 1 -l 1 "$f" "$o.r" 2>/dev/null;',
    '"$BIN/pdftoppm" -png -cropbox -scale-to 1600 -r 150 -f 1 -l 1 "$f" "$o.cap" 2>/dev/null;',
    'if [ "$FACTS" = 1 ]; then "$BIN/pdftomarkdown" --page-facts "$o.facts" "$f" > /dev/null 2>&1; fi; done',
  ].join(" ");
  const { uid, gid } = userInfo();
  for (const build of builds) {
    const out = path.join(root, build.key);
    execFileSync("mkdir", ["-p", out]);
    execFileSync("docker", ["run", "--rm", "--network", "none", "--user", `${uid}:${gid}`, "-e", `BIN=${build.bin}`, "-e", `FACTS=${build.facts ? 1 : 0}`,
      "-v", `${input}:/in:ro`, "-v", `${out}:/out`, "--entrypoint", "sh", build.image, "-c", probe], { stdio: "inherit" });
  }
  const read = (file) => (existsSync(file) ? readFileSync(file) : null);
  const info = (build, name) => {
    const text = read(path.join(root, build, `${name}.pdfinfo`))?.toString() ?? "";
    const size = text.match(/^Page size:\s+([-\d.e+]+) x ([-\d.e+]+) pts/m);
    const rotate = text.match(/^Page rot:\s+(-?\d+)/m);
    return size ? { widthPt: Number(size[1]), heightPt: Number(size[2]), rotate: Number(rotate?.[1] ?? 0) } : null;
  };
  const px = (build, name, stem) => {
    const png = readdirSync(path.join(root, build)).find((file) => file.startsWith(`${name}.${stem}-`) && file.endsWith(".png"));
    const bytes = png ? readFileSync(path.join(root, build, png)) : null;
    return bytes && bytes.length >= 24 ? [bytes.readUInt32BE(16), bytes.readUInt32BE(20)] : null;
  };
  const facts = (name) => {
    const text = read(path.join(root, builds[1].key, `${name}.facts`))?.toString();
    const page = text?.split("\n").filter(Boolean).map((line) => JSON.parse(line)).find((line) => line.type === "page");
    return page ? { geometry: page.geometry, parseWarnings: page.parseWarnings } : null;
  };
  const next = { _meta: fixture._meta };
  for (const [name, entry] of cases) {
    next[name] = {
      spec: entry.spec,
      pdfinfo: Object.fromEntries(builds.map((build) => [build.key, info(build.key, name)])),
      facts: facts(name),
      px144: Object.fromEntries(builds.map((build) => [build.key, px(build.key, name, "r")])),
      px150cap1600: Object.fromEntries(builds.map((build) => [build.key, px(build.key, name, "cap")])),
    };
    console.log([name, ...builds.map((build) => JSON.stringify(next[name].pdfinfo[build.key])), JSON.stringify(next[name].facts?.geometry ?? null)].join(" | "));
  }
  if (process.argv.includes("--write")) {
    const lines = Object.entries(next).map(([key, value]) => `  ${JSON.stringify(key)}: ${JSON.stringify(value)}`);
    writeFileSync(fixturePath, `{\n${lines.join(",\n")}\n}\n`);
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
