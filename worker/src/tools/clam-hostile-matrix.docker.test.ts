import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { fromEnv } from "../config.js";
import { inspectQuarantineBytes, type QuarantineInspection } from "../lib/quarantine-bytes.js";
import { clamdConfig } from "../sandbox/providers/modal/scanner.js";
import { clamscanLimitArgs, isClamEncryptedAlert, isClamLimitAlert } from "./clam-limits.js";
import { clamDetection, pdfDecryptArgv, pdfEncryptionCheckArgv } from "./runner.js";

/**
 * Council re-check 2: the hostile matrix, with real ClamAV, on all three scan configurations quarantine uses:
 *
 * - `vm`: the scanner VMs' generated clamd config (scanner.ts clamdConfig), through clamdscan --fdpass;
 * - `image`: the worker image's /etc/clamav/clamd.conf after worker/Dockerfile's edit (scripts/apply-clamd-policy.sh);
 * - `clamscan`: the per-command clamscan plan (clamscanLimitArgs).
 *
 * On top of the raw verdicts, each row's quarantine decision: the in-VM inspection (nested-archive walk, /Encrypt check)
 * and, for a PDF with an empty user password, the in-VM qpdf decryption with the runner's own argv and the copy scanned on
 * the same configuration. The image must carry qpdf (worker/Dockerfile.lean pins it).
 *
 * Opt-in (DOCSLURP_CLAMAV_DOCKER_IMAGE, the worker image), no network, the caller's uid. Fixtures come from
 * testdata/clam-encrypted (make_fixtures.py at run time; RAR, 7z, AES-ZIP and OOXML committed). The verdict table is
 * written to DOCSLURP_CLAMAV_MATRIX_OUT when set.
 */
const image = process.env.DOCSLURP_CLAMAV_DOCKER_IMAGE?.trim();
const fixtures = fileURLToPath(new URL("../../testdata/clam-encrypted/", import.meta.url));
const applyPolicy = fileURLToPath(new URL("../../scripts/apply-clamd-policy.sh", import.meta.url));

type Verdict = "unscannable" | "infected" | "marker" | "limit" | "clean" | `error:${number}`;
/** Quarantine's decision: a refusal by reason code, or the verdict of the scans (original, and the decrypted copy). */
type Decision = Verdict | `refused:${string}`;

/**
 * Per fixture: `clamav`, the raw ClamAV verdict of the original on every configuration (pins libclamav's behaviour, gaps
 * included), and `decision`, what quarantine makes of the file with the in-VM inspection (archive-nesting.ts, the /Encrypt
 * check) and the in-VM decryption of an empty-user-password PDF (runner pdfEncryptionCheckArgv / pdfDecryptArgv) added.
 * Owner decision (PR #339): no encrypted, nested-gap or over-limit case may have the decision `clean`, and every control
 * must. RAR and encrypted OOXML at the top level are refused by type elsewhere (rar-refused, unsupportedSourceReason).
 */
