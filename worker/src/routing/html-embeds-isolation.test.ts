import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { detectHtmlEmbeds, detectHtmlEmbedsFile } from "./html-embeds.js";
import { GUEST_NODE_FLAGS } from "../sandbox/guest-node-flags.js";
afterEach(()=>vi.unstubAllEnvs());
async function fixture(fn:(input:string)=>Promise<void>){const dir=await mkdtemp(path.join(tmpdir(),"docslurp-html-test-"));try{const input=path.join(dir,"input.html");await writeFile(input,"<script>".repeat(1000));await fn(input);}finally{await rm(dir,{recursive:true,force:true});}}
describe("HTML source inspection production boundary",()=>{
 it("refuses raw HTML on the host",()=>{vi.stubEnv("NODE_ENV","production");expect(()=>detectHtmlEmbeds("<iframe>")).toThrow(/VM/);});
 it("uses a VM for hostile source and validates the returned report",async()=>{vi.stubEnv("NODE_ENV","production");await fixture(async(input)=>{const run=vi.fn(async(plan)=>{await writeFile(plan.args[GUEST_NODE_FLAGS.length + 2],JSON.stringify({schemaVersion:"html-embeds@v1",items:[],counts:{},needsAttention:false}));return{stdout:"",stderr:""};});expect((await detectHtmlEmbedsFile(input,{run})).items).toEqual([]);expect(run).toHaveBeenCalledOnce();});});
 it("rejects malformed guest counts and VM failures",async()=>{vi.stubEnv("NODE_ENV","production");await fixture(async(input)=>{const run=vi.fn(async(plan)=>{await writeFile(plan.args[GUEST_NODE_FLAGS.length + 2],JSON.stringify({schemaVersion:"html-embeds@v1",items:[],counts:{iframe:999999},needsAttention:false}));return{stdout:"",stderr:""};});await expect(detectHtmlEmbedsFile(input,{run})).rejects.toThrow(/invalid HTML embed counts/);run.mockRejectedValue(new Error("revoked key"));await expect(detectHtmlEmbedsFile(input,{run})).rejects.toThrow(/revoked/);});});
});
