import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { clamdConfig } from "../sandbox/providers/modal/scanner.js";
import { clamscanLimitArgs, isClamEncryptedAlert, isClamLimitAlert } from "./clam-limits.js";
import { clamDetection } from "./runner.js";

/**
 * Council re-check 2: the hostile matrix, with real ClamAV, on all three scan configurations quarantine uses:
 *
 * - `vm`: the scanner VMs' generated clamd config (scanner.ts clamdConfig), through clamdscan --fdpass;
 * - `image`: the worker image's /etc/clamav/clamd.conf after worker/Dockerfile's edit (scripts/apply-clamd-policy.sh);
 * - `clamscan`: the per-command clamscan plan (clamscanLimitArgs).
 *
 * Opt-in (DOCSLURP_CLAMAV_DOCKER_IMAGE, the worker image), no network, the caller's uid. Fixtures come from
 * testdata/clam-encrypted (make_fixtures.py at run time; RAR, 7z, AES-ZIP and OOXML committed). The verdict table is
 * written to DOCSLURP_CLAMAV_MATRIX_OUT when set.
 */
const image = process.env.DOCSLURP_CLAMAV_DOCKER_IMAGE?.trim();
const fixtures = fileURLToPath(new URL("../../testdata/clam-encrypted/", import.meta.url));
const applyPolicy = fileURLToPath(new URL("../../scripts/apply-clamd-policy.sh", import.meta.url));

type Verdict = "unscannable" | "infected" | "marker" | "limit" | "clean" | `error:${number}`;

/**
 * Expected verdict per fixture, identical on every configuration. `clean` on an encrypted fixture is either a documented
 * decision proven by a test elsewhere (the format is refused before any extractor reads it) or, where the note says OPEN
 * FINDING, a recorded libclamav gap this table pins so a change in it is noticed.
 */
