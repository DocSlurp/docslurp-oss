import {expect,it} from "vitest";
import {searchInputSchema,searchOptions,workspaceChatInputSchema} from "../lib/search-input.js";
import {toolInputJsonSchema} from "../services/mcp-tool-schemas.js";
import {geoPredicateSchema} from "@docslurp/shared";
const geo = {field:"site",op:"radius" as const,center:[0,0] as [number,number],radiusMeters:1000};
it("search, chat and MCP expose the same typed spatial input",()=>{
 const input=searchInputSchema.parse({q:"road",geo});
 expect(searchOptions({...input,workspaceId:"w"}).filters.geo).toEqual(geo);
 expect(workspaceChatInputSchema.parse({q:"road",filters:{geo}}).filters?.geo).toEqual(geo);
 const advertised=toolInputJsonSchema(searchInputSchema);
 expect(JSON.stringify(advertised)).toContain('radiusMeters');
 expect(JSON.stringify(advertised)).toContain('bbox');
 expect(JSON.stringify(advertised)).toContain('MultiPolygon');
 expect(JSON.stringify(advertised)).toContain('coordinates');
});
it.each([
 {...geo,center:[91,181]}, {...geo,radiusMeters:-1}, {...geo,extra:true},
 {field:"site",op:"within",geometry:{type:"Polygon",coordinates:[[]]}},
 {field:"site",op:"bbox",bbox:[0,5,2,1]},
])("rejects malicious or unsupported predicate %j",value=>{
 expect(geoPredicateSchema.safeParse(value).success).toBe(false);
});
