import { readFile, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";

const guest = vi.hoisted(() => ({ hostCalls: 0 }));
vi.mock("./vision-tables-guest.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./vision-tables-guest.js")>();
  return {
    ...actual,
    // The host must never run the guest parser in the service profile.
    readVisionTablesBatch: vi.fn(() => { guest.hostCalls += 1; throw new Error("host HTML parser invoked"); }),
    __actual: actual,
  };
});

import * as guestModule from "./vision-tables-guest.js";
import { renderVisionTablePages, sanitizeVisionPageTables } from "./vision-tables-vm.js";

const actual = (guestModule as unknown as { __actual: typeof import("./vision-tables-guest.js") }).__actual;

/** A stand-in for the parser VM: runs the real guest on the job file, as the VM's node does. */
function vmRunner(transform?: (result: unknown[]) => unknown) {
  return {
    run: vi.fn(async (plan: { binary: string; args: string[] }) => {
      expect(plan.binary).toBe("node");
      expect(plan.args[0]).toMatch(/vision-tables\.mjs$/);
      const pages = JSON.parse(await readFile(plan.args[1]!, "utf8"));
      const result = actual.readVisionTablesBatch(pages);
      await writeFile(plan.args[2]!, JSON.stringify(transform ? transform(result) : result));
      return { stdout: "", stderr: "" };
    }),
  };
}

afterEach(() => { vi.unstubAllEnvs(); guest.hostCalls = 0; });

describe("service profile: model HTML tables are parsed only in the VM", () => {
  it("sends every page of a document to one VM job and renders the typed result", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const runner = vmRunner();
    const pages = Array.from({ length: 40 }, (_, i) => `Page ${i}\n\n<table><tr><th colspan="2">Q${i}</th></tr><tr><td>a</td><td>b</td></tr></table>`);
    const { texts, stats } = await sanitizeVisionPageTables([...pages, "no tables here"], runner, { documentId: "doc" });
    expect(runner.run).toHaveBeenCalledTimes(1);
    expect(stats).toMatchObject({ pages: 40, tables: 40, vmCalls: 1, escapedPages: 0 });
    expect(texts[3]).toBe('Page 3\n\n<table>\n<tbody>\n<tr><th colspan="2">Q3</th></tr>\n<tr><td>a</td><td>b</td></tr>\n</tbody>\n</table>');
    expect(texts[40]).toBe("no tables here");
    expect(guest.hostCalls).toBe(0);
  });

  it("DOCSLURP_SERVICE_PROFILE=service alone also refuses host parsing", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("DOCSLURP_SERVICE_PROFILE", "service");
    const { texts } = await sanitizeVisionPageTables(["<table><tr><td>x</td></tr></table>"], null);
    expect(texts[0]).toBe("&lt;table>&lt;tr>&lt;td>x&lt;/td>&lt;/tr>&lt;/table>");
    expect(guest.hostCalls).toBe(0);
  });

  it("fails closed to escaped text when the VM is unavailable or fails; never parses on the host", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const page = "Intro <table><tr><td>Revenue</td></tr></table> and <b>bold</b>";
    const escaped = "Intro &lt;table>&lt;tr>&lt;td>Revenue&lt;/td>&lt;/tr>&lt;/table> and <b>bold</b>";
    expect((await sanitizeVisionPageTables([page], null)).texts[0]).toBe(escaped);
    const failing = { run: vi.fn().mockRejectedValue(new Error("revoked key")) };
    const { texts, stats } = await sanitizeVisionPageTables([page], failing);
    expect(texts[0]).toBe(escaped);
    expect(stats.escapedPages).toBe(1);
    const short = vmRunner((result) => result.slice(1));
    expect((await sanitizeVisionPageTables([page, page], short)).texts).toEqual([escaped, escaped]);
    expect(guest.hostCalls).toBe(0);
  });
});

describe("host validation of the guest's result (a compromised or buggy guest)", () => {
  const page = "a<table><tr><td>x</td></tr></table>b";
  const escaped = "a&lt;table>&lt;tr>&lt;td>x&lt;/td>&lt;/tr>&lt;/table>b";
  const table = (rows: unknown, extra: unknown = []) => ({ k: "table", from: 1, to: 35, rows, extra });
  const forged: Array<[string, unknown]> = [
    ["gap in coverage", [{ k: "keep", from: 0, to: 1 }, { k: "keep", from: 2, to: 36 }]],
    ["overlap", [{ k: "keep", from: 0, to: 2 }, { k: "keep", from: 1, to: 36 }]],
    ["short coverage", [{ k: "keep", from: 0, to: 10 }]],
    ["lt on a non-< character", [{ k: "lt", from: 0, to: 1 }, { k: "keep", from: 1, to: 36 }]],
    ["table not at <table", [{ k: "table", from: 0, to: 35, rows: [], extra: [] }, { k: "keep", from: 35, to: 36 }]],
    ["span out of range", [{ k: "keep", from: 0, to: 1 }, table([{ head: false, cells: [{ h: false, rs: 1, cs: 101, t: "x" }] }]), { k: "keep", from: 35, to: 36 }]],
    ["fractional span", [{ k: "keep", from: 0, to: 1 }, table([{ head: false, cells: [{ h: false, rs: 1.5, cs: 1, t: "x" }] }]), { k: "keep", from: 35, to: 36 }]],
    ["oversized text", [{ k: "keep", from: 0, to: 1 }, table([{ head: false, cells: [{ h: false, rs: 1, cs: 1, t: "x".repeat(20_000) }] }]), { k: "keep", from: 35, to: 36 }]],
    ["unknown kind", [{ k: "html", from: 0, to: 36, html: "<script>" }]],
    ["claims no markup", null],
  ];
  for (const [name, result] of forged) {
    it(`escapes the page on ${name}`, () => {
      expect(renderVisionTablePages([page], [result])).toEqual([escaped]);
    });
  }
  it("guest strings are always escaped by the host, never copied as markup", () => {
    const out = renderVisionTablePages([page], [[
      { k: "keep", from: 0, to: 1 },
      table([{ head: false, cells: [{ h: false, rs: 1, cs: 1, t: '<script>alert(1)</script>"' }] }], ["<img src=x onerror=1>"]),
      { k: "keep", from: 35, to: 36 },
    ]])[0]!;
    expect(out).toBe("a\n\n<table>\n<tbody>\n<tr><td>&lt;script&gt;alert(1)&lt;/script&gt;&quot;</td></tr>\n</tbody>\n</table>\n\n\\<img src\\=x onerror\\=1\\>\n\nb");
  });
});
