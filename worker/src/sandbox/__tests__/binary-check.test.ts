import { describe, expect, it, vi } from "vitest";

import { checkParserBinaries, PARSER_BINARY_CHECKS } from "../binary-check.js";
import type { SandboxCommand, SandboxResult, SandboxSession } from "../types.js";

function fakeSession(
  location: "local" | "remote",
  run: (command: SandboxCommand) => Promise<SandboxResult>,
): SandboxSession & { close: ReturnType<typeof vi.fn> } {
  return {
    providerId: "fake",
    isolation: { filesystem: true, network: "full", processes: true, location },
    run,
    close: vi.fn(async () => {}),
  };
}

const buildCommand = (binary: string, args: string[]): SandboxCommand => ({
  binary,
  args,
  env: {},
  readablePaths: [binary],
  inputPaths: [],
  writablePaths: [],
  limits: { timeoutMs: 1000 },
});
const resolveAll = (name: string) => `/usr/bin/${name}`;
const ok: SandboxResult = { exitCode: 0, stdout: "", stderr: "" };

describe("checkParserBinaries", () => {
  it("checks the four parser binaries with their version flags", async () => {
    const seen: string[] = [];
    const session = fakeSession("local", async (command) => {
      seen.push(`${command.binary} ${command.args.join(" ")}`);
      return ok;
    });
    const result = await checkParserBinaries({ session, resolveBinary: resolveAll, buildCommand });
    expect(result).toEqual({ failures: [], skipped: [] });
    expect(seen).toEqual([
      "/usr/bin/ffprobe -version",
      "/usr/bin/ffmpeg -version",
      "/usr/bin/pdftoppm -v",
      "/usr/bin/pandoc --version",
    ]);
    expect(PARSER_BINARY_CHECKS).toHaveLength(4);
    expect(session.close).toHaveBeenCalledOnce();
  });

  it("reports a non-zero exit in the main-branch message format", async () => {
    const session = fakeSession("local", async (command) =>
      command.binary.endsWith("ffmpeg")
        ? { exitCode: 127, stdout: "", stderr: "ffmpeg: error while loading shared libraries: libblas.so.3\nmore" }
        : ok,
    );
    const result = await checkParserBinaries({ session, resolveBinary: resolveAll, buildCommand });
    expect(result.failures).toEqual([
      "ffmpeg fails inside the parser sandbox (exit 127): ffmpeg: error while loading shared libraries: libblas.so.3",
    ]);
  });

  it("skips binaries that are not installed", async () => {
    const run = vi.fn(async () => ok);
    const session = fakeSession("local", run);
    const result = await checkParserBinaries({
      session,
      resolveBinary: (name) => (name === "pandoc" ? "/usr/bin/pandoc" : undefined),
      buildCommand,
    });
    expect(result.skipped).toEqual(["ffprobe", "ffmpeg", "pdftoppm"]);
    expect(run).toHaveBeenCalledOnce();
  });

  it("turns a thrown run into a failure and still closes the session", async () => {
    const session = fakeSession("local", async () => {
      throw new Error("spawn exploded");
    });
    const result = await checkParserBinaries({ session, resolveBinary: resolveAll, buildCommand });
    expect(result.failures[0]).toBe("ffprobe fails inside the parser sandbox (exit null): spawn exploded");
    expect(session.close).toHaveBeenCalledOnce();
  });

  it("closes the session when building a command throws", async () => {
    const session = fakeSession("local", async () => ok);
    await expect(
      checkParserBinaries({
        session,
        resolveBinary: resolveAll,
        buildCommand: () => {
          throw new Error("bad paths");
        },
      }),
    ).rejects.toThrow("bad paths");
    expect(session.close).toHaveBeenCalledOnce();
  });

  it("skips every binary for a remote session", async () => {
    const run = vi.fn(async () => ok);
    const session = fakeSession("remote", run);
    const result = await checkParserBinaries({ session, resolveBinary: resolveAll, buildCommand });
    expect(result).toEqual({ failures: [], skipped: ["ffprobe", "ffmpeg", "pdftoppm", "pandoc"], remote: true });
    expect(run).not.toHaveBeenCalled();
    expect(session.close).toHaveBeenCalledOnce();
  });
});
