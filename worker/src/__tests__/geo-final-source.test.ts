import { describe, expect, it } from "vitest";
import { acceptedGeoSource, beginGeoAttempt, geoDigest } from "../db/geo-final-source.js";
import { structuredResultEnvelopeSchema } from "@docslurp/shared";
const schema = { type: "object", properties: { "a/b": { type: "object", format: "geojson" } } };
const attempt = { documentId: "d", workspaceId: "w", orgId: "o", runId: "r", revision: "1", schemaDigest: geoDigest(schema) };
const result = () => structuredResultEnvelopeSchema.parse({ documentId: "d", schema: { name: "s", version: "1" },
  createdAt: new Date().toISOString(), overallPolicy: "auto-accept", fields: {
    "a/b": { value: { type: "Point", coordinates: [0,0] }, confidence: 1, policy: "auto-accept", errors: [], evidence: [] }
  } });
describe("accepted geo sources", () => {
  it("does not touch a database for ordinary columns", async () => {
    await expect(beginGeoAttempt(undefined as never, attempt, {type:"object", properties:{place:{type:"object"}}})).resolves.toBeUndefined();
  });
  it("keeps zero and escapes top-level pointers", () => {
    expect(acceptedGeoSource(attempt, schema, result()).features).toEqual([
      {fieldPath:"/a~1b", ordinal:0, geometry:{type:"Point", coordinates:[0,0]}}
    ]);
  });
  it("rejects review, rejection, wrong document and malformed geometry", () => {
    for (const change of [
      (r: ReturnType<typeof result>) => {r.fields["a/b"].policy="needs-review";},
      (r: ReturnType<typeof result>) => {r.overallPolicy="reject";},
      (r: ReturnType<typeof result>) => {r.documentId="other";},
      (r: ReturnType<typeof result>) => {r.fields["a/b"].value={type:"Polygon",coordinates:[[]]};},
    ]) { const r=result(); change(r); expect(() => acceptedGeoSource(attempt,schema,r)).toThrow(); }
  });
  it("does not turn optional null into a point", () => {
    const r=result();r.fields["a/b"].value=null;
    expect(acceptedGeoSource(attempt,schema,r).features).toEqual([]);
    const required={...schema,required:["a/b"]};
    expect(()=>acceptedGeoSource({...attempt,schemaDigest:geoDigest(required)},required,r)).toThrow();
  });
});
