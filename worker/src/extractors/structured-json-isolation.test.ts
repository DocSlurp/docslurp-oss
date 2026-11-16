import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { extractStructuredJsonFile, structuredJsonToMarkdown } from "./structured-json.js";
const run=vi.hoisted(()=>vi.fn());vi.mock("../tools/runner.js",()=>({CommandRunner:class{run=run;}}));
afterEach(()=>{vi.unstubAllEnvs();run.mockReset();});
async function fixture(fn:(input:string,output:string)=>Promise<void>){const dir=await mkdtemp(path.join(tmpdir(),"docslurp-json-test-"));try{const input=path.join(dir,"input.json"),output=path.join(dir,"out.md");await writeFile(input,'{"value":1}');await fn(input,output);}finally{await rm(dir,{recursive:true,force:true});}}
describe("structured source JSON production boundary",()=>{
 it("refuses direct host conversion",()=>{vi.stubEnv("NODE_ENV","production");expect(()=>structuredJsonToMarkdown('{"value":1}')).toThrow(/VM/);});
 it("stages only declared options and accepts a bounded typed result",async()=>{vi.stubEnv("NODE_ENV","production");await fixture(async(input,output)=>{
  run.mockImplementation(async(plan)=>{const settings=await readFile(plan.args.filter((a: string) => !a.startsWith("--"))[2],"utf8");expect(settings).not.toContain("credential-sentinel");await writeFile(plan.args.filter((a: string) => !a.startsWith("--"))[3],JSON.stringify({markdown:"value: 1",format:"json",recordCount:1,skippedLines:[],truncated:false}));});
  await extractStructuredJsonFile(input,output,{maxOutputChars:1000,databaseUrl:"credential-sentinel"} as never);expect(await readFile(output,"utf8")).toBe("value: 1");
 });});
 it.each(["revoked VM key","deeply nested JSON rejected in guest","wide JSON exceeds guest budget"])("does not locally parse after %s",async(message)=>{vi.stubEnv("NODE_ENV","production");run.mockRejectedValue(new Error(message));await fixture(async(input,output)=>{await expect(extractStructuredJsonFile(input,output)).rejects.toThrow(message);});});
 it("rejects hostile guest envelope",async()=>{vi.stubEnv("NODE_ENV","production");run.mockImplementation(async(plan)=>writeFile(plan.args.filter((a: string) => !a.startsWith("--"))[3],JSON.stringify({markdown:[],format:"json",recordCount:1,skippedLines:[],truncated:false})));await fixture(async(input,output)=>{await expect(extractStructuredJsonFile(input,output)).rejects.toThrow(/invalid structured JSON/);});});
});