const MATRIX: Array<{ file: string; clamav: Verdict; decision: Decision; note: string }> = [
  { file: "rar5-password.rar", clamav: "clean", decision: "clean", note: "no RAR engine in Debian's ClamAV (libclamunrar is non-free). Top level, RAR bytes are refused by sniff under any declared type (rar-refused test)" },
  { file: "rar5-encrypted-headers.rar", clamav: "clean", decision: "clean", note: "as above" },
  { file: "7z-password.7z", clamav: "unscannable", decision: "unscannable", note: "Heuristics.Encrypted.7Zip" },
  { file: "7z-encrypted-headers.7z", clamav: "unscannable", decision: "unscannable", note: "Heuristics.Encrypted.7Zip" },
  { file: "zip-aes256.zip", clamav: "unscannable", decision: "refused:archive-encrypted-entry", note: "WinZip AES" },
  { file: "ooxml-encrypted.docx", clamav: "clean", decision: "clean", note: "CFB EncryptedPackage: ClamAV has no alert for it. Extraction refuses every OLE Office file (unsupportedSourceReason test)" },
  { file: "ooxml-encrypted.xlsx", clamav: "clean", decision: "clean", note: "as above" },
  { file: "pdf-user-password.pdf", clamav: "unscannable", decision: "unscannable", note: "Heuristics.Encrypted.PDF" },
  { file: "pdf-empty-user-owner-flate-marker.pdf", clamav: "marker", decision: "marker", note: "empty user password, Flate streams: libclamav decrypts and scans them" },
  { file: "pdf-empty-user-owner-raw-marker.pdf", clamav: "clean", decision: "marker", note: "FIXED: libclamav scans the unfiltered stream's ciphertext (clean); the in-VM qpdf copy is scanned and the marker found" },
  { file: "pdf-owner-raw-marker-broken-xref.pdf", clamav: "clean", decision: "marker", note: "the same with a broken startxref: qpdf reconstructs the xref, decrypts, and the copy's marker is found" },
  { file: "pdf-literal-encrypt-text.pdf", clamav: "clean", decision: "refused:malware-scan-pdf-decrypt-failed", note: "fail-closed cost: an unencrypted PDF showing the text /Encrypt; qpdf says not encrypted, which the check cannot settle" },
  { file: "pdf-owner-only-restricted.pdf", clamav: "clean", decision: "clean", note: "control: an ordinary permissions-restricted PDF is decrypted, its copy scanned clean, and accepted" },
  { file: "pdf-incremental-encrypt.pdf", clamav: "unscannable", decision: "unscannable", note: "/Encrypt only in the incremental update's trailer" },
  { file: "pdf-objstm-user-password.pdf", clamav: "unscannable", decision: "unscannable", note: "objects in object streams" },
  { file: "pdf-objstm-owner-only-flate-marker.pdf", clamav: "marker", decision: "marker", note: "object streams, empty user password, Flate: decrypted and scanned" },
  { file: "perf-owner-text-300p.pdf", clamav: "clean", decision: "clean", note: "timing: 300 text pages, owner password" },
  { file: "perf-owner-images-40p.pdf", clamav: "clean", decision: "clean", note: "timing: 40 pages with a Flate image each (124 MB), owner password" },
  { file: "zip-password.zip", clamav: "unscannable", decision: "refused:archive-encrypted-entry", note: "ZipCrypto" },
  { file: "zip-mixed-plain-first.zip", clamav: "unscannable", decision: "refused:archive-encrypted-entry", note: "one plain, one encrypted entry" },
  { file: "zip-mixed-encrypted-first.zip", clamav: "unscannable", decision: "refused:archive-encrypted-entry", note: "one encrypted, one plain entry" },
  { file: "zip-flag-stored-both.zip", clamav: "unscannable", decision: "refused:archive-encrypted-entry", note: "encryption flag on a stored plain EICAR entry, local and central" },
  { file: "zip-flag-stored-local-only.zip", clamav: "unscannable", decision: "refused:archive-inspection-failed", note: "flag in the local header only (headers disagree)" },
  { file: "zip-flag-stored-central-only.zip", clamav: "infected", decision: "refused:archive-inspection-failed", note: "flag in the central directory only: ClamAV reads the local header and finds the plain EICAR" },
  { file: "nested-3-encrypted.zip", clamav: "unscannable", decision: "refused:archive-nested-encrypted-entry", note: "password ZIP inside three plain ZIPs" },
  { file: "nested-3-eicar.zip", clamav: "infected", decision: "infected", note: "EICAR inside three plain ZIPs" },
  { file: "zip64-member-eicar.zip", clamav: "clean", decision: "refused:archive-inspection-failed", note: "libclamav skips a ZIP64 member; the top-level inspection refuses ZIP64" },
  { file: "nested-zip64-eicar.zip", clamav: "clean", decision: "refused:archive-nested-zip64", note: "FIXED: the same ZIP64 member nested in a plain ZIP; the in-VM walk refuses it" },
  { file: "nested-rar.zip", clamav: "clean", decision: "refused:archive-nested-unsupported-format", note: "FIXED: a RAR nested in a plain ZIP (no RAR engine); the in-VM walk refuses it" },
  { file: "nested-oversized-member.zip", clamav: "clean", decision: "refused:archive-nested-entry-size-limit", note: "FIXED: a 1100 MiB member nested in a plain ZIP; libclamav truncates it to MaxFileSize with no alert" },
  { file: "zip-plain.zip", clamav: "clean", decision: "clean", note: "control: an ordinary ZIP" },
  { file: "limit-max-recursion.zip", clamav: "limit", decision: "refused:archive-nested-depth-limit", note: "20 levels > MaxRecursion 17" },
  { file: "limit-max-filesize-member.zip", clamav: "clean", decision: "refused:archive-expanded-bytes-limit+archive-entry-size-limit+archive-expansion-ratio-limit", note: "libclamav truncates a member over MaxFileSize to 1024 MiB with no alert; the top-level limits refuse it" },
  { file: "limit-max-filesize-raw.bin", clamav: "limit", decision: "refused:download-cap", note: "1100 MiB file > MaxFileSize 1024M; quarantine never downloads past 512 MiB" },
  { file: "limit-max-scansize.zip", clamav: "limit", decision: "refused:archive-expanded-bytes-limit+archive-entry-size-limit+archive-expansion-ratio-limit", note: "2400 MiB > MaxScanSize 2000M" },
  { file: "eicar.com", clamav: "infected", decision: "infected", note: "control" },
  { file: "plain.pdf", clamav: "clean", decision: "clean", note: "control" },
  { file: "marker-plain.pdf", clamav: "marker", decision: "marker", note: "control: the marker signature is loaded" },
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

/** The scan verdict quarantine acts on for one configuration (copy: the decrypted copy's). */
function decide(file: string, config: Config, inspection: QuarantineInspection | "download-cap", scans: Map<string, { verdict: Verdict }>, qpdf: Map<string, { check: number; decrypt: number | null }>): Decision {
  if (inspection === "download-cap") return "refused:download-cap";
  const issues = inspection.archive?.issues ?? [];
  if (issues.length) return `refused:${issues.join("+")}`;
  const original = scans.get(`${config} ${file}`)?.verdict;
  if (!original) throw new Error(`no verdict for ${config} ${file}`);
  // scanDocumentForQuarantine: only a clean PDF that names /Encrypt goes to the decryption.
  if (original !== "clean" || !inspection.pdf?.encryptName) return original;
  const run = qpdf.get(file);
  if (!run) throw new Error(`no qpdf run for ${file}`);
  if (run.check === 0) return "refused:malware-scan-encrypted-content";
  if (run.check !== 3 || (run.decrypt !== 0 && run.decrypt !== 3)) return "refused:malware-scan-pdf-decrypt-failed";
  const copy = scans.get(`${config}-copy ${file}`)?.verdict;
  if (!copy) return "refused:malware-scan-pdf-decrypt-failed";
  return copy;
}

type Config = (typeof CONFIGS)[number];
const DOWNLOAD_CAP = 512 * 1024 * 1024;
const shell = (argv: string[]) => argv.map((arg) => `'${arg.replace(/'/g, "'\\''")}'`).join(" ");

describe.skipIf(!image)("real ClamAV hostile matrix (council re-check 2; owner decision, PR #339)", () => {
  let dir: string;
  const scans = new Map<string, { verdict: Verdict; signature: string; ms: number }>();
  const qpdf = new Map<string, { check: number; decrypt: number | null; ms: number; bytes: number | null }>();
  const inspections = new Map<string, QuarantineInspection | "download-cap">();

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "docslurp-clam-matrix-"));
    const work = path.join(dir, "work");
    mkdirSync(work);
    for (const name of readdirSync(fixtures)) if (!name.endsWith(".py")) copyFileSync(path.join(fixtures, name), path.join(work, name));
    const source = fileURLToPath(new URL("../../testdata/pdf-fixtures/academic-latex-ligatures.pdf", import.meta.url));
    execFileSync("python3", ["-I", path.join(fixtures, "make_fixtures.py"), work, source], { stdio: "ignore", timeout: 600_000 });
    copyFileSync(applyPolicy, path.join(dir, "apply-clamd-policy.sh"));

    // Quarantine's own inspection with the worker's default limits (in the parser VM in production; the same code here).
    const config = fromEnv();
    const policy = {
      quarantineFailOpenOnToolMissing: false,
      quarantineMaxArchiveEntries: config.quarantineMaxArchiveEntries,
      quarantineMaxArchiveDepth: config.quarantineMaxArchiveDepth,
      quarantineMaxTotalUncompressedBytes: config.quarantineMaxTotalUncompressedBytes,
      quarantineMaxSingleEntryBytes: config.quarantineMaxSingleEntryBytes,
      quarantineMaxExpansionRatio: config.quarantineMaxExpansionRatio,
    };
    const toDecrypt: string[] = [];
    for (const row of MATRIX) {
      const file = path.join(work, row.file);
      if (statSync(file).size > DOWNLOAD_CAP) {
        inspections.set(row.file, "download-cap");
        continue;
      }
      const inspection = inspectQuarantineBytes(readFileSync(file), row.file, policy);
      inspections.set(row.file, inspection);
      if (inspection.pdf?.encryptName) toDecrypt.push(row.file);
    }

    // The scanner VM config, adapted only in paths and the daemon user (an unprivileged container).
    const vm = clamdConfig("/m/db").split("\n")
      .filter((line) => !line.startsWith("User "))
      .map((line) => line.replace(/^LocalSocket .*/, "LocalSocket /m/vm.sock").replace(/^TemporaryDirectory .*/, "TemporaryDirectory /m/tmp-vm"))
      .join("\n");
    writeFileSync(path.join(dir, "vm.conf"), vm);
    const now = "$(date +%s%N)";
    const scanAll = (label: string, file: string, target: string) => [
      `s=${now}; clamdscan --config-file=/m/vm.conf --fdpass --no-summary --infected ${target} > /m/out/vm${label}.${file} 2>&1; c=$?; echo "vm${label} ${file} $c $(( (${now} - s) / 1000000 ))"`,
      `s=${now}; clamdscan --config-file=/m/image.conf --fdpass --no-summary --infected ${target} > /m/out/image${label}.${file} 2>&1; c=$?; echo "image${label} ${file} $c $(( (${now} - s) / 1000000 ))"`,
      `s=${now}; clamscan -d /m/db ${clamscanLimitArgs().join(" ")} --no-summary --infected ${target} > /m/out/clamscan${label}.${file} 2>&1; c=$?; echo "clamscan${label} ${file} $c $(( (${now} - s) / 1000000 ))"`,
    ];
    const script = [
      "set -u",
      "mkdir -p /m/db /m/tmp-vm /m/tmp-image /m/out /m/copy",
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
      "qpdf --version | head -1 >&2",
      ...MATRIX.flatMap((row) => scanAll("", row.file, `/m/work/${row.file}`)),
      // The in-VM decryption, with the runner's exact argv (prlimit bounds included), then each copy scanned on every config.
      ...toDecrypt.flatMap((file) => [
        `s=${now}; ${shell(pdfEncryptionCheckArgv(`/m/work/${file}`))} > /m/out/check.${file} 2>&1; check=$?; decrypt=none`,
        `if [ $check = 3 ]; then ${shell(pdfDecryptArgv(`/m/work/${file}`, `/m/copy/${file}`))} > /m/out/decrypt.${file} 2>&1; decrypt=$?; fi`,
        `echo "qpdf ${file} $check $decrypt $(( (${now} - s) / 1000000 )) $(stat -c %s /m/copy/${file} 2>/dev/null || echo none)"`,
        `if [ -f /m/copy/${file} ]; then`,
        ...scanAll("-copy", file, `/m/copy/${file}`),
        "fi",
      ]),
    ].join("\n");
    const result = spawnSync("docker", ["run", "--rm", "--network", "none", "--user", `${process.getuid!()}:${process.getgid!()}`, "--cpus", "2", "--memory", "6g", "-v", `${dir}:/m`, "--entrypoint", "sh", image!, "-c", script], { encoding: "utf8", timeout: 3_000_000 });
    if (result.status !== 0) throw new Error(`matrix container failed (${result.status}): ${result.stderr.slice(-2000)}`);
    for (const line of result.stdout.trim().split("\n")) {
      const parts = line.split(" ");
      if (parts[0] === "qpdf") {
        const [, file, check, decrypt, ms, bytes] = parts;
        qpdf.set(file!, { check: Number(check), decrypt: decrypt === "none" ? null : Number(decrypt), ms: Number(ms), bytes: bytes === "none" ? null : Number(bytes) });
        continue;
      }
      const [config, file, code, ms] = parts;
      const output = readFileSync(path.join(dir, "out", `${config}.${file}`), "utf8");
      scans.set(`${config} ${file}`, { verdict: verdictOf(Number(code), output), signature: output.match(/:\s+(.+?)\s+FOUND$/m)?.[1] ?? (Number(code) === 0 ? "OK" : output.trim().split("\n").at(-1) ?? ""), ms: Number(ms) });
    }
    const cell = (config: Config, file: string) => {
      const scan = scans.get(`${config} ${file}`);
      return scan ? `${scan.verdict} (${scan.signature})` : "missing";
    };
    const decisionCell = (config: Config, row: (typeof MATRIX)[number]) => decide(row.file, config, inspections.get(row.file)!, scans, qpdf);
    const table = [
      "| Case | ClamAV expected | VM clamd | Image clamd | clamscan | Decision expected | Decision VM / Image / clamscan | Note |",
      "| --- | --- | --- | --- | --- | --- | --- | --- |",
      ...MATRIX.map((row) => `| \`${row.file}\` | ${row.clamav} | ${CONFIGS.map((config) => cell(config, row.file)).join(" | ")} | ${row.decision} | ${CONFIGS.map((config) => decisionCell(config, row)).join(" / ")} | ${row.note} |`),
    ].join("\n");
    const timing = [
      "| Owner-password PDF | Size | Original scan (VM clamd) | qpdf check + decrypt | Copy size | Copy scan (VM clamd) | Added | Added (clamscan path) |",
      "| --- | --- | --- | --- | --- | --- | --- | --- |",
      ...toDecrypt.filter((file) => qpdf.get(file)?.bytes).map((file) => {
        const run = qpdf.get(file)!;
        const original = scans.get(`vm ${file}`)!.ms;
        const copy = scans.get(`vm-copy ${file}`)?.ms ?? NaN;
        const copyClamscan = scans.get(`clamscan-copy ${file}`)?.ms ?? NaN;
        return `| \`${file}\` | ${statSync(path.join(work, file)).size} B | ${original} ms | ${run.ms} ms | ${run.bytes} B | ${copy} ms | ${run.ms + copy} ms | ${run.ms + copyClamscan} ms |`;
      }),
    ].join("\n");
    if (process.env.DOCSLURP_CLAMAV_MATRIX_OUT) writeFileSync(process.env.DOCSLURP_CLAMAV_MATRIX_OUT, `${table}\n\n${timing}\n`);
    console.log(`${table}\n\n${timing}`);
  }, 3_000_000);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  for (const config of CONFIGS) {
    it(`${config}: ClamAV gives every case its pinned verdict (libclamav's gaps included)`, () => {
      const lines = MATRIX.map((row) => `${row.file} ${scans.get(`${config} ${row.file}`)?.verdict ?? "missing"}`);
      expect(lines).toEqual(MATRIX.map((row) => `${row.file} ${row.clamav}`));
    });

    it(`${config}: quarantine refuses every hostile case and accepts every control (owner decision, PR #339)`, () => {
      const lines = MATRIX.map((row) => `${row.file} ${decide(row.file, config, inspections.get(row.file)!, scans, qpdf)}`);
      expect(lines).toEqual(MATRIX.map((row) => `${row.file} ${row.decision}`));
    });
  }

  it("the owner-password PDF with a hidden marker in an unfiltered stream is never clean, on any config", () => {
    for (const config of CONFIGS) {
      for (const file of ["pdf-empty-user-owner-raw-marker.pdf", "pdf-owner-raw-marker-broken-xref.pdf"]) {
        expect(decide(file, config, inspections.get(file)!, scans, qpdf), `${config} ${file}`).not.toBe("clean");
      }
    }
  });
});
