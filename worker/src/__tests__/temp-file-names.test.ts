import { describe, expect, it } from "vitest";

import {
  trustedTempDownloadPattern,
  trustedTempFileExtensionForDocument,
} from "../lib/temp-file-names.js";

describe("trusted temp file names", () => {
  it("derives temp file extensions from trusted MIME metadata", () => {
    expect(
      trustedTempFileExtensionForDocument({
        mimeType: "application/pdf; charset=binary",
      }),
    ).toBe(".pdf");
    expect(
      trustedTempFileExtensionForDocument({
        mimeType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      }),
    ).toBe(".docx");
  });

  it("does not copy untrusted filename extensions into temp paths", () => {
    const pattern = trustedTempDownloadPattern("docslurp-source-", {
      mimeType: "application/pdf",
    });

    expect(pattern).toBe("docslurp-source-*.pdf");
    expect(pattern).not.toContain(".sh");
    expect(pattern).not.toContain("..");
  });

  it("omits the extension when MIME metadata is unknown", () => {
    expect(
      trustedTempDownloadPattern("docslurp-source-", {
        mimeType: "application/x-msdownload",
      }),
    ).toBe("docslurp-source-*");
  });
});

describe("every accepted format reaches its reader with its extension (validation N4)", () => {
  it("maps every FILE_FORMATS MIME type and alias to the format's extension", async () => {
    const { FILE_FORMATS } = await import("@docslurp/shared");
    for (const spec of FILE_FORMATS) {
      for (const mime of [spec.mimeType, ...(spec.aliases ?? [])]) {
        expect(spec.extensions, mime).toContain(trustedTempFileExtensionForDocument({ mimeType: mime }));
      }
    }
    expect(trustedTempFileExtensionForDocument({ mimeType: "application/vnd.oasis.opendocument.text" })).toBe(".odt");
  });

  it("an ODT runs pandoc's odt reader in the parser VM", async () => {
    const { pandocReader } = await import("../extractors/registry.js");
    const { CommandRunner } = await import("../tools/runner.js");
    const { setDefaultParserSandbox } = await import("../sandbox/startup.js");
    const source = `/tmp/${trustedTempDownloadPattern("docslurp-source-", { mimeType: "application/vnd.oasis.opendocument.text" }).replace("*", "abc")}`;
    const reader = pandocReader(source, { format: "office-other" } as never);
    expect(reader).toBe("odt");
    const remote = { filesystem: true, network: "full", processes: true, location: "remote" } as const;
    const commands: Array<{ binary: string; args: string[] }> = [];
    const session = {
      providerId: "modal", isolation: remote, filtersUnixSockets: true,
      run: async (command: { binary: string; args: string[] }) => { commands.push(command); return { exitCode: 0, stdout: "# Title\n", stderr: "", cpuSeconds: 0 }; },
      close: async () => {},
    };
    setDefaultParserSandbox({ provider: { id: "modal" } as never, config: {}, isolation: remote, tools: ["pandoc"] });
    try {
      const runner = new CommandRunner({ openSession: async () => session as never });
      const plan = await runner.extractMarkdown(source, reader);
      expect(plan.available).toBe(true);
      const result = await runner.run(plan);
      expect(result.stdout).toContain("# Title");
      expect(commands).toHaveLength(1);
      expect(commands[0]!.binary).toBe("pandoc");
      expect(commands[0]!.args).toEqual(expect.arrayContaining(["-f", "odt"]));
    } finally { setDefaultParserSandbox(undefined); }
  }, 60_000); // a cold import of the extractor registry and runner (council K #7)
});
