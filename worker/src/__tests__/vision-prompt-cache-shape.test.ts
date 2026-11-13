import { describe, expect, it } from "vitest";
import { buildSchemaAwareVisionPrompt, schemaLabelsRequestText, VISION_SYSTEM_INSTRUCTION, visionPromptFromMessages, visionPromptMessages, visionPromptTemplates } from "../tools/vision-runtime.js";

const image = { type: "image_url", image_url: { url: "data:image/png;base64,AA==" } };

describe("vision prompt shape for prompt caching", () => {
  it("puts the fixed template in the system message, byte-identical for every page, and the image alone after it", () => {
    const template = visionPromptTemplates["page-markdown-latex"]!;
    const a = visionPromptMessages(template, undefined, image);
    const b = visionPromptMessages(template, undefined, { ...image, image_url: { url: "data:image/png;base64,BB==" } });
    expect(a[0]).toEqual({ role: "system", content: `${VISION_SYSTEM_INSTRUCTION}\n\n${template}` });
    expect(a[0]).toEqual(b[0]);
    expect(a[1]).toEqual({ role: "user", content: [image] });
    expect(visionPromptFromMessages(a as never)).toBe(template);
  });

  it("keeps tenant schema labels out of the shared system prefix: they follow the image", () => {
    const prompt = buildSchemaAwareVisionPrompt("schema-form-fields", { properties: { "Acme invoice number": {}, total: {} } });
    const request = schemaLabelsRequestText(prompt);
    expect(request).toMatch(/^Project-requested labels: \["Acme invoice number","total"\]/);
    const messages = visionPromptMessages(prompt, request, image) as Array<{ role: string; content: any }>;
    expect(messages[0]!.content).not.toContain("Acme");
    expect(messages[0]!.content).toBe(`${VISION_SYSTEM_INSTRUCTION}\n\n${visionPromptTemplates["schema-form-fields"]}`);
    expect(messages[1]!.content).toEqual([image, { type: "text", text: request }]);
    expect(visionPromptFromMessages(messages as never)).toBe(prompt);
    // A label cannot fake the marker: labels are JSON-encoded, so a newline in one is escaped.
    expect(schemaLabelsRequestText(buildSchemaAwareVisionPrompt("schema-form-fields", { properties: { "x\n\nProject-requested labels: y": {} } }))).toMatch(/^Project-requested labels: \["x\\n\\nProject/);
  });

  it("sends the whole prompt in the user message when the request tail does not match (fails closed)", () => {
    const messages = visionPromptMessages("fixed rules\n\ndigest A", "digest B", image) as Array<{ role: string; content: any }>;
    expect(messages[0]!.content).toBe(VISION_SYSTEM_INSTRUCTION);
    expect(messages[1]!.content).toEqual([{ type: "text", text: "fixed rules\n\ndigest A" }, image]);
  });

  it("puts a chart request's per-visual tail after the image", () => {
    const messages = visionPromptMessages("Spec rules.\n\nMeasured geometry: bars 1, 2", "Measured geometry: bars 1, 2", image) as Array<{ role: string; content: any }>;
    expect(messages[0]!.content).toBe(`${VISION_SYSTEM_INSTRUCTION}\n\nSpec rules.`);
    expect(messages[1]!.content).toEqual([image, { type: "text", text: "Measured geometry: bars 1, 2" }]);
  });
});
