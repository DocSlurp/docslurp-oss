import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ExtractMarkdownStage } from "../stages/extract-markdown.js";
import { encodeImageBundle, type EmbeddedImages } from "../sandbox/providers/modal/doppler-images.js";

const bytes = Buffer.from("UklGRh4AAABXRUJQVlA4TBEAAAAvAYAAAAdQqCrUsv+BiOh/AAA=", "base64");
const sha256 = createHash("sha256").update(bytes).digest("hex");
const bundle: EmbeddedImages = { pageCount:3,first:1,last:3,
  assets:[{sha256,width:2,height:3,mediaType:"image/webp",bytes}],
  placements:[{sha256,width:2,height:3,pageNumber:1,occurrence:0,role:"image"},
    {sha256,width:2,height:3,pageNumber:1,occurrence:1,role:"smask",maskOf:0},
    {sha256,width:2,height:3,pageNumber:2,occurrence:2,role:"image"}] };

describe("Doppler image artifacts in the extraction stage", () => {
  it("persists deduplicated WebP with each placement and mask relationship under the document scope", async () => {
    const dir=await mkdtemp(path.join(tmpdir(),"doppler-artifact-test-"));
    try {
      const input=path.join(dir,"images"); await writeFile(input,encodeImageBundle(bundle));
      const stored=new Map<string,Buffer>(); let manifest:any;
      const storage={uri:(key:string)=>`s3://test/${key}`,
        streamToStorage:async(key:string,stream:AsyncIterable<Buffer>)=>{const parts:Buffer[]=[];for await(const b of stream)parts.push(b);stored.set(key,Buffer.concat(parts));},
        putJson:async(_key:string,value:unknown)=>{manifest=value;}};
      const stage=new ExtractMarkdownStage({} as any,storage as any,{} as any);
      const localGraph=vi.fn();
      const result=await (stage as any).enrichDocumentArtifacts({
        document:{id:"document-a",userId:"tenant-a",sourceKey:"tenant-a/source.pdf",mimeType:"application/pdf"},
        sourcePath:path.join(dir,"source.pdf"),sourceHash:"a".repeat(64),format:"pdf",targets:["document/media-map"],
        pageNumbers:[1,2,3],runId:"run-a",dopplerImageBundle:input,graphRunner:localGraph});
      expect(localGraph).not.toHaveBeenCalled();
      expect(result.outputCount).toBe(2);
      expect([...stored.keys()].every(k=>k.startsWith("tenant-a/run-a/artifact-graph/document-a/"))).toBe(true);
      expect([...stored.values()].filter(v=>v.equals(bytes))).toHaveLength(1);
      const image=manifest.artifacts.find((a:any)=>a.mediaType==="image/webp");
      expect(image.placements.map((p:any)=>p.pageNumber)).toEqual([1,1,2]);
      const map=JSON.parse([...stored.values()].find(v=>v.toString().startsWith('{"pageCount"'))!.toString());
      expect(map.pageCount).toBe(3);
      expect(map.images.map((p:any)=>[p.pageNumber,p.role])).toEqual([[1,"image"],[1,"smask"],[2,"image"]]);
      expect(map.images[1].maskOf).toEqual({pageNumber:1,occurrence:0});
      expect(map.images.every((p:any)=>p.artifactId===image.id)).toBe(true);
      expect(manifest.artifacts.every((a:any)=>a.sourceDocumentId==="document-a")).toBe(true);
    } finally {await rm(dir,{recursive:true,force:true});}
  });
  it("never falls back to local PDF parsing for missing or malformed VM assets", async () => {
    const dir=await mkdtemp(path.join(tmpdir(),"doppler-artifact-test-"));
    try {
      const input=path.join(dir,"images");await writeFile(input,"not a bundle");
      const localGraph=vi.fn(),put=vi.fn();
      const stage=new ExtractMarkdownStage({} as any,{putJson:put,streamToStorage:put} as any,{} as any);
      await expect((stage as any).enrichDocumentArtifacts({document:{id:"d",userId:"u",sourceKey:"u/source"},sourcePath:"unused",
        sourceHash:"a".repeat(64),format:"pdf",targets:["document/media-map"],pageNumbers:[1],runId:"r",dopplerImageBundle:input,graphRunner:localGraph})).rejects.toThrow();
      expect(localGraph).not.toHaveBeenCalled();expect(put).not.toHaveBeenCalled();
      expect(await readFile(input,"utf8")).toBe("not a bundle");
    } finally {await rm(dir,{recursive:true,force:true});}
  });
});

