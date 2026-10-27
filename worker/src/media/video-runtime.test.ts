import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CommandRunner } from "../tools/runner.js";
import { inspectMedia } from "./prepare.js";
import { mediaConfig } from "./config.js";
import { scanVideo, prepareVideoFrame } from "./video-processing.js";
import { videoPolicy } from "./video-policy.js";
const execute=promisify(execFile);
describe("real bounded video decoder",()=>{
  it("probes silent video, scans timestamps and creates then removes a bounded JPEG",async()=>{
    const dir=await mkdtemp(path.join(tmpdir(),"docslurp-video-test-"));
    try {
      const source=path.join(dir,"source.mp4");
      await execute("ffmpeg",["-nostdin","-v","error","-f","lavfi","-i","testsrc2=size=160x90:rate=10","-t","2","-c:v","mpeg4","-threads","1",source],{timeout:10000});
      const runner=new CommandRunner();const probe=await inspectMedia(runner,source,mediaConfig({}));
      expect(probe).toEqual({duration:2,hasAudio:false,hasVideo:true});
      const scan=await scanVideo(runner,source,videoPolicy(probe.duration));
      expect(scan.candidateCount).toBe(4);expect(scan.selectedCount).toBeGreaterThan(0);
      const frame=await prepareVideoFrame(runner,source,scan.batches[0][0].seconds);
      expect([...frame.bytes.slice(0,2)]).toEqual([255,216]);expect(frame.bytes.length).toBeLessThan(200000);
      expect(await readdir(dir)).toEqual(["source.mp4"]);
      await expect(scanVideo(runner,source,videoPolicy(2),AbortSignal.abort())).rejects.toThrow();
    } finally { await rm(dir,{recursive:true,force:true}); }
  },20000);
});
