import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { imageFact } from "../test/image-facts.js";
import { ExtractMarkdownStage } from "../stages/extract-markdown.js";
import { registerExtractorPlugin, resetExtractorPluginsForTest, type EmbeddedImageSet } from "../extractors/plugins.js";

const bytes = Buffer.from("UklGRh4AAABXRUJQVlA4TBEAAAAvAYAAAAdQqCrUsv+BiOh/AAA=", "base64");
const sha256 = createHash("sha256").update(bytes).digest("hex");
const images: EmbeddedImageSet = { pageCount:3,first:1,last:3,minWidth:1,minHeight:1,encoding:"lossless-webp",placementSource:"content-stream",
  assets:[{sha256,width:2,height:3,mediaType:"image/webp",bytes}],
  placements:[imageFact({sha256,width:2,height:3,pageNumber:1,occurrence:0,role:"image"}),
    imageFact({sha256,width:2,height:3,pageNumber:1,occurrence:1,role:"smask",maskOf:0}),
    imageFact({sha256,width:2,height:3,pageNumber:2,occurrence:2,role:"image"})] };

/** A test provider: its "VM" writes Markdown and records which outputs carry images. */
function registerTestProvider(read: (output: string) => Promise<EmbeddedImageSet> = async () => images) {
  const reads: string[] = [];
  registerExtractorPlugin({ apiVersion: 1, name: "test-plugin", sandboxedPdf: {
    id: "test-vm", maxSourceBytes: 1024, assertConfigured: () => undefined, timeoutMs: () => 1_000,
    run: async () => ({ exitCode: 0, stdout: "{}", stderr: "" }),
    embeddedImages: { producerId: "test-embedded-images", optionsDigest: "test", read: async (output) => { reads.push(output); return await read(output); } },
  } });
  return reads;
}

beforeEach(() => resetExtractorPluginsForTest());
afterEach(() => { resetExtractorPluginsForTest(); vi.unstubAllEnvs(); });

