import { stateManagementPaths, stateManagementSchemas } from "./state-management-openapi.js";
import { configChangePaths } from "./config-change-openapi.js";
import { workspaceGraphPaths, workspaceGraphSchemas } from "./workspace-graph-openapi.js";
import { simpleServicePaths, simpleServiceSchemas } from "./simple-service-openapi.js";
import { webhookEventCatalog } from "./webhook-events.js";
import { searchCompatibilityPaths, searchCompatibilitySchemas } from "./search-compat-openapi.js";
import { apiKeySurfacePaths, keyOrSessionSecurity } from "./api-key-surface-openapi.js";
import { apiErrorOpenApiResponse, apiErrorSchema } from "./api-error-openapi.js";

export function buildOpenApiDocument(baseUrl: string) {
  return {
    openapi: "3.1.0",
    info: {
      title: "DocSlurp API",
      version: "0.1.0",
      description: "Document ingestion, retrieval, artifacts, and operational endpoints for the DocSlurp control plane."
    },
    servers: [
      {
        url: baseUrl
      }
    ],
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", description: "DocSlurp API key. Server keys start with dslp_priv_ and must stay secret; browser/embed client keys start with dslp_pub_, are domain-restricted and search-only unless granted chat (answers) or, with a workspace allowlist, web, ingest or artifacts. Keys issued before typed prefixes (dslp_...) remain valid." },
        sessionAuth: { type: "apiKey", in: "cookie", name: "better-auth.session_token", description: "Authenticated dashboard session" },
      },
      schemas: { ApiError: apiErrorSchema, ...simpleServiceSchemas, ...stateManagementSchemas, ...workspaceGraphSchemas, ...searchCompatibilitySchemas },
    },
    tags: [
      { name: "health" },
      { name: "runs" },
      { name: "workspaces" },
      { name: "organizations" },
      { name: "documents" },
      { name: "ingest" },
      { name: "search" },
      { name: "chat" },
      { name: "mcp" },
      { name: "webhooks" },
      { name: "artifacts" }
    ],
    paths: {
      ...searchCompatibilityPaths,
      "/health": {
        get: {
          tags: ["health"],
          summary: "Health check",
          responses: {
            "200": {
              description: "API availability",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      ok: { type: "boolean" },
                      service: { type: "string" }
                    }
                  }
                }
              }
            }
          }
        }
      },
      "/ready": {
        get: {
          tags: ["health"],
          summary: "Dependency readiness (database, migrations, storage, Temporal)",
          responses: {
            "200": { description: "Serving. `ok` is false when a non-critical dependency (Temporal) is down." },
            "503": { description: "A critical dependency (database, migrations or storage) failed." }
          }
        }
      },
      "/v1/runs": {
        get: {
          tags: ["runs"],
          summary: "List recent runs",
          security: keyOrSessionSecurity,
          parameters: [
            {
              in: "query",
              name: "userId",
              schema: { type: "string" }
            }
          ],
          responses: {
            "200": {
              description: "Recent workspace runs"
            }
          }
        }
      },
      "/v1/workspaces": {
        get: {
          tags: ["workspaces"],
          summary: "List workspaces",
          security: keyOrSessionSecurity,
          parameters: [
            { in: "query", name: "userId", schema: { type: "string" } }
          ],
          responses: {
            "200": { description: "Workspace list" }
          }
        },
        post: {
          tags: ["workspaces"],
          summary: "Create workspace",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    userId: { type: "string" },
                    name: { type: "string" },
                    templateKey: { type: "string" }
                  },
                  required: ["name"]
                }
              }
            }
          },
          responses: {
            "201": { description: "Workspace created" }
          }
        }
      },
      "/v1/mcp/manifest": {
        get: {
          tags: ["mcp"],
          summary: "Get the DocSlurp MCP manifest",
          responses: {
            "200": { description: "MCP manifest" },
            "401": { description: "Missing or invalid API key" }
          }
        }
      },
      "/v1/mcp/tools": {
        get: {
          tags: ["mcp"],
          summary: "List available MCP tools",
          responses: {
            "200": { description: "Tool catalog" }
          }
        }
      },
      "/v1/mcp/tools/{id}": {
        post: {
          tags: ["mcp"],
          summary: "Invoke an MCP tool over HTTP",
          parameters: [
            { in: "path", name: "id", required: true, schema: { type: "string" } }
          ],
          responses: {
            "202": { description: "Tool invocation accepted" },
            "404": { description: "Tool not found" }
          }
        }
      },
      "/v1/webhooks": {
        get: {
          tags: ["webhooks"],
          summary: "List configured webhooks",
          parameters: [
            { in: "query", name: "userId", schema: { type: "string" } }
          ],
          responses: {
            "200": { description: "Webhook list" }
          }
        },
        post: {
          tags: ["webhooks"],
          summary: "Create a webhook",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    userId: { type: "string" },
                    url: { type: "string", format: "uri" },
                    secret: { type: "string", minLength: 16 },
                    events: {
                      type: "array",
                      items: {
                        type: "string",
                        enum: webhookEventCatalog.map((event) => event.type)
                      }
                    }
                  },
                  required: ["url", "secret"]
                }
              }
            }
          },
          responses: {
            "201": { description: "Webhook created" }
          }
        }
      },
      "/v1/webhooks/catalog": {
        get: {
          tags: ["webhooks"],
          summary: "List webhook event types and sample payloads",
          responses: {
            "200": { description: "Webhook event catalog" }
          }
        }
      },
      "/v1/webhooks/{id}/test": {
        post: {
          tags: ["webhooks"],
          summary: "Send a synthetic test event to a webhook target",
          parameters: [
            { in: "path", name: "id", required: true, schema: { type: "string" } },
            { in: "query", name: "userId", schema: { type: "string" } }
          ],
          responses: {
            "200": { description: "Test delivery attempted" },
            "404": apiErrorOpenApiResponse("Webhook not found")
          }
        }
      },
      "/v1/artifacts/resolve": {
        get: {
          tags: ["artifacts"],
          summary: "Resolve a storage URI into a signed download URL",
          security: keyOrSessionSecurity,
          parameters: [
            { in: "query", name: "uri", required: true, schema: { type: "string" } }
          ],
          responses: {
            "200": { description: "Signed artifact URL" },
            "400": apiErrorOpenApiResponse("Missing artifact URI")
          }
        },
        post: {
          tags: ["artifacts"],
          summary: "Resolve multiple storage URIs in one request",
          security: keyOrSessionSecurity,
          responses: {
            "200": { description: "Signed artifact URLs" }
          }
        }
      },
      ...apiKeySurfacePaths,
      ...simpleServicePaths,
      ...stateManagementPaths,
      ...workspaceGraphPaths,
      ...configChangePaths,
    }
  };
}
