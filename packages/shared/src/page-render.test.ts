import { describe, expect, it } from "vitest";
import { pageRenderSlot, pageRenderWorkflowId } from "./page-render.js";
describe("quality-specific render identities", () => {
  const input = { documentId: "doc", runId: "run", pageNumber: 3 };
  it("keeps implicit reader requests stable while distinguishing export and old workflows", () => {
    expect(pageRenderWorkflowId(input)).toBe(pageRenderWorkflowId({ ...input, quality: "reader" }));
    expect(pageRenderWorkflowId(input)).not.toBe(pageRenderWorkflowId({ ...input, quality: "export" }));
    expect(pageRenderWorkflowId(input)).not.toBe("page-render:run:doc:3");
    expect(pageRenderSlot("doc",3)).not.toBe(pageRenderSlot("doc",3,"export"));
  });
});
