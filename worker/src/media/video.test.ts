import { verifyDeepInfraRate } from "./rates.js";
import { describe, expect, it, vi } from "vitest";
import { videoPolicy, selectVideoFrames, packVideoFrames, type VideoCandidate } from "./video-policy.js";
import { DeepInfraVisionProvider } from "./vision.js";
function candidates(seconds: number, moving=false): VideoCandidate[] {
  return Array.from({length:seconds*2},(_,i)=>({seconds:i/2,delta:moving?.2:0,area:moving?.5:0,tile:moving?.4:0,histogram:moving?.3:0}));
}
describe("bounded video policies",()=>{
  it("gives every organization the same $10 per-document ceiling, which a workspace can only lower", () => {
    expect(videoPolicy(30).maxCostCents).toBe(1000);
    expect(videoPolicy(30, { maxCostCents: 2000 }).maxCostCents).toBe(1000);
    expect(videoPolicy(30, { maxCostCents: 10 }).maxCostCents).toBe(10);
  });
  it("processes two-hour videos at the priced frame density", () => {
    const p = videoPolicy(7200);
    expect(p.frames).toBe(1440);
    expect(p.frames / (7200 / 60)).toBeLessThanOrEqual(12);
    expect(() => videoPolicy(7201)).toThrow("2 hour");
  });
  it("allocates duration-aware budgets without starving late coverage",()=>{
    expect(videoPolicy(30).frames).toBe(24);
    const p=videoPolicy(1800); expect(p.frames).toBe(360);
    const selected=selectVideoFrames(candidates(1800,true),p);
    expect(selected.length).toBeLessThanOrEqual(360);
    expect(selected.at(-1)!.seconds).toBe(1799.5);
    expect(Math.max(...selected.slice(1).map((f,i)=>f.seconds-selected[i].seconds))).toBeLessThanOrEqual(10.5);
    const batches=packVideoFrames(selected,p);
    expect(batches.every(b=>b.length<=8 && b.at(-1)!.seconds-b[0].seconds<=120)).toBe(true);
  });
  it("keeps static coverage without filling the ceiling and finds small changed regions",()=>{
    const data=candidates(1800); expect(selectVideoFrames(data,videoPolicy(1800))).toHaveLength(181);
    const short=candidates(30);short[7]={seconds:3.5,delta:0,area:.003,tile:.8,histogram:0};
    expect(selectVideoFrames(short,videoPolicy(30)).some(f=>f.seconds===3.5)).toBe(true);
  });
  it("clamps workspace settings to the policy and bounds total candidate work",()=>{
    const p=videoPolicy(600,{maxFrames:1200,imagesPerCall:32,scanFps:10});expect(p.frames).toBe(120);expect(p.images).toBe(24);
    expect(videoPolicy(7200,{scanFps:10}).scanFps).toBe(2);
    expect(()=>videoPolicy(7201)).toThrow();expect(()=>videoPolicy(30,{scanFps:NaN})).toThrow();
    expect(()=>selectVideoFrames([{seconds:NaN,delta:0,area:0,tile:0,histogram:0}],p)).toThrow();
  });
});
describe("vision usage transport",()=>{
  it("uses actual usage, retains request ID and labels provider estimated cost",async()=>{
    const http=vi.fn(async()=>Response.json({id:"chat-id",choices:[{finish_reason:"stop",message:{content:"Visible evidence"}}],usage:{prompt_tokens:1000,completion_tokens:100,estimated_cost:.00021}},{headers:{"x-request-id":"request-id"}}));
    const provider=new DeepInfraVisionProvider("test",http);
    const result=await provider.describe([{seconds:10,bytes:new Uint8Array([1])}],new AbortController().signal);
    expect(result).toMatchObject({inputTokens:1000,outputTokens:100,costUsd:.00021,requestId:"request-id",accounting:{state:"estimated",basis:"tokens"}});
    expect(provider.reserveUsd).toBeGreaterThan(result.costUsd);
    const body=JSON.parse((http.mock.calls as unknown as [string,RequestInit][])[0][1].body as string);
    expect(body.max_tokens).toBe(1024);expect(body.messages[1].content[0].text).toContain("10.000");
  });
  it("does not invent missing tokens or retry truncated/failed calls",async()=>{
    const http=vi.fn(async()=>Response.json({choices:[{finish_reason:"stop",message:{content:"visible"}}]}));const provider=new DeepInfraVisionProvider("test",http);
    const result=await provider.describe([{seconds:0,bytes:new Uint8Array([1])}],new AbortController().signal);
    expect(result.inputTokens).toBeUndefined();expect(result.costUsd).toBe(provider.reserveUsd);
    http.mockResolvedValueOnce(Response.json({choices:[{finish_reason:"length",message:{content:"partial"}}]}));
    await expect(provider.describe([{seconds:0,bytes:new Uint8Array([1])}],new AbortController().signal)).rejects.toThrow("Incomplete");expect(http).toHaveBeenCalledTimes(2);
  });
});

it("fails closed on provider rate/context drift before inference",async()=>{
  const http=vi.fn(async()=>Response.json({pricing:{type:"tokens",cents_per_input_token:.000015,cents_per_output_token:.00006},max_tokens:262144}));
  await verifyDeepInfraRate("model",{inputTokenCents:.000015,outputTokenCents:.00006,context:262144},http);
  await expect(verifyDeepInfraRate("model",{inputTokenCents:.00002,outputTokenCents:.00006,context:262144},http)).rejects.toThrow("changed");
});

it("applies the selected FPS ceiling to coverage anchors as well as change candidates",()=>{
  for (const moving of [false,true]) {
    const selected=selectVideoFrames(candidates(30,moving),videoPolicy(30,{maxSelectedFps:.1}));
    expect(selected.length).toBeGreaterThan(1);
    expect(selected.slice(1).every((f,i)=>f.seconds-selected[i].seconds >= 10)).toBe(true);
  }
});