describe("VM PDF image artifacts in the extraction stage", () => {
  it("persists deduplicated assets with each placement and mask relationship under the document scope", async () => {
    registerTestProvider();
    const dir=await mkdtemp(path.join(tmpdir(),"vm-artifact-test-"));
    try {
      const stored=new Map<string,Buffer>(); let manifest:any;
      const storage={uri:(key:string)=>`s3://test/${key}`,
        streamToStorage:async(key:string,stream:AsyncIterable<Buffer>)=>{const parts:Buffer[]=[];for await(const b of stream)parts.push(b);stored.set(key,Buffer.concat(parts));},
        putJson:async(_key:string,value:unknown)=>{manifest=value;}};
      const stage=new ExtractMarkdownStage({} as any,storage as any,{} as any);
      const localGraph=vi.fn();
      const result=await (stage as any).enrichDocumentArtifacts({
        document:{id:"document-a",userId:"tenant-a",sourceKey:"tenant-a/source.pdf",mimeType:"application/pdf"},
        sourcePath:path.join(dir,"source.pdf"),sourceHash:"a".repeat(64),format:"pdf",targets:["document/media-map"],
        pageNumbers:[1,2,3],runId:"run-a",vmImages:{output:path.join(dir,"out.md")},graphRunner:localGraph});
      expect(localGraph).not.toHaveBeenCalled();
      expect(result.outputCount).toBe(2);
      expect(result.artifactUris).toHaveLength(2);
      expect([...stored.keys()].every(k=>k.startsWith("tenant-a/run-a/artifact-graph/document-a/"))).toBe(true);
      expect([...stored.values()].filter(v=>v.equals(bytes))).toHaveLength(1);
      const image=manifest.artifacts.find((a:any)=>a.mediaType==="image/webp");
      expect(image.placements.map((p:any)=>p.pageNumber)).toEqual([1,1,2]);
      expect(image.producer.id).toBe("test-embedded-images");
      const map=JSON.parse([...stored.values()].find(v=>v.toString().startsWith('{"version":"docslurp-media-map@2"'))!.toString());
      expect(map.pageCount).toBe(3);
      expect(map.images.map((p:any)=>[p.pageNumber,p.role])).toEqual([[1,"image"],[1,"smask"],[2,"image"]]);
      expect(map.images[1].maskOf).toEqual({pageNumber:1,occurrence:0});
      expect(map.images.every((p:any)=>p.artifactId===image.id)).toBe(true);
      expect(manifest.artifacts.every((a:any)=>a.sourceDocumentId==="document-a")).toBe(true);
    } finally {await rm(dir,{recursive:true,force:true});}
  });

  it("never falls back to local PDF parsing for missing or malformed VM images", async () => {
    registerTestProvider(async () => { throw new Error("malformed image sidecar"); });
    const localGraph=vi.fn(),put=vi.fn();
    const stage=new ExtractMarkdownStage({} as any,{putJson:put,streamToStorage:put} as any,{} as any);
    await expect((stage as any).enrichDocumentArtifacts({document:{id:"d",userId:"u",sourceKey:"u/source"},sourcePath:"unused",
      sourceHash:"a".repeat(64),format:"pdf",targets:["document/media-map"],pageNumbers:[1],runId:"r",vmImages:{output:"/unused"},graphRunner:localGraph})).rejects.toThrow("malformed");
    expect(localGraph).not.toHaveBeenCalled();expect(put).not.toHaveBeenCalled();
    resetExtractorPluginsForTest();
    registerTestProvider(async () => ({ ...images, pageCount: 2, last: 2 }));
    await expect((stage as any).enrichDocumentArtifacts({document:{id:"d",userId:"u",sourceKey:"u/source"},sourcePath:"unused",
      sourceHash:"a".repeat(64),format:"pdf",targets:["document/media-map"],pageNumbers:[1,2,3],runId:"r",vmImages:{output:"/unused"},graphRunner:localGraph})).rejects.toThrow("page count");
    expect(localGraph).not.toHaveBeenCalled();expect(put).not.toHaveBeenCalled();
  });
});

