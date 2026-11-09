import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

function run(scenario) {
  const dir=mkdtempSync(join(process.env.TMPDIR??tmpdir(),"scanner-fetch-"));
  try {
    const bin=join(dir,"bin");mkdirSync(bin);
    writeFileSync(join(bin,"curl"),`#!/usr/bin/env node
const fs=require("node:fs");
const args=process.argv.slice(2), url=args.at(-1), output=args[args.indexOf("-o")+1];
fs.appendFileSync(process.env.ATTEMPTS,JSON.stringify(args)+"\\n");
const primary=url.startsWith("https://github.com/");
const fails=process.env.SCENARIO==="both-fail"||(primary&&["fallback","fallback-tamper"].includes(process.env.SCENARIO));
const tamper=(primary&&process.env.SCENARIO==="primary-tamper")||(!primary&&process.env.SCENARIO==="fallback-tamper");
fs.writeFileSync(output,tamper?"untrusted bytes":"verified scanner archive");
process.exit(fails?22:0);
`,{mode:0o755});
    const archive=join(dir,"archive with spaces.tgz"), attempts=join(dir,"attempts");
    const expected=createHash("sha256").update("verified scanner archive").digest("hex");
    const result=spawnSync("bash",["-c",'source "$1"; fetch "https://github.com/owner/repo/releases/download/v1/archive.tgz" "$2" "$3" "https://api.github.com/repos/owner/repo/releases/assets/1"; touch "$4"',"--",resolve("scripts/install-scanners.sh"),expected,archive,join(dir,"accepted")],{
      env:{...process.env,PATH:`${bin}:${process.env.PATH}`,TMPDIR:dir,SCENARIO:scenario,ATTEMPTS:attempts,GH_TOKEN:"fake",GITHUB_TOKEN:"fake"},encoding:"utf8",
    });
    return {status:result.status,stderr:result.stderr,accepted:existsSync(join(dir,"accepted")),attempts:readFileSync(attempts,"utf8").trim().split("\n").map(JSON.parse)};
  } finally {rmSync(dir,{recursive:true,force:true});}
}

test("verified primary archive needs no fallback",()=>{
  const result=run("primary");assert.equal(result.status,0);assert.equal(result.accepted,true);assert.equal(result.attempts.length,1);
});
test("download failure uses only the public asset API with bounded I/O and no credentials",()=>{
  const result=run("fallback");assert.equal(result.status,0);assert.equal(result.accepted,true);assert.equal(result.attempts.length,2);
  assert.equal(result.attempts[1].at(-1),"https://api.github.com/repos/owner/repo/releases/assets/1");
  assert.ok(result.attempts[1].includes("Accept: application/octet-stream"));
  for(const args of result.attempts){
    for(const [flag,value] of [["--connect-timeout","10"],["--max-time","60"],["--retry","2"],["--retry-max-time","60"]])assert.equal(args[args.indexOf(flag)+1],value);
    assert.doesNotMatch(args.join("\n"),/Authorization|fake/);
  }
});
test("both download routes failing cannot accept even complete-looking bytes",()=>{
  const result=run("both-fail");assert.notEqual(result.status,0);assert.equal(result.accepted,false);assert.equal(result.attempts.length,2);
});
test("primary checksum mismatch fails without attempting another route",()=>{
  const result=run("primary-tamper");assert.notEqual(result.status,0);assert.equal(result.accepted,false);assert.equal(result.attempts.length,1);assert.match(result.stderr,/checksum mismatch/);
});
test("fallback checksum mismatch fails closed",()=>{
  const result=run("fallback-tamper");assert.notEqual(result.status,0);assert.equal(result.accepted,false);assert.equal(result.attempts.length,2);assert.match(result.stderr,/checksum mismatch/);
});
