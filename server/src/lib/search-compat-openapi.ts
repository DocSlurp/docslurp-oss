const pagination = { type: "integer", minimum: 1, maximum: 100 };
const q = { type: "string", maxLength: 16000 };
const schemas = {
  MeilisearchQuery: { type: "object", additionalProperties: false, properties: { q, offset: { type: "integer", minimum: 0, maximum: 99 }, limit: pagination, page: pagination, hitsPerPage: pagination } },
  TypesenseQuery: { type: "object", required: ["q"], additionalProperties: false, properties: { q, query_by: { const: "text" }, page: pagination, per_page: pagination } },
  PagefindQuery: { type: "object", required: ["term"], additionalProperties: false, properties: { term: q, limit: pagination, filters: { type: "object", maxProperties: 0 } } },
};
export const searchCompatibilitySchemas = schemas;
const op = (schema: object, summary: string, parameters: object[] = []) => ({
  tags: ["search"], summary, security: [{ bearerAuth: [] }], parameters,
  description: "Search-side compatibility only. Window counts are bounded to 100 ranked passages, not exact corpus totals. Unsupported options return 400. Domain, organization, search scope and rate-limit controls apply. See /docs/search-integrations.",
  requestBody: { required: true, content: { "application/json": { schema } } },
  responses: { "200": { description: "Provider-style envelope with docslurp bounded-count, session, availability and usage metadata" }, "400": { description: "Invalid or unsupported options" }, "401": { description: "API key required" }, "403": { description: "Key scope/domain denied" }, "404": { description: "Project not accessible" }, "413": { description: "Body exceeds 64 KiB" }, "429": { description: "Rate limited" } },
});
const project = [{ in: "path", name: "projectId", required: true, description: "Index/collection name: project slug, former slug, UUID, or \"default\" for the API key organization default project.", schema: { type: "string" } }];
export const searchCompatibilityPaths = {
  "/compat/meilisearch/indexes/{projectId}/search": { post: op(schemas.MeilisearchQuery, "Meilisearch-compatible search", project), get: { ...op(schemas.MeilisearchQuery, "Meilisearch-compatible GET search", project), requestBody: undefined, parameters: [...project, ...Object.entries(schemas.MeilisearchQuery.properties).map(([name, schema]) => ({ in: "query", name, schema }))] } },
  "/compat/typesense/collections/{projectId}/documents/search": { post: op(schemas.TypesenseQuery, "Typesense-compatible search", project), get: { ...op(schemas.TypesenseQuery, "Typesense-compatible GET search", project), requestBody: undefined, parameters: [...project, ...Object.entries(schemas.TypesenseQuery.properties).map(([name, schema]) => ({ in: "query", name, required: name === "q", schema }))] } },
  "/compat/typesense/multi_search": { post: op({ type: "object", required: ["searches"], additionalProperties: false, properties: { searches: { type: "array", minItems: 1, maxItems: 10, items: { ...schemas.TypesenseQuery, required: ["collection", "q"], properties: { ...schemas.TypesenseQuery.properties, collection: { type: "string" } } } } } }, "Ordered Typesense batch search; all projects authorized before retrieval") },
  "/compat/pagefind/{projectId}/search": { post: op(schemas.PagefindQuery, "Pagefind-style JSON search (SDK supplies data() functions)", project) },
};
