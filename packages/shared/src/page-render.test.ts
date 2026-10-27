import { describe, expect, it } from "vitest";
import { pageRenderSlot, pageRenderWorkflowId, pageRenderDpi, pageRenderCapabilities } from "./page-render.js";
describe("quality-specific render identities", () => {
  const input = { documentId: "doc", runId: "run", pageNumber: 3 };
  it("keeps implicit reader requests stable while distinguishing export and old workflows", () => {
    expect(pageRenderWorkflowId(input)).toBe(pageRenderWorkflowId({ ...input, quality: "reader" }));
    expect(pageRenderWorkflowId(input)).not.toBe(pageRenderWorkflowId({ ...input, quality: "export" }));
    expect(pageRenderWorkflowId(input)).not.toBe("page-render:run:doc:3");
    expect(pageRenderSlot("doc",3)).not.toBe(pageRenderSlot("doc",3,"export"));
  });
});

it("keeps initial readers cheap and gives every organization the sharper export", () => {
  expect(pageRenderDpi("reader")).toBe(120);
  expect(pageRenderDpi("export")).toBe(250);
  expect(pageRenderCapabilities()).toEqual({
    sharperImage: true,
    exportDpi: 250,
  });
  expect(
    pageRenderWorkflowId({
      documentId: "doc",
      runId: "run",
      pageNumber: 1,
      quality: "export",
      dpi: 120,
    }),
  ).not.toBe(
    pageRenderWorkflowId({
      documentId: "doc",
      runId: "run",
      pageNumber: 1,
      quality: "export",
      dpi: 250,
    }),
  );
  expect(pageRenderSlot("doc", 1, "export", 120)).not.toBe(
    pageRenderSlot("doc", 1, "export", 250),
  );
});