const MATRIX: Array<{ file: string; expected: Verdict; note: string }> = [
  { file: "rar5-password.rar", expected: "clean", note: "no RAR engine in Debian's ClamAV (libclamunrar is non-free): every RAR is unscanned. RAR is not an accepted upload format (rar-refused test)" },
  { file: "rar5-encrypted-headers.rar", expected: "clean", note: "as above" },
  { file: "7z-password.7z", expected: "unscannable", note: "Heuristics.Encrypted.7Zip" },
  { file: "7z-encrypted-headers.7z", expected: "unscannable", note: "Heuristics.Encrypted.7Zip" },
  { file: "zip-aes256.zip", expected: "unscannable", note: "WinZip AES" },
  { file: "ooxml-encrypted.docx", expected: "clean", note: "CFB EncryptedPackage: ClamAV has no alert for it. Extraction refuses every OLE Office file (unsupportedSourceReason test)" },
  { file: "ooxml-encrypted.xlsx", expected: "clean", note: "as above" },
  { file: "pdf-user-password.pdf", expected: "unscannable", note: "Heuristics.Encrypted.PDF" },
  { file: "pdf-empty-user-owner-flate-marker.pdf", expected: "marker", note: "empty user password, Flate streams: decrypted and scanned (the marker inside is found)" },
  { file: "pdf-empty-user-owner-raw-marker.pdf", expected: "clean", note: "OPEN FINDING: empty user password, unfiltered stream: libclamav 1.4.3 decrypts it, discards the result and scans the ciphertext, so the marker is missed. Not fixable by configuration; see the PR" },
  { file: "pdf-incremental-encrypt.pdf", expected: "unscannable", note: "/Encrypt only in the incremental update's trailer" },
  { file: "pdf-objstm-user-password.pdf", expected: "unscannable", note: "objects in object streams" },
  { file: "pdf-objstm-owner-only-flate-marker.pdf", expected: "marker", note: "object streams, empty user password, Flate: decrypted and scanned" },
  { file: "zip-password.zip", expected: "unscannable", note: "ZipCrypto" },
  { file: "zip-mixed-plain-first.zip", expected: "unscannable", note: "one plain, one encrypted entry" },
  { file: "zip-mixed-encrypted-first.zip", expected: "unscannable", note: "one encrypted, one plain entry" },
  { file: "zip-flag-stored-both.zip", expected: "unscannable", note: "encryption flag on a stored plain EICAR entry, local and central" },
  { file: "zip-flag-stored-local-only.zip", expected: "unscannable", note: "flag in the local header only" },
  { file: "zip-flag-stored-central-only.zip", expected: "infected", note: "flag in the central directory only: ClamAV reads the local header and finds the plain EICAR (refused either way; intake inspection also refuses the flag as archive-encrypted-entry)" },
  { file: "nested-3-encrypted.zip", expected: "unscannable", note: "password ZIP inside three plain ZIPs" },
  { file: "nested-3-eicar.zip", expected: "infected", note: "EICAR inside three plain ZIPs" },
  { file: "zip64-member-eicar.zip", expected: "clean", note: "OPEN FINDING (libclamav): a ZIP64 local header is not followed and the member is skipped. Top level, quarantine's archive inspection refuses it (zip64-refused test)" },
  { file: "nested-zip64-eicar.zip", expected: "clean", note: "OPEN FINDING: the same ZIP64 member nested in a plain ZIP; inspection reads only the top level. Extractors never open nested archives" },
  { file: "limit-max-recursion.zip", expected: "limit", note: "20 levels > MaxRecursion 17" },
  { file: "limit-max-filesize-member.zip", expected: "clean", note: "OPEN FINDING (libclamav): a member over MaxFileSize is truncated to 1024 MiB and only that is scanned, with no alert (\"trimming output size to maxfilesize\"). Top level, the 128 MiB entry limit refuses it (entry-size test); nested, it is a gap" },
  { file: "limit-max-filesize-raw.bin", expected: "limit", note: "1100 MiB file > MaxFileSize 1024M" },
  { file: "limit-max-scansize.zip", expected: "limit", note: "2400 MiB > MaxScanSize 2000M" },
  { file: "eicar.com", expected: "infected", note: "control" },
  { file: "plain.pdf", expected: "clean", note: "control" },
  { file: "marker-plain.pdf", expected: "marker", note: "control: the marker signature is loaded" },
];

const CONFIGS = ["vm", "image", "clamscan"] as const;

function verdictOf(code: number, output: string): Verdict {
  if (code === 0) return "clean";
  if (code !== 1) return `error:${code}`;
  const detection = clamDetection(output, "");
  if (detection.status === "unscannable") return "unscannable";
  if (isClamEncryptedAlert(detection.signature)) return "unscannable";
  if (isClamLimitAlert(detection.signature)) return "limit";
  if (detection.signature?.startsWith("Docslurp.Test.MatrixMarker")) return "marker";
  return "infected";
}