it("activates Fast Doppler image options through stage.run and publishes retrievable graph references", async () => {
  const { defaultPipelineFeatures, defaultDocumentExtractionConfig } = await import("@docslurp/shared");
  const { WorkflowState } = await import("../pipeline/pipeline.js");
  const { Writable } = await import("node:stream");
  const dir=await mkdtemp(path.join(tmpdir(),"doppler-stage-test-"));
  try {
    const sourcePath=path.join(dir,"source.pdf");await writeFile(sourcePath,"trusted test input; VM mocked");
    const objects=new Map<string,Buffer>(),manifests=new Map<string,any>();
    const storage={uri:(key:string)=>`s3://test/${key}`,
      putBytes:async(key:string,data:Uint8Array)=>{objects.set(key,Buffer.from(data));},
      putJson:async(key:string,value:unknown)=>{manifests.set(key,value);},
      streamText:async(key:string,value:string)=>{objects.set(key,Buffer.from(value));},
      streamToStorage:async(key:string,stream:AsyncIterable<Buffer>)=>{const parts:Buffer[]=[];for await(const b of stream)parts.push(b);objects.set(key,Buffer.concat(parts));},
      createMultipartUploadStream:(key:string)=>{
        const parts:Buffer[]=[];const writable=new Writable({write(chunk,_enc,cb){parts.push(Buffer.from(chunk));cb();}});
        const done=new Promise<void>((resolve,reject)=>{writable.on("finish",()=>{objects.set(key,Buffer.concat(parts));resolve();});writable.on("error",reject);});
        return {writable,done};
      }};
    const run=vi.fn(async(plan:any)=>{
      expect(plan.dopplerVm).toMatchObject({embeddedImages:true,imageMinWidth:1,imageMinHeight:1});
      await writeFile(plan.dopplerVm.output,"# Heading\n\nBorn digital prose with an embedded raster image.\fSecond page content.\fImage free final page.");
      await writeFile(`${plan.dopplerVm.output}.images`,encodeImageBundle(bundle));
      return {stdout:"",stderr:""};
    });
    const runner={dopplerMarkdown:async(input:string,output:string)=>({binary:"doppler-vm",args:[],available:true,dopplerVm:{operation:"doppler-markdown",input,output}}),run};
    const stage=new ExtractMarkdownStage(runner as any,storage as any,{} as any);
    const internals=stage as any;
    internals.sources={get:async()=>({path:sourcePath,sha256:"a".repeat(64)})};
    internals.recordSourcePageFacts=async()=>undefined;
    internals.recordPageImageEvidence=async()=>null;
    const doc={id:"d",userId:"u",runId:"r",filename:"source.pdf",mimeType:"application/pdf",sourceKey:"u/source.pdf",status:"processing",extractionMode:"hybrid",pageCount:3,createdAt:new Date(),updatedAt:new Date()};
    const state=WorkflowState.create({id:"r",orgId:"o",userId:"u",kind:"bulk-upload",status:"processing",stage:"extract-markdown",totalDocuments:1,processedDocuments:0,pagesTotal:3,pagesProcessed:0,spentCents:0,
      pipeline:{...defaultPipelineFeatures,quality:"fast",markdownExtraction:true,visionFallback:false,
        documentExtraction:{...defaultDocumentExtractionConfig,order:{pdf:["doppler"]},options:{doppler:{images:{enabled:true,minWidth:1,minHeight:1}}}}},
      error:null,stats:{},artifacts:{},claimId:null,createdAt:new Date(),updatedAt:new Date()} as any,[doc as any]);
    state.artifactLedger.recordDocument("d","normalizedFormat","pdf");
    await stage.run(state);
    expect(run).toHaveBeenCalledOnce();
    expect(state.documentStage("d","extract-markdown")?.status).toBe("completed");
    const markdownManifest=manifests.get("u/r/markdown/d.json");
    expect(markdownManifest.artifactGraphUri).toBe("s3://test/u/r/artifact-graph/d/manifest.json");
    const graph=manifests.get("u/r/artifact-graph/d/manifest.json");
    const image=graph.artifacts.find((a:any)=>a.mediaType==="image/webp");
    expect(objects.get(image.uri.replace("s3://test/",""))).toEqual(bytes);
    expect(Object.values(state.artifactLedger.all())).toContain(image.uri);
    const map=graph.artifacts.find((a:any)=>a.kind==="document/media-map");
    expect(JSON.parse(objects.get(map.uri.replace("s3://test/",""))!.toString()).images).toHaveLength(3);
    expect(Object.values(state.artifactLedger.all())).toContain(map.uri);
  } finally {await rm(dir,{recursive:true,force:true});}
});

it("rejects mixed targets and non-Doppler candidates before execution", async()=>{
  const { resolveDopplerImages }=await import("../extractors/doppler-image-graph.js");
  const { defaultDocumentExtractionConfig }=await import("@docslurp/shared");
  const config={...defaultDocumentExtractionConfig,enrich:["document/media-map"]};
  expect(()=>resolveDopplerImages(config,"pdf",["doppler","kreuzberg"])).toThrow("Doppler-only");
  expect(()=>resolveDopplerImages({...config,voting:{enabled:true,secondary:"kreuzberg"}},"pdf",["doppler"])).toThrow("Doppler-only");
  expect(()=>resolveDopplerImages({...config,enrich:["document/media-map","page/text"]},"pdf",["doppler"])).toThrow("non-image");
});
