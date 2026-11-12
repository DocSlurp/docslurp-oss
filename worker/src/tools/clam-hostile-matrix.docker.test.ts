import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { fileFactsFromSniff, MIME_BY_EXTENSION, fileExtension } from "@docslurp/shared";

import { fromEnv } from "../config.js";
import { inspectQuarantineBytes, pdfHasEncryptName, type QuarantineInspection } from "../lib/quarantine-bytes.js";
import { clamdConfig } from "../sandbox/providers/modal/scanner.js";
import { clamscanLimitArgs, isClamEncryptedAlert, isClamLimitAlert } from "./clam-limits.js";
import { clamDetection, pdfDecryptArgv, pdfEncryptionCheckArgv, pdfRewriteOutputLimit, pdfShowEncryptionArgv, qpdfDecryptComplete, qpdfReportsNotEncrypted } from "./runner.js";

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
  { file: "pdf-owner-raw-marker-broken-xref.pdf", clamav: "clean", decision: "refused:pdf-encryption-inconsistent", note: "the same with a broken startxref: an encrypted PDF readers must reconstruct is refused before decryption (council N-H1)" },
  { file: "pdf-literal-encrypt-text.pdf", clamav: "unscannable", decision: "unscannable", note: "an unencrypted PDF showing the text /Encrypt in an uncompressed content stream: libclamav's own /Encrypt heuristic reports it encrypted (Heuristics.Encrypted.PDF), before qpdf runs" },
  { file: "pdf-literal-encrypt-comment.pdf", clamav: "clean", decision: "clean", note: "FIXED (correctness High): an unencrypted PDF with /Encrypt in a comment after its header. qpdf --show-encryption: not encrypted; the rewrite scans clean and the PDF is accepted" },
  { file: "pdf-literal-encrypt-string.pdf", clamav: "clean", decision: "clean", note: "FIXED (correctness High): /Encrypt only in an /Info string early in the body; as above" },
  { file: "pdf-literal-encrypt-stream.pdf", clamav: "clean", decision: "clean", note: "FIXED (correctness High): /Encrypt only in an uncompressed content stream early in the body; as above" },
  { file: "pdf-literal-encrypt-after-eof.pdf", clamav: "unscannable", decision: "unscannable", note: "the reviewer's reproducer shape (/Encrypt in a comment after %%EOF): libclamav's own trailer heuristic reports it encrypted, before qpdf runs" },
  { file: "pdf-incremental-drop-encrypt-marker.pdf", clamav: "marker", decision: "refused:pdf-encryption-inconsistent", note: "adversarial check 6 shape (RC4 base, an update dropping /Encrypt with a plaintext Flate marker): libclamav finds it; its trailers now disagree on /Encrypt, so it is refused before decryption (N-H1)" },
  { file: "pdf-owner-deep-nesting.pdf", clamav: "clean", decision: "refused:malware-scan-pdf-decrypt-failed", note: "FIXED (L2): qpdf drops 200,000 nested arrays (exit 3, not a benign warning): the copy is not the whole file, so refused" },
  { file: "prefixed-owner-raw-marker.pdf", clamav: "clean", decision: "refused:mime-mismatch+archive-embedded-container", note: "FIXED (H2): 1440 bytes of binary comments before %PDF-; ClamAV does not type it as a PDF; poppler and pdf.js read it" },
  { file: "prefixed-flate-marker.pdf", clamav: "clean", decision: "refused:mime-mismatch+archive-embedded-container", note: "FIXED (H2): the same prefix on a Flate marker PDF: ClamAV skips its PDF parsing entirely" },
  { file: "prefixed-zip64-marker.xlsx", clamav: "clean", decision: "refused:mime-mismatch+archive-embedded-container", note: "FIXED (H1): 16 NUL bytes before an XLSX whose parts are ZIP64; openpyxl reads it" },
  { file: "prefixed-traversal.docx", clamav: "clean", decision: "refused:mime-mismatch+archive-embedded-container", note: "FIXED (H1): the prefix used to skip archive-unsafe-path" },
  { file: "prefixed-marker.pptx", clamav: "marker", decision: "refused:mime-mismatch+archive-embedded-container", note: "FIXED (H1): PPTX behind the prefix (ClamAV finds the marker as an embedded ZIP here, but the walk never ran)" },
  { file: "prefixed-marker.epub", clamav: "marker", decision: "refused:mime-mismatch+archive-embedded-container", note: "FIXED (H1): EPUB behind the prefix" },
  { file: "prefixed-marker.odt", clamav: "marker", decision: "refused:mime-mismatch+archive-embedded-container", note: "FIXED (H1): ODT behind the prefix" },
  { file: "offset-zip64-member.zip", clamav: "clean", decision: "refused:archive-nested-embedded-container", note: "FIXED (M3): a ZIP64 EICAR ZIP 8 bytes into a member" },
  { file: "offset-rar-member.zip", clamav: "clean", decision: "refused:archive-nested-embedded-container", note: "FIXED (M3): an encrypted RAR 1 byte into a member" },
  { file: "pdf-zip-polyglot.pdf", clamav: "clean", decision: "refused:archive-embedded-container", note: "FIXED (M3): a PDF carrying a ZIP (ZIP64 EICAR inside) whose end record a ZIP reader finds" },
  { file: "hidden-local-entry.zip", clamav: "marker", decision: "refused:archive-hidden-entry", note: "FIXED (L4): a marker entry with a local header the central directory does not list (libclamav reads local headers and finds it; the walk now refuses it too)" },
  { file: "ole-shared-chain.zip", clamav: "clean", decision: "refused:archive-nested-ole-shared-sectors", note: "FIXED (M1): 2,000 OLE2 entries sharing one 64 MiB chain (0.5 MB upload); refused in milliseconds instead of an OOM" },
  { file: "printer-settings-cab.xlsx", clamav: "clean", decision: "clean", note: "control (correctness M3): a printer-settings blob with a CAB cabinet 1,258 bytes in, as real spreadsheets carry" },
  { file: "pdf-owner-only-restricted.pdf", clamav: "clean", decision: "clean", note: "control: an ordinary permissions-restricted PDF is decrypted, its copy scanned clean, and accepted" },
  { file: "pdf-incremental-encrypt.pdf", clamav: "unscannable", decision: "refused:pdf-encryption-inconsistent", note: "/Encrypt only in the incremental update's trailer: libclamav calls it encrypted; its trailers disagree on /Encrypt (N-H1)" },
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
  // Council round 5 (adversarial re-check 2).
  { file: "pdf-twokey-broken-xref.pdf", clamav: "clean", decision: "refused:pdf-encryption-inconsistent", note: "FIXED (N-H1): two encryption dictionaries under two trailers, startxref broken; qpdf decrypts with the last (garbage, only xref-recovery warnings), pdf.js with the first (the marker in page text and outline)" },
  { file: "pdf-twokey-three-trailers.pdf", clamav: "clean", decision: "refused:pdf-encryption-inconsistent", note: "FIXED (N-H1): trailers A, B, A" },
  { file: "pdf-twokey-prev-chain.pdf", clamav: "clean", decision: "refused:pdf-encryption-inconsistent", note: "FIXED (N-H1): a valid /Prev chain whose update switches to a second encryption dictionary" },
  { file: "pdf-twokey-objstm.pdf", clamav: "clean", decision: "refused:pdf-encryption-inconsistent", note: "FIXED (N-H1): key A in a cross-reference stream (object streams), key B under an appended trailer" },
  { file: "pdf-twokey-escaped-name.pdf", clamav: "clean", decision: "refused:pdf-encryption-inconsistent", note: "FIXED (N-H1): the second trailer spells /En#63rypt" },
  { file: "pdf-trailer-encrypt-first.pdf", clamav: "clean", decision: "refused:pdf-encryption-inconsistent", note: "FIXED (N-H1/N-L5): /Encrypt only on the first trailer (qpdf: not encrypted; pdf.js decrypts)" },
  { file: "pdf-literal-encrypt-flate-bomb.pdf", clamav: "clean", decision: "refused:malware-scan-pdf-decrypt-failed", note: "FIXED (N-L1): unencrypted, 200 MiB Flate zeros and a literal /Encrypt: the rewrite is capped at 64 MiB and refused" },
  { file: "nested-tar-zip64.xlsx", clamav: "clean", decision: "refused:archive-nested-zip64", note: "FIXED (N-M1): a ZIP64 marker ZIP in a tar in an XLSX embedding; the walk opens tar" },
  { file: "nested-bz2-zip64.xlsx", clamav: "clean", decision: "refused:archive-nested-unsupported-format", note: "FIXED (N-M1): the same in bzip2, which the walk cannot decode" },
  { file: "nested-xz-zip64.xlsx", clamav: "clean", decision: "refused:archive-nested-unsupported-format", note: "FIXED (N-M1): the same in xz" },
  { file: "nested-tar-bz2-zip64.xlsx", clamav: "clean", decision: "refused:archive-nested-unsupported-format", note: "FIXED (N-M1): tar in bzip2" },
  { file: "nested-tar-plain.xlsx", clamav: "clean", decision: "clean", note: "control: a benign tar embedding" },
  { file: "exempt-pdf-payload.mp3", clamav: "clean", decision: "refused:archive-embedded-container", note: "FIXED (N-L2): an owner-password marker PDF behind 1,440 NUL bytes as MP3" },
  { file: "exempt-pdf-payload.mov", clamav: "clean", decision: "refused:archive-embedded-container", note: "FIXED (N-L2): as QuickTime" },
  { file: "exempt-pdf-payload.aac", clamav: "clean", decision: "refused:archive-embedded-container", note: "FIXED (N-L2): as AAC" },
  { file: "exempt-id3-pdf.mp3", clamav: "clean", decision: "refused:archive-embedded-container", note: "FIXED (N-L2): behind an ID3 tag" },
  { file: "html-late-datauri-11m.html", clamav: "marker", decision: "marker", note: "FIXED (N-M2): a data: URI after 11 MiB of paragraphs; the image config used to keep Debian's 10M MaxHTMLNormalize and miss it" },
  { file: "html-early-datauri.html", clamav: "marker", decision: "marker", note: "control: the same URI near the start" },
  { file: "eicar.com", clamav: "infected", decision: "infected", note: "control" },
  { file: "plain.pdf", clamav: "clean", decision: "clean", note: "control" },
  { file: "marker-plain.pdf", clamav: "marker", decision: "marker", note: "control: the marker signature is loaded" },
];

