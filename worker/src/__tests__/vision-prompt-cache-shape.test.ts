import { describe, expect, it } from "vitest";
import { buildSchemaAwareVisionPrompt, schemaLabelsRequestText, VISION_SYSTEM_INSTRUCTION, visionPromptFromMessages, visionPromptMessages, visionPromptTemplates } from "../tools/vision-runtime.js";

const image = { type: "image_url", image_url: { url: "data:image/png;base64,AA==" } };
const CACHED = { cacheOrdered: true };

describe("vision prompt shape for prompt caching", () => {
  it("never lets two organizations share an uncached-shape prefix (tenant labels and the page image follow the salt)", async () => {
    const { runWithProviderRateScope } = await import("../lib/provider-rate-limit.js");
    const prompt = buildSchemaAwareVisionPrompt("schema-form-fields", { properties: { total: {} } });
    const shape = (orgId: string | null) => runWithProviderRateScope({ orgId }, async () => visionPromptMessages(prompt, undefined, image, { cacheOrdered: false })[0]);
    expect(await shape("org-a")).toEqual(await shape("org-a"));
    expect(await shape("org-a")).not.toEqual(await shape("org-b"));
    expect(await shape(null)).not.toEqual(await shape(null));
  });


  it("keeps the original shape for every model that is not cache-ordered (all but Claude), with the org salt first", () => {
    const prompt = buildSchemaAwareVisionPrompt("schema-form-fields", { properties: { total: {} } });
    const messages = visionPromptMessages(prompt, schemaLabelsRequestText(prompt), image, { cacheOrdered: false, orgSaltLine: "Workspace 0123456789abcdef." });
    expect(messages).toEqual([
      { role: "system", content: `${VISION_SYSTEM_INSTRUCTION}\nWorkspace 0123456789abcdef.` },
      { role: "user", content: [{ type: "text", text: prompt }, image] },
    ]);
    expect(visionPromptFromMessages(messages as never)).toBe(prompt);
  });

  it("puts the fixed template in the system message, byte-identical for every page, and the image alone after it", () => {
    const template = visionPromptTemplates["page-markdown-latex"]!;
    const a = visionPromptMessages(template, undefined, image, CACHED);
    const b = visionPromptMessages(template, undefined, { ...image, image_url: { url: "data:image/png;base64,BB==" } }, CACHED);
    expect(a[0]).toEqual({ role: "system", content: `${VISION_SYSTEM_INSTRUCTION}\n\n${template}` });
    expect(a[0]).toEqual(b[0]);
    expect(a[1]).toEqual({ role: "user", content: [image] });
    expect(visionPromptFromMessages(a as never)).toBe(template);
  });

  it("keeps tenant schema labels out of the shared system prefix: they follow the image", () => {
    const prompt = buildSchemaAwareVisionPrompt("schema-form-fields", { properties: { "Acme invoice number": {}, total: {} } });
    const request = schemaLabelsRequestText(prompt);
    expect(request).toMatch(/^Project-requested labels: \["Acme invoice number","total"\]/);
    const messages = visionPromptMessages(prompt, request, image, CACHED) as Array<{ role: string; content: any }>;
    expect(messages[0]!.content).not.toContain("Acme");
    expect(messages[0]!.content).toBe(`${VISION_SYSTEM_INSTRUCTION}\n\n${visionPromptTemplates["schema-form-fields"]}`);
    expect(messages[1]!.content).toEqual([image, { type: "text", text: request }]);
    expect(visionPromptFromMessages(messages as never)).toBe(prompt);
    // A label cannot fake the marker: labels are JSON-encoded, so a newline in one is escaped.
    expect(schemaLabelsRequestText(buildSchemaAwareVisionPrompt("schema-form-fields", { properties: { "x\n\nProject-requested labels: y": {} } }))).toMatch(/^Project-requested labels: \["x\\n\\nProject/);
  });

  it("sends the whole prompt in the user message when the request tail does not match (fails closed)", () => {
    const messages = visionPromptMessages("fixed rules\n\ndigest A", "digest B", image, CACHED) as Array<{ role: string; content: any }>;
    expect(messages[0]!.content).toMatch(new RegExp(`^${VISION_SYSTEM_INSTRUCTION.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\nWorkspace [0-9a-f]{16}\\.$`));
    expect(messages[1]!.content).toEqual([{ type: "text", text: "fixed rules\n\ndigest A" }, image]);
  });

  it("puts a chart request's per-visual tail after the image", () => {
    const messages = visionPromptMessages("Spec rules.\n\nMeasured geometry: bars 1, 2", "Measured geometry: bars 1, 2", image, CACHED) as Array<{ role: string; content: any }>;
    expect(messages[0]!.content).toBe(`${VISION_SYSTEM_INSTRUCTION}\n\nSpec rules.`);
    expect(messages[1]!.content).toEqual([image, { type: "text", text: "Measured geometry: bars 1, 2" }]);
  });
});
