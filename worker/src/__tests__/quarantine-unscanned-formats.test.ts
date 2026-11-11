import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { fileFactsFromSniff, isSupportedFileType, sniffFileBytes } from "@docslurp/shared";
import { unsupportedSourceReason } from "../extractors/registry.js";

/**
 * Council re-check 2: the hostile-matrix cases ClamAV reports clean although they are encrypted
 * (clam-hostile-matrix.docker.test.ts). Each is a documented decision only because DocSlurp refuses the format before any
 * extractor reads it; these tests hold that, on the committed fixtures.
 */
const fixture = (name: string) => fileURLToPath(new URL(`../../testdata/clam-encrypted/${name}`, import.meta.url));
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

describe("encrypted formats ClamAV cannot read are refused before extraction", () => {
  it.each(["rar5-password.rar", "rar5-encrypted-headers.rar"])("%s: RAR is not an accepted upload type, and RAR bytes under an accepted type are a MIME mismatch (quarantine error)", (name) => {
    // The image's ClamAV has no RAR engine (libclamunrar is not installed): RAR content is never scanned.
    expect(isSupportedFileType("application/vnd.rar", name)).toBe(false);
    expect(isSupportedFileType("application/x-rar-compressed", name)).toBe(false);
    const bytes = readFileSync(fixture(name));
    for (const [filename, declared] of [["report.pdf", "application/pdf"], ["report.docx", DOCX], ["notes.txt", "text/plain"], ["photo.png", "image/png"]] as const) {
      const facts = fileFactsFromSniff(sniffFileBytes(bytes, filename), { filename, declaredMimeType: declared });
      // quarantine.ts refuses an "unresolved" mismatch as mime-mismatch (severity error), whatever the scan says.
      expect(facts.sniffedMimeType, `${name} as ${declared}`).toBe("application/vnd.rar");
      expect(facts.mismatch, `${name} as ${declared}`).toBe("unresolved");
    }
  });

  it.each([
    ["ooxml-encrypted.docx", "office-word", DOCX, "quarterly.docx"],
    ["ooxml-encrypted.xlsx", "office-excel", XLSX, "revenue.xlsx"],
  ] as const)("%s: a password-protected Office file (CFB EncryptedPackage) is refused by extraction", async (name, format, mimeType, filename) => {
    expect(await unsupportedSourceReason(fixture(name), { format, mimeType, filename })).toMatch(/encrypted or password-protected Office file/);
  });
});
