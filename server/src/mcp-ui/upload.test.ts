import { readFileSync, readdirSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, "upload.html"), "utf8");

describe("upload widget bundle contract", () => {
  it("stays under 100 KB and is a single readable file", () => {
    expect(Buffer.byteLength(html)).toBeLessThan(100 * 1024);
    // Not minified: plenty of lines.
    expect(html.split("\n").length).toBeGreaterThan(300);
  });

  it("loads nothing from the network", () => {
    // No external script/link/img/iframe/source targets, no CSS url(), no @import.
    expect(html).not.toMatch(/<(script|link|img|iframe|source|video|audio|embed|object)\b[^>]*\b(src|href)\s*=\s*["']?(https?:)?\/\//i);
    expect(html).not.toMatch(/<script\b[^>]*\bsrc\s*=/i);
    expect(html).not.toMatch(/<link\b[^>]*\bhref\s*=/i);
    expect(html).not.toMatch(/url\(\s*["']?(https?:)?\/\//i);
    expect(html).not.toMatch(/@import/i);
    // The script never opens its own connections besides the presigned PUT XHR.
    expect(html).not.toMatch(/\bfetch\(|\bWebSocket\b|\bEventSource\b|sendBeacon|importScripts|new Worker\b/);
  });

  it("declares a restrictive meta CSP without eval or the API origin", () => {
    const csp = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/)?.[1] ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'unsafe-inline'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).not.toMatch(/connect-src(?:[^;]*\s)?\*(?:\s|;|$)/); // never a bare wildcard (loopback ports use host:*)
    expect(csp).not.toMatch(/frame-src|worker-src/);
    expect(html).not.toMatch(/\beval\(|new Function\(/);
  });

  it("speaks the MCP Apps methods the plan requires", () => {
    for (const method of [
      "ui/initialize",
      "ui/notifications/initialized",
      "ui/notifications/tool-result",
      "ui/notifications/host-context-changed",
      "ui/notifications/tool-cancelled",
      "ui/notifications/size-changed",
      "ui/resource-teardown",
      "ui/message",
      "ui/update-model-context",
      "tools/call",
    ]) {
      expect(html, method).toContain(method);
    }
    for (const tool of ["uploadEstimate", "upload", "completeUpload", "getUploadStatus"]) {
      expect(html, tool).toContain(`'${tool}'`);
    }
    expect(html).toContain("2026-01-26");
    expect(html).toContain("docslurp/origin");
  });

  it("never writes dynamic data as markup", () => {
    expect(html).not.toMatch(/\.(innerHTML|outerHTML)\s*[+]?=/);
    expect(html).not.toMatch(/insertAdjacentHTML|document\.write|createContextualFragment|srcdoc/);
    // No inline event-handler attributes in the static markup.
    expect(html).not.toMatch(/<[a-z][^>]*\son[a-z]+\s*=/i);
  });

  it("reads host theme variables with fallbacks", () => {
    expect(html).toContain("var(--color-background-primary");
    expect(html).toContain("prefers-color-scheme");
    expect(html).toContain("prefers-reduced-motion");
    expect(html).toContain("styles.variables");
  });
});

// ---------------------------------------------------------------- fake host flow (jsdom)

function findJsdom(): string | null {
  // jsdom is only present as a vitest peer in the pnpm store; resolve it from there when not a direct dependency.
  const require = createRequire(import.meta.url);
  try { return require.resolve("jsdom"); } catch { /* not a direct dependency */ }
  let dir = here;
  for (let i = 0; i < 8; i += 1) {
    const store = join(dir, "node_modules", ".pnpm");
    if (existsSync(store)) {
      const match = readdirSync(store).find((name) => /^jsdom@/.test(name));
      if (match) return join(store, match, "node_modules", "jsdom");
    }
    dir = resolve(dir, "..");
  }
  return null;
}

const jsdomPath = findJsdom();

type Rpc = { jsonrpc: "2.0"; id?: number; method?: string; params?: any; result?: any };

class FakeXhr {
  static all: FakeXhr[] = [];
  method = ""; url = ""; headers: Record<string, string> = {}; body: unknown = null; status = 0; aborted = false;
  upload: { onprogress: null | ((e: { loaded: number; total: number; lengthComputable: boolean }) => void) } = { onprogress: null };
  onload: null | (() => void) = null; onerror: null | (() => void) = null; ontimeout: null | (() => void) = null; onabort: null | (() => void) = null;
  constructor() { FakeXhr.all.push(this); }
  open(method: string, url: string) { this.method = method; this.url = url; }
  setRequestHeader(name: string, value: string) { this.headers[name] = value; }
  send(body: unknown) { this.body = body; }
  abort() { this.aborted = true; this.onabort?.(); }
  succeed() { this.status = 200; this.onload?.(); }
}

const FILE_IDS = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];
const SESSION_ID = "99999999-9999-4999-8999-999999999999";

async function boot(options: { framed?: boolean } = {}) {
  const { JSDOM } = require_(jsdomPath!);
  const sent: Rpc[] = [];
  const hostWindow = { postMessage: (message: Rpc) => { sent.push(message); } };
  let now = 1_000_000;
  const timers: Array<{ at: number; fn: () => void; id: number; cancelled: boolean }> = [];
  let timerId = 1;
  FakeXhr.all = [];

  const dom = new JSDOM(html, {
    runScripts: "dangerously",
    pretendToBeVisual: true, // document.hidden is true otherwise, which pauses polling
    url: "https://widget.test/",
    beforeParse(win: any) {
      if (options.framed !== false) Object.defineProperty(win, "parent", { value: hostWindow, configurable: true });
      win.XMLHttpRequest = FakeXhr;
      win.setTimeout = (fn: () => void, ms = 0) => { const t = { at: now + ms, fn, id: timerId++, cancelled: false }; timers.push(t); return t.id; };
      win.clearTimeout = (id: number) => { const t = timers.find((x) => x.id === id); if (t) t.cancelled = true; };
      win.requestAnimationFrame = (fn: () => void) => win.setTimeout(fn, 0);
    },
  });
  const win = dom.window;
  // The widget's Date is jsdom's own; drive it through a tiny shim so elapsed times are deterministic.
  const RealDate = win.Date;
  win.Date = class extends RealDate { static now() { return now; } };

  const doc = win.document as Document;
  const api = {
    win, doc, sent,
    text: () => doc.getElementById("app")!.textContent ?? "",
    live: () => doc.getElementById("live")!.textContent ?? "",
    button: (label: string | RegExp) => [...doc.querySelectorAll("button")].find((b) => (typeof label === "string" ? b.textContent === label : label.test(b.textContent ?? ""))) as HTMLButtonElement | undefined,
    deliver(message: Rpc) {
      const ev: any = new win.Event("message");
      ev.data = message; ev.source = hostWindow;
      win.dispatchEvent(ev);
    },
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const due = timers.filter((t) => !t.cancelled && t.at <= end).sort((a, b) => a.at - b.at || a.id - b.id)[0];
        if (!due) break;
        now = Math.max(now, due.at);
        due.cancelled = true;
        due.fn();
      }
      now = end;
    },
    async settle() { for (let i = 0; i < 5; i += 1) { await Promise.resolve(); } api.advance(0); await Promise.resolve(); api.advance(150); },
    requests: (method?: string) => sent.filter((m) => m.id !== undefined && m.method && (!method || m.method === method)),
    toolCalls: (name: string) => sent.filter((m) => m.method === "tools/call" && m.params?.name === name),
    answer(request: Rpc, result: unknown) { api.deliver({ jsonrpc: "2.0", id: request.id, result }); },
    answerTool(name: string, structuredContent: unknown, isError = false) {
      const pendingCall = api.toolCalls(name).filter((m) => !(m as any).answered).pop()!;
      (pendingCall as any).answered = true;
      api.answer(pendingCall, { content: [{ type: "text", text: JSON.stringify(structuredContent) }], structuredContent, isError });
    },
    pickFiles(files: Array<{ name: string; size: number; type?: string }>) {
      const picker = doc.getElementById("picker") as HTMLInputElement;
      const list = files.map((f) => {
        const file = new win.File([new Uint8Array(1)], f.name, { type: f.type ?? "application/pdf" });
        Object.defineProperty(file, "size", { value: f.size });
        return file;
      });
      Object.defineProperty(picker, "files", { value: list, configurable: true });
      picker.dispatchEvent(new win.Event("change"));
    },
  };
  return api;
}

const require_ = createRequire(import.meta.url) as (id: string) => any;

async function handshake(api: Awaited<ReturnType<typeof boot>>, hostContext: Record<string, unknown> = {}) {
  const init = api.requests("ui/initialize")[0]!;
  api.answer(init, { protocolVersion: "2026-01-26", hostInfo: { name: "fake", version: "1" }, hostCapabilities: { message: {}, updateModelContext: {} }, hostContext });
  api.deliver({
    jsonrpc: "2.0", method: "ui/notifications/tool-result",
    params: {
      content: [{ type: "text", text: "{}" }],
      structuredContent: {
        workspace: { id: "ws_1", slug: "default", name: "Default workspace", isDefault: true },
        workspaces: [{ id: "ws_1", slug: "default", name: "Default workspace", isDefault: true }],
        limits: { maxFiles: 10, maxFileBytes: 5 * 1024 ** 3 },
        uploader: { resourceUri: "ui://docslurp/upload" },
      },
    },
  });
  await api.settle();
}

function statusReport(over: Record<string, any> = {}) {
  const base = {
    files: { total: 2, byStatus: { completed: 0, processing: 2, queued: 0, failed: 0, other: 0 },
      items: [
        { documentId: "d1", filename: "a.pdf", mimeType: "application/pdf", status: "processing", pages: 4, searchablePages: 0, error: null },
        { documentId: "d2", filename: "b.pdf", mimeType: "application/pdf", status: "processing", pages: 6, searchablePages: 0, error: null },
      ] },
    run: { id: "run_1", status: "processing", durationMs: null },
    pages: { total: 10 },
    searchability: { searchablePages: 4, unsearchablePages: 0, pendingPages: 6, byReason: [] },
    performance: { costCents: 21, computeEstimated: false, pagesPerMinute: 74, minutesPer100Pages: 1.35 },
  };
  return { tool: "getUploadStatus", summary: "", report: { ...base, ...over } };
}

describe.skipIf(!jsdomPath)("upload widget with a fake MCP Apps host", () => {
  it("runs init -> pick -> estimate -> upload -> PUT -> complete -> poll -> done -> ui/message", async () => {
    const api = await boot();

    // ui/initialize carries appInfo, appCapabilities and the protocol version; initialized follows the answer.
    const init = api.requests("ui/initialize")[0]!;
    expect(init.params).toMatchObject({ protocolVersion: "2026-01-26", appInfo: { name: expect.any(String), version: expect.any(String) }, appCapabilities: {} });
    expect(api.text()).toContain("Connecting");
    await handshake(api, {
      theme: "dark",
      styles: { variables: { "--color-background-primary": "#101010", "not a var": "x", "--bad;": "y" } },
    });
    expect(api.sent.some((m) => m.method === "ui/notifications/initialized")).toBe(true);

    // Host theme lands on :root; junk keys are ignored.
    const root = api.doc.documentElement;
    expect(root.getAttribute("data-theme")).toBe("dark");
    expect(root.style.getPropertyValue("--color-background-primary")).toBe("#101010");
    expect(root.style.getPropertyValue("not a var")).toBe("");

    expect(api.text()).toContain("Upload to");
    expect(api.text()).toContain("Default workspace");
    expect(api.text()).toContain("10 files per upload, 5 GiB each");

    // Pick two files: the confirm view shows them and requests an estimate.
    api.pickFiles([{ name: "a.pdf", size: 300_000 }, { name: "b.pdf", size: 450_000 }]);
    await api.settle();
    expect(api.text()).toContain("a.pdf");
    expect(api.text()).toContain("Upload 2 files");
    const est = api.toolCalls("uploadEstimate")[0]!;
    expect(est.params.arguments).toEqual({ workspace: "ws_1", files: [{ name: "a.pdf", size: 300_000 }, { name: "b.pdf", size: 450_000 }] });
    expect(est.params._meta).toMatchObject({ "docslurp/origin": "mcp-app-upload", "docslurp/widgetVersion": "1" });
    api.answerTool("uploadEstimate", {
      estimate: { pages: 10, documents: 2, billing: "enforced", credits: { low: 21, high: 34 }, seconds: { low: 60, high: 120 }, basis: "Estimated from file size." },
      billing: "enforced",
    });
    await api.settle();
    expect(api.text()).toContain("≈ 10");
    expect(api.text()).toContain("21–34");
    expect(api.text()).toContain("Estimated from file size.");

    // Upload: the exact declared metadata goes to the upload tool, never the bytes.
    api.button("Upload 2 files")!.click();
    await api.settle();
    const upload = api.toolCalls("upload")[0]!;
    expect(upload.params.arguments).toEqual({
      workspace: "ws_1",
      files: [
        { filename: "a.pdf", mimeType: "application/pdf", sizeBytes: 300_000 },
        { filename: "b.pdf", mimeType: "application/pdf", sizeBytes: 450_000 },
      ],
    });
    expect(api.text()).toContain("Uploading");

    // Answer in reverse order: descriptors are matched by name and size, not position.
    api.answerTool("upload", {
      sessionId: SESSION_ID, status: "pending",
      files: [
        { id: FILE_IDS[1], filename: "b.pdf", mimeType: "application/pdf", sizeBytes: 450_000, mode: "single", method: "PUT", headers: { "Content-Type": "application/pdf" }, putUrl: "https://bucket.storage.test/b?sig=2" },
        { id: FILE_IDS[0], filename: "a.pdf", mimeType: "application/pdf", sizeBytes: 300_000, mode: "single", method: "PUT", headers: { "Content-Type": "application/pdf" }, putUrl: "https://bucket.storage.test/a?sig=1" },
      ],
    });
    await api.settle();
    expect(FakeXhr.all.map((x) => [x.method, x.url, x.headers["Content-Type"]])).toEqual([
      ["PUT", "https://bucket.storage.test/a?sig=1", "application/pdf"],
      ["PUT", "https://bucket.storage.test/b?sig=2", "application/pdf"],
    ]);

    // Progress is reflected in a progressbar.
    FakeXhr.all[0]!.upload.onprogress?.({ loaded: 150_000, total: 300_000, lengthComputable: true });
    await api.settle();
    const bar = api.doc.querySelector("[role=progressbar]")!;
    expect(bar.getAttribute("aria-valuenow")).toBe("150000");
    expect(bar.getAttribute("aria-valuemax")).toBe("750000");

    FakeXhr.all[0]!.succeed();
    FakeXhr.all[1]!.succeed();
    await api.settle();
    const complete = api.toolCalls("completeUpload")[0]!;
    expect(complete.params.arguments).toEqual({ sessionId: SESSION_ID, fileIds: [FILE_IDS[0], FILE_IDS[1]] });

    api.answerTool("completeUpload", {
      workspace: { id: "ws_1", slug: "default", name: "Default workspace" },
      run: { id: "run_1", status: "processing" },
      documents: [{ id: "d1" }, { id: "d2" }],
      warnings: [],
    });
    await api.settle();

    // Model context is updated without URLs or tokens.
    const ctx = api.requests("ui/update-model-context")[0]!;
    expect(ctx.params.structuredContent).toMatchObject({ workspace: { id: "ws_1" }, runId: "run_1" });
    expect(JSON.stringify(ctx.params)).not.toMatch(/sig=|putUrl|https?:\/\//);

    // First status poll: still processing.
    const poll1 = api.toolCalls("getUploadStatus")[0]!;
    expect(poll1.params.arguments).toEqual({ workspace: "ws_1", runId: "run_1" });
    api.answerTool("getUploadStatus", statusReport());
    await api.settle();
    expect(api.text()).toContain("Processing in");
    expect(api.text()).toContain("4");
    expect(api.text()).toContain("of 10");
    expect(api.text()).toContain("74");
    expect(api.text()).toContain("$0.21");
    const progress = api.doc.querySelector("[role=progressbar]")!;
    expect(progress.getAttribute("aria-valuetext")).toBe("4 of 10 pages searchable");
    expect(api.button("Ask about these files")).toBeTruthy();

    // Backoff: nothing is sent before ~2 s, a poll follows after.
    const before = api.toolCalls("getUploadStatus").length;
    api.advance(1700);
    expect(api.toolCalls("getUploadStatus").length).toBe(before);
    api.advance(400);
    expect(api.toolCalls("getUploadStatus").length).toBe(before + 1);

    // Terminal status.
    api.answerTool("getUploadStatus", statusReport({
      files: { total: 2, byStatus: { completed: 2, processing: 0, queued: 0, failed: 0, other: 0 },
        items: [
          { documentId: "d1", filename: "a.pdf", mimeType: "application/pdf", status: "completed", pages: 4, searchablePages: 4, error: null },
          { documentId: "d2", filename: "b.pdf", mimeType: "application/pdf", status: "completed", pages: 6, searchablePages: 6, error: null },
        ] },
      run: { id: "run_1", status: "completed", durationMs: 114_000 },
      searchability: { searchablePages: 10, unsearchablePages: 0, pendingPages: 0, byReason: [] },
    }));
    await api.settle();
    expect(api.text()).toContain("Ready in");
    expect(api.text()).toContain("1m 54s");
    expect(api.text()).toContain("pages searchable");
    const polls = api.toolCalls("getUploadStatus").length;
    api.advance(60_000);
    expect(api.toolCalls("getUploadStatus").length).toBe(polls); // polling stopped
    expect(api.requests("ui/update-model-context").length).toBeGreaterThanOrEqual(2);

    // Hand-off to the chat.
    api.button("Ask about these files")!.click();
    await api.settle();
    const message = api.requests("ui/message")[0]!;
    expect(message.params.role).toBe("user");
    expect(message.params.content[0]).toMatchObject({ type: "text" });
    expect(message.params.content[0].text).toContain("a.pdf");
    api.answer(message, {});
    await api.settle();
    expect(api.text()).toContain("Message sent");
  });

  it("shows a plain message when no host answers", async () => {
    const api = await boot();
    expect(api.text()).toContain("Connecting");
    api.advance(5100);
    expect(api.text()).toContain("MCP Apps");
    // A late answer still recovers.
    await handshake(api);
    expect(api.text()).toContain("Upload to");
  });

  it("shows a plain message when not framed at all", async () => {
    const api = await boot({ framed: false });
    expect(api.text()).toContain("MCP Apps");
    expect(api.requests("ui/initialize").length).toBe(0);
  });

  it("renders untrusted names as text and never as elements", async () => {
    const api = await boot();
    await handshake(api);
    const evil = `<img src=x onerror="window.pwned=1">.pdf`;
    api.pickFiles([{ name: evil, size: 1000 }]);
    await api.settle();
    expect(api.text()).toContain(evil);
    expect(api.doc.querySelector("#app img")).toBeNull();
    expect((api.win as any).pwned).toBeUndefined();
  });

  it("flags oversize and empty files and caps the file count", async () => {
    const api = await boot();
    await handshake(api);
    api.pickFiles([{ name: "huge.mp4", size: 6 * 1024 ** 3 }, { name: "empty.txt", size: 0 }, { name: "ok.pdf", size: 5000 }]);
    await api.settle();
    expect(api.text()).toContain("Over the 5 GiB limit");
    expect(api.text()).toContain("Empty file");
    expect(api.button("Upload 1 file")).toBeTruthy();
    expect(api.toolCalls("uploadEstimate")[0]!.params.arguments.files).toEqual([{ name: "ok.pdf", size: 5000 }]);

    api.button("Clear")!.click();
    await api.settle();
    api.pickFiles(Array.from({ length: 13 }, (_, i) => ({ name: `f${i}.pdf`, size: 100 + i })));
    await api.settle();
    expect(api.button("Upload 10 files")).toBeTruthy();
    expect(api.text()).toContain("3 files not added");
  });

  it("reports a blocked PUT (network/CORS) as a whole-widget alert and nothing is completed", async () => {
    const api = await boot();
    await handshake(api);
    api.pickFiles([{ name: "a.pdf", size: 1000 }]);
    await api.settle();
    api.button("Upload 1 file")!.click();
    await api.settle();
    api.answerTool("upload", {
      sessionId: SESSION_ID, status: "pending",
      files: [{ id: FILE_IDS[0], filename: "a.pdf", mimeType: "application/pdf", sizeBytes: 1000, mode: "single", method: "PUT", headers: { "Content-Type": "application/pdf" }, putUrl: "https://bucket.storage.test/a?sig=1" }],
    });
    await api.settle();
    FakeXhr.all[0]!.onerror?.();
    await api.settle();
    expect(api.doc.querySelector("[role=alert]")!.textContent).toContain("blocked the direct upload");
    expect(api.toolCalls("completeUpload").length).toBe(0);
    api.button("Try again")!.click();
    await api.settle();
    expect(api.text()).toContain("Upload 1 file");
  });

  it("shows a tool error from upload and survives a failed estimate", async () => {
    const api = await boot();
    await handshake(api);
    api.pickFiles([{ name: "a.pdf", size: 1000 }]);
    await api.settle();
    api.answerTool("uploadEstimate", { error: "Estimate unavailable" }, true);
    await api.settle();
    expect(api.text()).toContain("to upload"); // falls back to bytes as the primary figure
    api.button("Upload 1 file")!.click();
    await api.settle();
    api.answerTool("upload", { error: "Insufficient credits <b>x</b>" }, true);
    await api.settle();
    const alert = api.doc.querySelector("[role=alert]")!;
    expect(alert.textContent).toContain("Insufficient credits <b>x</b>");
    expect(alert.querySelector("b b")).toBeNull();
  });

  it("cancels an upload in flight without completing it", async () => {
    const api = await boot();
    await handshake(api);
    api.pickFiles([{ name: "a.pdf", size: 1000 }]);
    await api.settle();
    api.button("Upload 1 file")!.click();
    await api.settle();
    api.answerTool("upload", {
      sessionId: SESSION_ID, status: "pending",
      files: [{ id: FILE_IDS[0], filename: "a.pdf", mimeType: "application/pdf", sizeBytes: 1000, mode: "single", method: "PUT", headers: { "Content-Type": "application/pdf" }, putUrl: "https://bucket.storage.test/a" }],
    });
    await api.settle();
    api.button("Cancel")!.click();
    await api.settle();
    expect(FakeXhr.all[0]!.aborted).toBe(true);
    expect(api.text()).toContain("Upload cancelled");
    expect(api.toolCalls("completeUpload").length).toBe(0);
  });

  it("keeps the primary action on a partial failure and lists the failed file", async () => {
    const api = await boot();
    await handshake(api);
    api.pickFiles([{ name: "a.pdf", size: 1000 }, { name: "b.mp4", size: 2000, type: "video/mp4" }]);
    await api.settle();
    api.button("Upload 2 files")!.click();
    await api.settle();
    api.answerTool("upload", {
      sessionId: SESSION_ID, status: "pending",
      files: [
        { id: FILE_IDS[0], filename: "a.pdf", mimeType: "application/pdf", sizeBytes: 1000, mode: "single", headers: { "Content-Type": "application/pdf" }, putUrl: "https://bucket.storage.test/a" },
        { id: FILE_IDS[1], filename: "b.mp4", mimeType: "video/mp4", sizeBytes: 2000, mode: "single", headers: { "Content-Type": "video/mp4" }, putUrl: "https://bucket.storage.test/b" },
      ],
    });
    await api.settle();
    FakeXhr.all.forEach((x) => x.succeed());
    await api.settle();
    api.answerTool("completeUpload", { workspace: { id: "ws_1", name: "Default workspace" }, run: { id: "run_1" }, documents: [{}, {}] });
    await api.settle();
    api.answerTool("getUploadStatus", statusReport({
      files: { total: 2, byStatus: { completed: 1, processing: 0, queued: 0, failed: 1, other: 0 },
        items: [
          { documentId: "d1", filename: "a.pdf", mimeType: "application/pdf", status: "completed", pages: 4, searchablePages: 4, error: null },
          { documentId: "d2", filename: "b.mp4", mimeType: "video/mp4", status: "failed", pages: null, searchablePages: null, error: "Failed during transcribe" },
        ] },
      run: { id: "run_1", status: "completed", durationMs: 40_000 },
      pages: { total: 4 }, searchability: { searchablePages: 4, unsearchablePages: 0, pendingPages: 0, byReason: [] },
    }));
    await api.settle();
    expect(api.text()).toContain("b.mp4");
    expect(api.text()).toContain("Failed during transcribe");
    expect(api.button("Ask about the 1 indexed file")).toBeTruthy();
    expect(api.button("Re-upload b.mp4")).toBeTruthy();
    api.button("Re-upload b.mp4")!.click();
    await api.settle();
    expect(api.text()).toContain("Upload 1 file");
  });

  it("degrades without files.items, and tolerates a cancelled tool call", async () => {
    const api = await boot();
    await handshake(api);
    api.pickFiles([{ name: "a.pdf", size: 1000 }]);
    await api.settle();
    api.button("Upload 1 file")!.click();
    await api.settle();
    api.answerTool("upload", {
      sessionId: SESSION_ID, status: "pending",
      files: [{ id: FILE_IDS[0], filename: "a.pdf", mimeType: "application/pdf", sizeBytes: 1000, mode: "single", headers: { "Content-Type": "application/pdf" }, putUrl: "https://bucket.storage.test/a" }],
    });
    await api.settle();
    FakeXhr.all[0]!.succeed();
    await api.settle();
    api.answerTool("completeUpload", { workspace: { id: "ws_1", name: "Default workspace" }, run: { id: "run_1" }, documents: [{}] });
    await api.settle();
    api.answerTool("getUploadStatus", {
      report: {
        files: { total: 1, byStatus: { completed: 0, processing: 0, queued: 0, failed: 1, other: 0 } },
        pages: { total: 0 }, searchability: { searchablePages: 0, unsearchablePages: 0, pendingPages: 0 }, performance: { costCents: null, pagesPerMinute: null },
      },
    });
    await api.settle();
    expect(api.text()).toContain("1 file failed");
    expect(api.text()).not.toContain("$");
    expect(api.button(/^Ask about/)).toBeUndefined();

    const other = await boot();
    other.deliver({ jsonrpc: "2.0", method: "ui/notifications/tool-cancelled", params: { reason: "user action" } });
    await other.settle();
    expect(other.text()).toContain("cancelled");
  });

  it("answers ping and teardown requests and stops polling", async () => {
    const api = await boot();
    await handshake(api);
    api.deliver({ jsonrpc: "2.0", id: 77, method: "ping" });
    api.deliver({ jsonrpc: "2.0", id: 78, method: "ui/resource-teardown", params: {} });
    api.deliver({ jsonrpc: "2.0", id: 79, method: "nope/unknown" });
    expect(api.sent.find((m) => m.id === 77)).toMatchObject({ result: {} });
    expect(api.sent.find((m) => m.id === 78)).toMatchObject({ result: {} });
    expect((api.sent.find((m) => m.id === 79) as any).error.code).toBe(-32601);
  });

  it("merges host-context-changed into the theme", async () => {
    const api = await boot();
    await handshake(api, { theme: "light" });
    expect(api.doc.documentElement.getAttribute("data-theme")).toBe("light");
    api.deliver({ jsonrpc: "2.0", method: "ui/notifications/host-context-changed", params: { theme: "dark", styles: { variables: { "--font-sans": "Georgia" } } } });
    expect(api.doc.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(api.doc.documentElement.style.getPropertyValue("--font-sans")).toBe("Georgia");
  });
});