const CONFIGS = ["vm", "image", "clamscan"] as const;
/** One scan or qpdf run: past ClamAV's MaxScanTime (300 s), so its own limit alert lands first. */
const CASE_TIMEOUT_S = Number(process.env.DOCSLURP_CLAMAV_MATRIX_CASE_TIMEOUT_S ?? 360);
/** The whole container: generous, but a hang fails the suite instead of stalling it. */
const MATRIX_TIMEOUT_MS = 45 * 60_000;

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
type QpdfRun = { check: number; shown: { exitCode: number; stdout: string; stderr: string } | null; decrypt: number | null; decryptStderr: string; bytes: number | null; limit: number };
type Inspected = { inspection: QuarantineInspection; mismatch: boolean; hostEncrypt: boolean } | "download-cap";

function decide(file: string, config: Config, inspected: Inspected, scans: Map<string, { verdict: Verdict }>, qpdf: Map<string, QpdfRun>): Decision {
  if (inspected === "download-cap") return "refused:download-cap";
  const { inspection } = inspected;
  // scanDocumentForQuarantine: a declared type the bytes cannot confirm (fileFactsFromSniff), the encryption-structure
  // conflict (council N-H1) and the archive issues.
  const refusals = [...(inspected.mismatch ? ["mime-mismatch"] : []), ...(inspection.pdf?.encryptConflict ? ["pdf-encryption-inconsistent"] : []), ...(inspection.archive?.issues ?? [])];
  if (refusals.length) return `refused:${refusals.join("+")}`;
  const original = scans.get(`${config} ${file}`)?.verdict;
  if (!original) throw new Error(`no verdict for ${config} ${file}`);
  // Only a clean PDF that names /Encrypt (the VM's check, or the host's literal search) goes to the decryption.
  if (original !== "clean" || !(inspection.pdf?.encryptName || inspected.hostEncrypt)) return original;
  const run = qpdf.get(file);
  if (!run) throw new Error(`no qpdf run for ${file}`);
  // runner.decryptPdfForScan: 0 needs a password; 3 decrypt; 2 only when --show-encryption says "not encrypted".
  if (run.check === 0) return "refused:malware-scan-encrypted-content";
  if (run.check !== 3 && !(run.check === 2 && run.shown && qpdfReportsNotEncrypted(run.shown))) return "refused:malware-scan-pdf-decrypt-failed";
  // Strict for an encrypted PDF (no xref reconstruction, N-H1); an unencrypted rewrite is capped (N-L1).
  if (run.decrypt === null || !qpdfDecryptComplete({ exitCode: run.decrypt, stderr: run.decryptStderr }, run.check === 3)) return "refused:malware-scan-pdf-decrypt-failed";
  if (run.check !== 3 && (run.bytes ?? Infinity) >= run.limit) return "refused:malware-scan-pdf-decrypt-failed";
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
  const qpdf = new Map<string, QpdfRun & { ms: number }>();
  const inspections = new Map<string, Inspected>();

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
      const bytes = readFileSync(file);
      const inspection = inspectQuarantineBytes(bytes, row.file, policy);
      const facts = fileFactsFromSniff(inspection.sniffed, { filename: row.file, declaredMimeType: MIME_BY_EXTENSION[fileExtension(row.file)] ?? null });
      const hostEncrypt = bytes.subarray(0, 5).toString("latin1") === "%PDF-" && (bytes.includes("/Encrypt") || pdfHasEncryptName(bytes) === true);
      inspections.set(row.file, { inspection, mismatch: facts.mismatch === "corrected" || facts.mismatch === "unresolved", hostEncrypt });
      if (inspection.pdf?.encryptName || hostEncrypt) toDecrypt.push(row.file);
    }

    // The scanner VM config, adapted only in paths and the daemon user (an unprivileged container).
    const vm = clamdConfig("/m/db").split("\n")
      .filter((line) => !line.startsWith("User "))
      .map((line) => line.replace(/^LocalSocket .*/, "LocalSocket /m/vm.sock").replace(/^TemporaryDirectory .*/, "TemporaryDirectory /m/tmp-vm"))
      .join("\n");
    writeFileSync(path.join(dir, "vm.conf"), vm);
    const now = "$(date +%s%N)";
    // Each scan is bounded (CASE_TIMEOUT_S, above ClamAV's own 300 s MaxScanTime, so a scan-time alert still arrives): a
    // stuck case is a loud `error:124/137` row, never a stalled matrix. The three configurations of one file run at once.
    const bound = `timeout -k 10 ${CASE_TIMEOUT_S}`;
    const scanAll = (label: string, file: string, target: string) => [
      `( s=${now}; ${bound} clamdscan --config-file=/m/vm.conf --fdpass --no-summary --infected ${target} > /m/out/vm${label}.${file} 2>&1; c=$?; echo "vm${label} ${file} $c $(( (${now} - s) / 1000000 ))" > /m/res/vm${label}.${file} ) &`,
      `( s=${now}; ${bound} clamdscan --config-file=/m/image.conf --fdpass --no-summary --infected ${target} > /m/out/image${label}.${file} 2>&1; c=$?; echo "image${label} ${file} $c $(( (${now} - s) / 1000000 ))" > /m/res/image${label}.${file} ) &`,
      `( s=${now}; ${bound} clamscan -d /m/db ${clamscanLimitArgs().join(" ")} --no-summary --infected ${target} > /m/out/clamscan${label}.${file} 2>&1; c=$?; echo "clamscan${label} ${file} $c $(( (${now} - s) / 1000000 ))" > /m/res/clamscan${label}.${file} ) &`,
      "wait",
    ];
    const script = [
      "set -u",
      "mkdir -p /m/db /m/tmp-vm /m/tmp-image /m/out /m/copy /m/res",
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
        `s=${now}; ${bound} ${shell(pdfEncryptionCheckArgv(`/m/work/${file}`))} > /m/out/check.${file} 2>&1; check=$?; decrypt=none; shown=none`,
        `if [ $check = 2 ]; then ${bound} ${shell(pdfShowEncryptionArgv(`/m/work/${file}`))} > /m/out/shown.${file} 2> /m/out/shown-err.${file}; shown=$?; fi`,
        // runner.decryptPdfForScan: the full output limit for an encrypted PDF, the capped rewrite (N-L1) otherwise.
        `if [ $check = 3 ]; then ${bound} ${shell(pdfDecryptArgv(`/m/work/${file}`, `/m/copy/${file}`))} > /m/out/decrypt.${file} 2>&1; decrypt=$?; elif grep -qx 'File is not encrypted' /m/out/shown.${file} 2>/dev/null; then ${bound} ${shell(pdfDecryptArgv(`/m/work/${file}`, `/m/copy/${file}`, pdfRewriteOutputLimit(statSync(path.join(work, file)).size)))} > /m/out/decrypt.${file} 2>&1; decrypt=$?; fi`,
        `echo "qpdf ${file} $check $shown $decrypt $(( (${now} - s) / 1000000 )) $(stat -c %s /m/copy/${file} 2>/dev/null || echo none)" > /m/res/qpdf.${file}`,
        `if [ -f /m/copy/${file} ]; then`,
        ...scanAll("-copy", file, `/m/copy/${file}`),
        "fi",
      ]),
      "cat /m/res/*",
    ].join("\n");
    const started = Date.now();
    // The script is a mounted file: inline as one `sh -c` argument it passes Linux's per-argument limit (MAX_ARG_STRLEN, 128 KiB).
    writeFileSync(path.join(dir, "matrix.sh"), script, { mode: 0o644 });
    const result = spawnSync("docker", ["run", "--rm", "--network", "none", "--user", `${process.getuid!()}:${process.getgid!()}`, "--cpus", "4", "--memory", "8g", "-v", `${dir}:/m`, "--entrypoint", "sh", image!, "/m/matrix.sh"], { encoding: "utf8", timeout: MATRIX_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 });
    console.log(`[matrix] container wall time ${Math.round((Date.now() - started) / 1000)} s`);
    if (result.status !== 0) throw new Error(`matrix container failed (${result.status}${result.error ? `, ${result.error.message}` : ""}): ${(result.stderr ?? "").slice(-2000)}`);
    for (const line of result.stdout.trim().split("\n")) {
      const parts = line.split(" ");
      if (parts[0] === "qpdf") {
        const [, file, check, shown, decrypt, ms, bytes] = parts;
        const read = (name: string) => { try { return readFileSync(path.join(dir, "out", `${name}.${file}`), "utf8"); } catch { return ""; } };
        qpdf.set(file!, {
          check: Number(check),
          shown: shown === "none" ? null : { exitCode: Number(shown), stdout: read("shown"), stderr: read("shown-err") },
          decrypt: decrypt === "none" ? null : Number(decrypt),
          decryptStderr: read("decrypt"),
          ms: Number(ms),
          bytes: bytes === "none" ? null : Number(bytes),
          limit: Number(check) === 3 ? Number.POSITIVE_INFINITY : pdfRewriteOutputLimit(statSync(path.join(work, file!)).size),
        });
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
  }, MATRIX_TIMEOUT_MS + 600_000);
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

  it("no hidden-marker case (owner-password raw stream, dropped /Encrypt, prefixed PDF or XLSX) is ever clean, on any config", () => {
    for (const config of CONFIGS) {
      for (const file of ["pdf-empty-user-owner-raw-marker.pdf", "pdf-owner-raw-marker-broken-xref.pdf", "pdf-incremental-drop-encrypt-marker.pdf", "prefixed-owner-raw-marker.pdf", "prefixed-flate-marker.pdf", "prefixed-zip64-marker.xlsx",
        "pdf-twokey-broken-xref.pdf", "pdf-twokey-three-trailers.pdf", "pdf-twokey-objstm.pdf", "pdf-twokey-escaped-name.pdf", "pdf-trailer-encrypt-first.pdf", "nested-tar-zip64.xlsx", "nested-bz2-zip64.xlsx", "nested-xz-zip64.xlsx", "nested-tar-bz2-zip64.xlsx", "exempt-pdf-payload.mp3", "exempt-id3-pdf.mp3", "html-late-datauri-11m.html"]) {
        expect(decide(file, config, inspections.get(file)!, scans, qpdf), `${config} ${file}`).not.toBe("clean");
      }
    }
  });
});
