import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { projectSearchRetrievalDefaultsSchema, updateProjectSearchRetrievalDefaultsSchema } from "@docslurp/shared";
const spend = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../services/billing/spend-guard.js", () => ({ assertCanSpend: spend }));
vi.mock("../db.js", () => ({ sql: Object.assign(vi.fn(), { begin: vi.fn(), array: vi.fn() }) }));
import { rerankHosted, hostedRerankLimits, HOSTED_RERANK_MAX_CANDIDATES, HOSTED_RERANK_MODEL } from "../search/hosted-rerank.js";
import { rerankBM25 } from "../search/rerank.js";
import { createSearchSessionJournal } from "../search/session.js";
import { applySearchPostRetrievalProcessing, searchResultsToChunks } from "../search/session-execution.js";
const chunks = [{ id: "a", text: "Pump maintenance schedule.", score: 1 }, { id: "b", text: "Inspect the pressure gauge monthly.", score: 0.5 }];
const session = () => createSearchSessionJournal({ rootSessionId: "synthetic-ranking", scope: { orgId: "o", projectId: "w" } });
const args = () => ({ query: "pump maintenance", chunks, model: HOSTED_RERANK_MODEL, apiKey: "synthetic", privacyMode: "standard" as const, scope: { orgId: "o", projectId: "w" }, session: session() });
const http = vi.fn();
beforeEach(() => { spend.mockReset().mockResolvedValue(); http.mockReset(); vi.stubGlobal("fetch", http); vi.stubEnv("SEARCH_RERANK_CONCURRENCY", "4"); vi.stubEnv("SEARCH_RERANK_TIMEOUT_MS", "15000"); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.useRealTimers(); });
describe("optional hosted reranking", () => {
  it("keeps BM25 default and validates explicit provider/model settings", () => {
    expect(projectSearchRetrievalDefaultsSchema.parse({}).rerankProvider).toBeUndefined();
    expect(updateProjectSearchRetrievalDefaultsSchema.parse({ rerankProvider: "deepinfra", rerankModel: HOSTED_RERANK_MODEL }).rerankProvider).toBe("deepinfra");
    expect(() => updateProjectSearchRetrievalDefaultsSchema.parse({ rerankProvider: "unknown" })).toThrow();
    expect(() => updateProjectSearchRetrievalDefaultsSchema.parse({ rerankModel: "other" })).toThrow();
  });
  it("maps native scores to original candidates and records actual priced usage", async () => {
    http.mockResolvedValue(Response.json({ input_tokens: 174, scores: [0.1, 0.9] }));
    const input = args(), ranked = await rerankHosted(input);
    expect(ranked.map(c => c.id)).toEqual(["b", "a"]); expect(ranked[0].text).toBe(chunks[1].text);
    expect(spend).toHaveBeenCalledWith("o", "w", { kind: "interactive" });
    const [url, request] = http.mock.calls[0];
    expect(url).toBe("https://api.deepinfra.com/v1/inference/Qwen/Qwen3-Reranker-0.6B"); expect(request.redirect).toBe("error");
    expect(JSON.parse(request.body)).toEqual({ queries: [input.query, input.query], documents: chunks.map(c => c.text) });
    expect(input.session.usageEvents()).toMatchObject([{ inputTokens: 174, metadata: { providerCostCents: 174 * 0.01 / 1e6 * 100,
      modelConfig: { operation: "rerank", batchSize: 25, maxCandidates: 50 }, modelClass: { rerank: "hosted" } } }]);
    expect(input.session.diagnostics().hostedRerank).toMatchObject({ status: "success", requests: 1 });
  });
  it.each(["local-only", "strict-privacy"] as const)("blocks %s before spend/HTTP", async privacyMode => {
    const input = { ...args(), privacyMode };
    expect(await rerankHosted(input)).toEqual(rerankBM25(input.query, chunks));
    expect(http).not.toHaveBeenCalled(); expect(spend).not.toHaveBeenCalled();
    expect(input.session.diagnostics().hostedRerank).toMatchObject({ reason: "privacy_blocked" });
  });
  it("blocks missing scope, duplicate identity and overlength payloads without HTTP", async () => {
    for (const input of [{ ...args(), scope: undefined }, { ...args(), chunks: [chunks[0], chunks[0]] }, { ...args(), query: "a".repeat(30_001) }]) await rerankHosted(input);
    expect(http).not.toHaveBeenCalled();
  });
  it("spend denial falls back without a call", async () => {
    spend.mockRejectedValue(Error("blocked")); const input=args(); await rerankHosted(input);
    expect(http).not.toHaveBeenCalled(); expect(input.session.diagnostics().hostedRerank).toMatchObject({ reason: "spend_blocked" });
  });
  it.each([{ input_tokens: 10, scores: [1] }, { input_tokens: 10, scores: [1, null] }])("meters malformed score output before fallback", async data => {
    http.mockResolvedValue(Response.json(data)); const input=args(); expect(await rerankHosted(input)).toEqual(rerankBM25(input.query, chunks));
    expect(input.session.usageEvents()).toHaveLength(1); expect(input.session.diagnostics().hostedRerank).toMatchObject({ reason: "invalid_scores", possibleUnreceiptedCharge: false });
  });
  it("records billable HTTP failure; missing usage and transport stay unknown with no retry", async () => {
    http.mockResolvedValueOnce(Response.json({ input_tokens: 20 }, { status: 429 })); const billed=args(); await rerankHosted(billed); expect(billed.session.usageEvents()).toHaveLength(1);
    http.mockResolvedValueOnce(Response.json({ scores: [0.1, 0.9] })); const missing=args(); await rerankHosted(missing);
    expect(missing.session.diagnostics().hostedRerank).toMatchObject({ reason: "missing_usage", possibleUnreceiptedCharge: true });
    http.mockRejectedValueOnce(Error("transport")); const transport=args(); await rerankHosted(transport);
    expect(transport.session.diagnostics().hostedRerank).toMatchObject({ possibleUnreceiptedCharge: true }); expect(http).toHaveBeenCalledTimes(3);
  });
  it("batches 25, spends per batch and retains earlier usage on later failure", async () => {
    http.mockResolvedValueOnce(Response.json({ input_tokens: 50, scores: Array(25).fill(0.5) })).mockRejectedValueOnce(Error("transport"));
    const input={...args(),chunks:Array.from({length:26},(_,i)=>({...chunks[0],id:`candidate-${i}`}))};
    expect(await rerankHosted(input)).toHaveLength(26); expect(spend).toHaveBeenCalledTimes(2);
    expect(input.session.usageEvents()).toHaveLength(1); expect(input.session.diagnostics().hostedRerank).toMatchObject({ requests: 2, inputTokens: 50, possibleUnreceiptedCharge: true });
  });
  it("timeout degrades with sanitized diagnostics", async () => {
    http.mockRejectedValue(new DOMException("private error", "TimeoutError")); const input=args(); await rerankHosted(input);
    expect(input.session.diagnostics().hostedRerank).toMatchObject({ reason: "timeout" }); expect(JSON.stringify(input.session.diagnostics())).not.toContain("private error");
  });
  it("actual post-retrieval seam opts in, preserves citations/body and honors rerank off", async () => {
    const candidates=searchResultsToChunks(chunks.map((c,i)=>({text:c.text,score:c.score,citation:{source:"document" as const,documentId:"doc",filename:"manual.txt",pageNumber:i+1,pageNumbers:[i+1],headingPath:[],chunkIndex:i,blockIds:[],blockTypes:[],evidenceType:null,canonicalDocumentUri:null,tableGranularity:null,tableRowIndex:null,tableRowCount:null,tableColumnNames:[],tableColumnTypes:[],tableCells:[],tableCell:null,regionBoxes:[],regions:[],regionCoordinateSpace:null}})));
    http.mockResolvedValue(Response.json({ input_tokens: 20, scores: [0.1, 0.9] }));
    const input={query:"pump maintenance",chunks:candidates,limit:2,options:{useRerank:true,rerankProvider:"deepinfra" as const,resultOrder:"relevance" as const},privacyMode:"standard" as const,session:session(),rerankApiKey:"synthetic",rerankScope:{orgId:"o",projectId:"w"}};
    const ranked=await applySearchPostRetrievalProcessing(input); expect(ranked.map(c=>c.pageNumber).sort()).toEqual([1,2]); expect(ranked[0].pageNumber).toBe(1); expect(ranked.find(c=>c.pageNumber===2)!.text).toBe(candidates[1].text); expect(ranked[0].documentId).toBe("doc");
    await applySearchPostRetrievalProcessing({...input,options:{...input.options,useRerank:false}}); expect(http).toHaveBeenCalledTimes(1);
  });
  it("bounds configurable concurrency and the whole-operation request timeout", () => {
    expect(hostedRerankLimits({})).toEqual({ concurrency: 4, timeoutMs: 15000 });
    expect(hostedRerankLimits({ SEARCH_RERANK_CONCURRENCY: "", SEARCH_RERANK_TIMEOUT_MS: " " })).toEqual({ concurrency: 4, timeoutMs: 15000 });
    expect(hostedRerankLimits({ SEARCH_RERANK_CONCURRENCY: "999", SEARCH_RERANK_TIMEOUT_MS: "999999" })).toEqual({ concurrency: 4, timeoutMs: 30000 });
    expect(hostedRerankLimits({ SEARCH_RERANK_CONCURRENCY: "0", SEARCH_RERANK_TIMEOUT_MS: "-1" })).toEqual({ concurrency: 1, timeoutMs: 1000 });
    expect(hostedRerankLimits({ SEARCH_RERANK_CONCURRENCY: "bad", SEARCH_RERANK_TIMEOUT_MS: "1.5" })).toEqual({ concurrency: 4, timeoutMs: 15000 });
  });
  it("dispatches the 50-candidate cap in bounded waves and preserves tied input order", async () => {
    vi.stubEnv("SEARCH_RERANK_CONCURRENCY","1");
    const waiting: Array<(r: Response) => void> = [];
    let active=0,maxActive=0;
    http.mockImplementation(() => { active++; maxActive=Math.max(maxActive,active);return new Promise<Response>(resolve => waiting.push(resolve)).finally(() => { active--; }); });
    const input={...args(),chunks:Array.from({length:HOSTED_RERANK_MAX_CANDIDATES},(_,i)=>({...chunks[0],id:`c${i}`}))};
    const running=rerankHosted(input);
    await vi.waitFor(() => expect(waiting).toHaveLength(1));
    expect(http).toHaveBeenCalledTimes(1);
    waiting[0](Response.json({input_tokens:25,scores:Array(25).fill(.5)}));
    await vi.waitFor(() => expect(waiting).toHaveLength(2));
    waiting[1](Response.json({input_tokens:25,scores:Array(25).fill(.5)}));
    expect((await running).map(c=>c.id)).toEqual(input.chunks.map(c=>c.id));
    expect(maxActive).toBe(1);expect(spend).toHaveBeenCalledTimes(2);
    expect(input.session.usageEvents()).toHaveLength(2);
    expect(input.session.diagnostics().hostedRerank).toMatchObject({status:"success",requests:2,inputTokens:50,concurrency:1,timeoutMs:15000,unreceiptedRequests:0});
  });
  it("refuses more than the candidate cap without a provider request", async () => {
    const input={...args(),chunks:Array.from({length:HOSTED_RERANK_MAX_CANDIDATES+1},(_,i)=>({...chunks[0],id:`c${i}`}))};
    expect(await rerankHosted(input)).toEqual(rerankBM25(input.query,input.chunks));
    expect(http).not.toHaveBeenCalled();expect(input.session.usageEvents()).toHaveLength(0);
    expect(input.session.diagnostics().hostedRerank).toMatchObject({status:"fallback",reason:"invalid_input"});
  });
  it("post-retrieval sends only the top candidates to the hosted reranker and keeps the rest", async () => {
    const candidates=searchResultsToChunks(Array.from({length:80},(_,i)=>({text:`Pump maintenance ${i}.`,score:1-i/100,citation:{source:"document" as const,documentId:"doc",filename:"manual.txt",pageNumber:i+1,pageNumbers:[i+1],headingPath:[],chunkIndex:i,blockIds:[],blockTypes:[],evidenceType:null,canonicalDocumentUri:null,tableGranularity:null,tableRowIndex:null,tableRowCount:null,tableColumnNames:[],tableColumnTypes:[],tableCells:[],tableCell:null,regionBoxes:[],regions:[],regionCoordinateSpace:null}})));
    const sent: string[] = [];
    http.mockImplementation(async (_url: string, request: RequestInit) => { const body=JSON.parse(String(request.body)); sent.push(...body.documents); return Response.json({input_tokens:body.documents.length,scores:body.documents.map(()=>0.5)}); });
    const input={query:"pump maintenance",chunks:candidates,limit:80,options:{useRerank:true,rerankProvider:"deepinfra" as const,candidateDepth:80,resultOrder:"relevance" as const},privacyMode:"standard" as const,session:session(),rerankApiKey:"synthetic",rerankScope:{orgId:"o",projectId:"w"}};
    const ranked=await applySearchPostRetrievalProcessing(input);
    expect(sent).toEqual(candidates.slice(0,HOSTED_RERANK_MAX_CANDIDATES).map(c=>c.text));
    expect(ranked).toHaveLength(80);
    expect(input.session.diagnostics().hostedRerank).toMatchObject({status:"success",inputTokens:HOSTED_RERANK_MAX_CANDIDATES});
  });
  it("awaits late successful and billable failed siblings after transport failure", async () => {
    const waiting: Array<{resolve:(r:Response)=>void;reject:(e:Error)=>void}> = [];
    http.mockImplementation(() => new Promise<Response>((resolve,reject)=>waiting.push({resolve,reject})));
    const input={...args(),chunks:Array.from({length:HOSTED_RERANK_MAX_CANDIDATES},(_,i)=>({...chunks[0],id:`c${i}`}))};
    let finished=false;const running=rerankHosted(input).then(r=>{finished=true;return r;});
    await vi.waitFor(()=>expect(waiting).toHaveLength(2));
    waiting[0].reject(Error("transport"));
    await new Promise(resolve=>setTimeout(resolve,10));
    expect(finished).toBe(false);expect(http).toHaveBeenCalledTimes(2);
    waiting[1].resolve(Response.json({input_tokens:40,scores:Array(25).fill(.5)}));
    expect(await running).toEqual(rerankBM25(input.query,input.chunks));
    expect(input.session.usageEvents()).toHaveLength(1);
    expect(input.session.diagnostics().hostedRerank).toMatchObject({status:"fallback",requests:2,inputTokens:40,unreceiptedRequests:1,possibleUnreceiptedCharge:true});
  });
  it("settles sibling usage before propagating a broken recorder", async () => {
    const waiting: Array<(r:Response)=>void> = [];
    http.mockImplementation(()=>new Promise<Response>(resolve=>waiting.push(resolve)));
    const input={...args(),chunks:Array.from({length:50},(_,i)=>({...chunks[0],id:`c${i}`}))};
    const original=input.session.record.bind(input.session);
    vi.spyOn(input.session,"record").mockImplementationOnce(()=>{throw Error("recorder broken");}).mockImplementation(original);
    let finished=false;const running=rerankHosted(input).then(()=>{finished=true;return null;},e=>{finished=true;return e;});
    await vi.waitFor(()=>expect(waiting).toHaveLength(2));
    waiting[0](Response.json({input_tokens:10,scores:Array(25).fill(.5)}));
    await vi.waitFor(()=>expect(input.session.record).toHaveBeenCalledTimes(1));expect(finished).toBe(false);
    waiting[1](Response.json({input_tokens:30,scores:Array(25).fill(.5)}));
    expect(await running).toMatchObject({message:"recorder broken"});
    expect(input.session.usageEvents()).toMatchObject([{inputTokens:30}]);
    expect(input.session.diagnostics().hostedRerank).toMatchObject({reason:"usage_recording_failed",unreceiptedRequests:1,inputTokens:30});
  });
  it("rechecks privacy directly before each later dispatch", async () => {
    vi.stubEnv("SEARCH_RERANK_CONCURRENCY","1");
    const input: Parameters<typeof rerankHosted>[0]={...args(),chunks:Array.from({length:50},(_,i)=>({...chunks[0],id:`c${i}`}))};
    http.mockImplementationOnce(async()=>{input.privacyMode="local-only";return Response.json({input_tokens:25,scores:Array(25).fill(.5)});});
    await rerankHosted(input);
    expect(http).toHaveBeenCalledTimes(1);
    expect(input.session.diagnostics().hostedRerank).toMatchObject({reason:"privacy_blocked",inputTokens:25});
  });
  it("shared deadline stops new waves but waits for already dispatched usage", async () => {
    const controller=new AbortController();vi.spyOn(AbortSignal,"timeout").mockReturnValue(controller.signal);
    const waiting: Array<(r:Response)=>void> = [];
    http.mockImplementation(()=>new Promise<Response>(resolve=>waiting.push(resolve)));
    vi.stubEnv("SEARCH_RERANK_CONCURRENCY","1");
    const input={...args(),chunks:Array.from({length:HOSTED_RERANK_MAX_CANDIDATES},(_,i)=>({...chunks[0],id:`c${i}`}))};
    const running=rerankHosted(input);
    await vi.waitFor(()=>expect(waiting).toHaveLength(1));controller.abort();
    waiting.forEach(resolve=>resolve(Response.json({input_tokens:25,scores:Array(25).fill(.5)})));
    await running;expect(http).toHaveBeenCalledTimes(1);
    expect(input.session.usageEvents()).toHaveLength(1);
    expect(input.session.diagnostics().hostedRerank).toMatchObject({status:"fallback",reason:"timeout",inputTokens:25,unreceiptedRequests:0});
  });
});
