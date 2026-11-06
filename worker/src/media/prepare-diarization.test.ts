import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { prepareDiarizationAudio } from "./prepare.js";

/**
 * Owner rule: a container's declared duration (ffprobe format.duration) is what the file is billed for, so it also bounds the
 * work. Diarization encodes only up to that duration: a file that declares 1 second but holds hours gets 1 second processed.
 */
describe("prepareDiarizationAudio", () => {
  it("encodes no more audio than the billed duration", async () => {
    const dir = await mkdtemp(path.join(process.env.TMPDIR || tmpdir(), "diarize-"));
    const source = path.join(dir, "talk.webm");
    const planned: string[][] = [];
    const runner = {
      plan: vi.fn(async (binary: string, ...args: string[]) => { planned.push([binary, ...args]); return { binary, args, available: true }; }),
      run: vi.fn(async () => { await writeFile(path.join(dir, "diarization.mp3"), Buffer.alloc(16)); return { stdout: "", stderr: "" }; }),
    };
    expect((await prepareDiarizationAudio(runner as never, source, 1)).length).toBe(16);
    const args = planned[0]!;
    // -t after -i limits the output to the billed duration.
    expect(args.indexOf("-t")).toBeGreaterThan(args.indexOf("-i"));
    expect(args[args.indexOf("-t") + 1]).toBe("1");
    await expect(prepareDiarizationAudio(runner as never, source, 0)).rejects.toThrow(/billed media duration/);
  });
});