describe.skipIf(!image)("real ClamAV hostile matrix (council re-check 2)", () => {
  let dir: string;
  const results = new Map<string, { verdict: Verdict; signature: string }>();

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "docslurp-clam-matrix-"));
    const work = path.join(dir, "work");
    mkdirSync(work);
    for (const name of readdirSync(fixtures)) if (!name.endsWith(".py")) copyFileSync(path.join(fixtures, name), path.join(work, name));
    const source = fileURLToPath(new URL("../../testdata/pdf-fixtures/academic-latex-ligatures.pdf", import.meta.url));
    execFileSync("python3", ["-I", path.join(fixtures, "make_fixtures.py"), work, source], { stdio: "ignore", timeout: 300_000 });
    copyFileSync(applyPolicy, path.join(dir, "apply-clamd-policy.sh"));

    // The scanner VM config, adapted only in paths and the daemon user (an unprivileged container).
    const vm = clamdConfig("/m/db").split("\n")
      .filter((line) => !line.startsWith("User "))
      .map((line) => line.replace(/^LocalSocket .*/, "LocalSocket /m/vm.sock").replace(/^TemporaryDirectory .*/, "TemporaryDirectory /m/tmp-vm"))
      .join("\n");
    writeFileSync(path.join(dir, "vm.conf"), vm);
    const files = MATRIX.map((row) => row.file);
    const script = [
      "set -u",
      "mkdir -p /m/db /m/tmp-vm /m/tmp-image /m/out",
      // Official signatures plus the matrix marker, in one database directory for both daemons.
      "for f in /var/lib/clamav/*.cvd /var/lib/clamav/*.cld; do [ -e \"$f\" ] && ln -s \"$f\" /m/db/; done",
      "cp /m/work/marker.ndb /m/db/",
      // The worker image's config, edited as worker/Dockerfile does, then adapted to the test container.
      "cp /etc/clamav/clamd.conf /m/image.conf",
      "sh /m/apply-clamd-policy.sh /m/image.conf",
      "sed -ri '/^#?(User|LocalSocket|LocalSocketGroup|PidFile|TemporaryDirectory|LogFile|Foreground|DatabaseDirectory)[[:space:]]/d' /m/image.conf",
      "printf 'LocalSocket /m/image.sock\\nTemporaryDirectory /m/tmp-image\\nDatabaseDirectory /m/db\\nForeground no\\n' >> /m/image.conf",
      "clamd --config-file=/m/vm.conf || exit 9",
      "clamd --config-file=/m/image.conf || exit 9",
      `for f in ${files.join(" ")}; do`,
      "  clamdscan --config-file=/m/vm.conf --fdpass --no-summary --infected /m/work/$f > /m/out/vm.$f 2>&1; echo \"vm $f $?\"",
      "  clamdscan --config-file=/m/image.conf --fdpass --no-summary --infected /m/work/$f > /m/out/image.$f 2>&1; echo \"image $f $?\"",
      `  clamscan -d /m/db ${clamscanLimitArgs().join(" ")} --no-summary --infected /m/work/$f > /m/out/clamscan.$f 2>&1; echo "clamscan $f $?"`,
      "done",
    ].join("\n");
    const result = spawnSync("docker", ["run", "--rm", "--network", "none", "--user", `${process.getuid!()}:${process.getgid!()}`, "--cpus", "2", "--memory", "6g", "-v", `${dir}:/m`, "--entrypoint", "sh", image!, "-c", script], { encoding: "utf8", timeout: 3_000_000 });
    if (result.status !== 0) throw new Error(`matrix container failed (${result.status}): ${result.stderr.slice(-2000)}`);
    for (const line of result.stdout.trim().split("\n")) {
      const [config, file, code] = line.split(" ");
      const output = readFileSync(path.join(dir, "out", `${config}.${file}`), "utf8");
      results.set(`${config} ${file}`, { verdict: verdictOf(Number(code), output), signature: output.match(/:\s+(.+?)\s+FOUND$/m)?.[1] ?? (Number(code) === 0 ? "OK" : output.trim().split("\n").at(-1) ?? "") });
    }
    const table = [
      "| Case | Expected | VM clamd | Image clamd | clamscan | Note |",
      "| --- | --- | --- | --- | --- | --- |",
      ...MATRIX.map((row) => `| \`${row.file}\` | ${row.expected} | ${CONFIGS.map((config) => { const r = results.get(`${config} ${row.file}`); return r ? `${r.verdict} (${r.signature})` : "missing"; }).join(" | ")} | ${row.note} |`),
    ].join("\n");
    if (process.env.DOCSLURP_CLAMAV_MATRIX_OUT) writeFileSync(process.env.DOCSLURP_CLAMAV_MATRIX_OUT, `${table}\n`);
    console.log(table);
  }, 3_000_000);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  for (const config of CONFIGS) {
    it(`${config}: every case gets its expected verdict; no encrypted or over-limit case is clean unless refused elsewhere`, () => {
      const lines = MATRIX.map((row) => `${row.file} ${results.get(`${config} ${row.file}`)?.verdict ?? "missing"}`);
      expect(lines).toEqual(MATRIX.map((row) => `${row.file} ${row.expected}`));
    });
  }
});
