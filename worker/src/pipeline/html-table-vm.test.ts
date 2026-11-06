import { readFile, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withPreparedHtmlTables, preparedHtmlTableCells } from "./html-table-vm.js";
import { tableChunks } from "./table-chunking.js";
const local = vi.hoisted(() => vi.fn(() => { throw new Error("host HTML parser invoked"); }));
vi.mock("./table-cells-guest.js", () => ({ readTableCells: local }));
afterEach(() => { vi.unstubAllEnvs(); local.mockClear(); });
const source = (name: string) => `<table><tr><td>${name.repeat(80)}</td></tr></table>`;
function runner(invalid = false) { return { run: vi.fn(async (plan) => {
 const batch: string[] = JSON.parse(await readFile(plan.args[1], "utf8"));
 const cells = batch.map(s => [{ label: invalid ? "hostile\nlabel" : "row 1 column 1 rowspan 1 colspan 1", value: s.includes("tenantA") ? "tenantA".repeat(80) : "tenantB".repeat(80) }]);
 await writeFile(plan.args[2], JSON.stringify(cells));
 return { stdout: "", stderr: "" };
}) }; }
describe("production HTML table boundary", () => {
 it("requires VM precomputation instead of invoking a local parser", () => {
  vi.stubEnv("NODE_ENV", "production"); expect(() => [...tableChunks(source("tenantA"), 128, 1)]).toThrow(/VM precomputation/); expect(local).not.toHaveBeenCalled();
 });
 it("preserves table records with independently scoped concurrent document contexts", async () => {
  vi.stubEnv("NODE_ENV", "production"); const a=source("tenantA"), b=source("tenantB"); const r=runner();
  const run=(s:string,other:string)=>withPreparedHtmlTables([s],r,async()=>{await Promise.resolve();expect(preparedHtmlTableCells(other)).toBeUndefined();return [...tableChunks(s,128,1)].join("\n");});
  const [one,two]=await Promise.all([run(a,b),run(b,a)]);expect(one).toContain("tenantA");expect(one).not.toContain("tenantB");expect(two).toContain("tenantB");expect(local).not.toHaveBeenCalled();
 });
 it("rejects hostile guest labels and missing VM credentials without fallback", async () => {
  vi.stubEnv("NODE_ENV", "production");await expect(withPreparedHtmlTables([source("tenantA")],runner(true),()=>[])).rejects.toThrow(/invalid HTML table cell/);
  const run=vi.fn().mockRejectedValue(new Error("revoked key"));await expect(withPreparedHtmlTables([source("tenantA")],{run},()=>[])).rejects.toThrow(/revoked/);expect(local).not.toHaveBeenCalled();
 });
});
