import { describe, expect, it } from "vitest";

import { structuredSchemaFromJsonSchema } from "../stages/structured-extract.js";

describe("structuredSchemaFromJsonSchema", () => {
  it("converts the public JSON Schema contract into worker field definitions", () => {
    const schema = structuredSchemaFromJsonSchema({
      title: "Vessel inspection form",
      type: "object",
      properties: {
        vessel_registration: { type: "string", description: "Registration identifier" },
        inspection_date: { type: "string", format: "date" },
        capacity_code: { type: ["string", "null"], pattern: "^[0-9]{6}$" },
        inspection_type: {
          type: "string",
          enum: ["Annual", "Transfer", "Incident"],
        },
      },
      required: ["vessel_registration", "inspection_date", "capacity_code"],
    });

    expect(schema.name).toBe("Vessel inspection form");
    expect(Object.keys(schema.fields)).toEqual([
      "vessel_registration",
      "inspection_date",
      "capacity_code",
      "inspection_type",
    ]);
    expect(schema.fields.vessel_registration.validator.required).toBe(true);
    expect(schema.fields.inspection_date.type).toBe("date");
    expect(schema.fields.capacity_code.type).toBe("string");
    expect(schema.fields.capacity_code.validator.pattern).toBe("^[0-9]{6}$");
    expect(schema.fields.inspection_type.validator.enum).toEqual([
      "Annual",
      "Transfer",
      "Incident",
    ]);
  });
});