it("activates Fast VM image options through stage.run, anchors the Markdown and publishes retrievable graph references", async () => {
  const reads = registerTestProvider();
  const { defaultPipelineFeatures, defaultDocumentExtractionConfig } = await import("@docslurp/shared");
  const { WorkflowState } = await import("../pipeline/pipeline.js");
  const { Writable } = await import("node:stream");
  const dir=await mkdtemp(path.join(tmpdir(),"vm-stage-test-"));
  try {
    const sourcePath=path.join(dir,"source.pdf");await writeFile(sourcePath,"trusted test input; VM faked");
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
      expect(plan.sandboxedPdf).toMatchObject({embeddedImages:{minWidth:1,minHeight:1}});
      await writeFile(plan.sandboxedPdf.output,"# Heading\n\nBorn digital prose with an embedded raster image.\fSecond page content.\fImage free final page.");
      return {stdout:"",stderr:""};
    });
    const runner={sandboxedPdfMarkdown:async(input:string,output:string)=>({binary:"test-vm",args:[],available:true,sandboxedPdf:{input,output}}),run};
    const stage=new ExtractMarkdownStage(runner as any,storage as any,{} as any);
    const internals=stage as any;
    internals.sources={get:async()=>({path:sourcePath,sha256:"a".repeat(64)})};
    internals.recordSourcePageFacts=async()=>undefined;
    internals.recordPageImageEvidence=async()=>null;
    const doc={id:"d",userId:"u",runId:"r",filename:"source.pdf",mimeType:"application/pdf",sourceKey:"u/source.pdf",status:"processing",extractionMode:"hybrid",pageCount:3,createdAt:new Date(),updatedAt:new Date()};
    const state=WorkflowState.create({id:"r",orgId:"o",userId:"u",kind:"bulk-upload",status:"processing",stage:"extract-markdown",totalDocuments:1,processedDocuments:0,pagesTotal:3,pagesProcessed:0,spentCents:0,
      pipeline:{...defaultPipelineFeatures,quality:"fast",markdownExtraction:true,visionFallback:false,
        documentExtraction:{...defaultDocumentExtractionConfig,order:{pdf:["vm-pdf"]},options:{"vm-pdf":{images:{enabled:true,minWidth:1,minHeight:1}}}}},
      error:null,stats:{},artifacts:{},claimId:null,createdAt:new Date(),updatedAt:new Date()} as any,[doc as any]);
    state.artifactLedger.recordDocument("d","normalizedFormat","pdf");
    await stage.run(state);
    expect(run).toHaveBeenCalledOnce();
    expect(reads.length).toBeGreaterThanOrEqual(2);
    expect(state.documentStage("d","extract-markdown")?.status).toBe("completed");
    const markdownManifest=manifests.get("u/r/markdown/d.json");
    expect(markdownManifest.artifactGraphUri).toBe("s3://test/u/r/artifact-graph/d/manifest.json");
    expect(markdownManifest.artifactGraphStats).toMatchObject({ images: 3 });
    const graph=manifests.get("u/r/artifact-graph/d/manifest.json");
    const image=graph.artifacts.find((a:any)=>a.mediaType==="image/webp");
    expect(objects.get(image.uri.replace("s3://test/",""))).toEqual(bytes);
    expect(Object.values(state.artifactLedger.all())).toContain(image.uri);
    const map=graph.artifacts.find((a:any)=>a.kind==="document/media-map");
    const parsed=JSON.parse(objects.get(map.uri.replace("s3://test/",""))!.toString());
    expect(parsed.images).toHaveLength(3);
    expect(Object.values(state.artifactLedger.all())).toContain(map.uri);
    // The stored Markdown carries a reference for every image the media map says is included.
    const stored=[...objects.values()].map(v=>v.toString()).find(v=>v.includes("docslurp-artifact:")) ?? "";
    expect(parsed.images.filter((i:any)=>i.markdown.included).length).toBeGreaterThan(0);
    expect(stored).toContain(`docslurp-artifact:d:${sha256}.webp#p1o0`);
    for (const entry of parsed.images.filter((i:any)=>i.markdown.included)) expect(stored).toContain(`#${entry.markdown.anchor})`);
  } finally {await rm(dir,{recursive:true,force:true});}
});

it("uses the local default for image targets without a provider, and refuses mixed or unsupported VM routes with one", async()=>{
  const { resolveEmbeddedImageRequest }=await import("../extractors/embedded-images.js");
  const { defaultDocumentExtractionConfig }=await import("@docslurp/shared");
  const config={...defaultDocumentExtractionConfig,enrich:["document/media-map"]};
  expect(resolveEmbeddedImageRequest(config,"pdf",["poppler-text"])).toBeNull();
  registerTestProvider();
  expect(()=>resolveEmbeddedImageRequest(config,"pdf",["vm-pdf","poppler-text"])).toThrow("vm-pdf-only");
  expect(()=>resolveEmbeddedImageRequest({...config,voting:{enabled:true,secondary:"poppler-text"}},"pdf",["vm-pdf"])).toThrow("vm-pdf-only");
  expect(()=>resolveEmbeddedImageRequest({...config,enrich:["document/media-map","page/text"]},"pdf",["vm-pdf"])).toThrow("non-image");
  expect(resolveEmbeddedImageRequest({...config},"pdf",["vm-pdf"])).toEqual({minWidth:1,minHeight:1});
  resetExtractorPluginsForTest();
  registerExtractorPlugin({ apiVersion: 1, name: "no-images", sandboxedPdf: { id: "test-vm", maxSourceBytes: 1, assertConfigured() {}, timeoutMs: () => 1, run: async () => ({ exitCode: 0, stdout: "", stderr: "" }) } });
  expect(()=>resolveEmbeddedImageRequest({...config},"pdf",["vm-pdf"])).toThrow("does not return embedded images");
});
