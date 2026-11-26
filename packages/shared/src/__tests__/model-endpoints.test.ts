import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TenantModelEndpointRefusedError,
  assertTenantModelBaseUrlAllowed,
  assertTenantModelEndpointAllowed,
  isLoopbackModelBaseUrl,
  modelEndpointOrigin,
  modelEndpointUrl,
  platformKeyForDestination,
  canonicalModelBaseUrl,
  storedModelEndpointRefusal,
  tenantLocalModelPorts,
  tenantModelEndpointProblem,
  tenantPipelineEndpointProblems,
  tenantSuppliedEndpointProblem,
} from "../model-endpoints.js";
import { visionProfileCatalog } from "../embedding.js";

/**
 * DocSlurp/app issue 101: a tenant-set model endpoint never receives a platform key, and tenant-set endpoints are
 * refused unless the operator allows loopback model servers. These are the pure rules every caller shares.
 */
const FLAG = "DOCSLURP_ALLOW_TENANT_LOCAL_MODEL_ENDPOINTS";
const uri = (provider: string, baseUrl?: string) =>
  `llm://${provider}/some-model${baseUrl === undefined ? "" : `?baseUrl=${encodeURIComponent(baseUrl)}`}`;

const INTERNAL_DESTINATIONS = [
  "http://127.0.0.1:6379",
  "http://localhost/v1",
  "http://[::1]:8080/v1",
  "http://169.254.169.254/latest/meta-data/",
  "http://10.0.0.5:8000/v1",
  "http://192.168.1.10/v1",
  "http://172.16.0.1/v1",
  "http://0x7f000001/v1",
  "http://2130706433/v1",
  "http://017700000001/v1",
  "http://127.1/v1",
  "http://[::ffff:127.0.0.1]/v1",
  "http://[fd12:3456:789a::3]:8080/v1",
  "http://service.internal.example:8080/v1",
  "http://metadata.google.internal/v1",
  "http://0.0.0.0:11434/v1",
];

afterEach(() => vi.unstubAllEnvs());

describe("tenant model endpoints in production configuration (flag off)", () => {
  it.each(["ollama", "vllm", "lmstudio"])("refuses every %s endpoint, with or without a baseUrl", (provider) => {
    vi.stubEnv(FLAG, "false");
    expect(tenantModelEndpointProblem(uri(provider))).toBe("tenant-local-endpoints-disabled");
    for (const destination of INTERNAL_DESTINATIONS) {
      expect(tenantModelEndpointProblem(uri(provider, destination)), destination).not.toBeNull();
      expect(() => assertTenantModelEndpointAllowed(uri(provider, destination)), destination).toThrow(TenantModelEndpointRefusedError);
    }
  });

  it("is off when the flag is unset", () => {
    vi.stubEnv(FLAG, "");
    expect(tenantModelEndpointProblem(uri("vllm", "http://127.0.0.1:8000/v1"))).toBe("tenant-local-endpoints-disabled");
  });

  it.each(["openai", "openrouter", "deepinfra", "perplexity", "acme"])("refuses a baseUrl on hosted provider %s", (provider) => {
    vi.stubEnv(FLAG, "true");
    for (const destination of ["https://evil.example/v1", "http://127.0.0.1:9/v1", "https://api.openai.com/v1"]) {
      expect(tenantModelEndpointProblem(uri(provider, destination))).toBe("tenant-base-url-not-allowed");
    }
    expect(tenantModelEndpointProblem(uri(provider))).toBeNull();
  });

  it("refuses an encoded or repeated baseUrl key", () => {
    vi.stubEnv(FLAG, "true");
    expect(tenantModelEndpointProblem("llm://openai/m?base%55rl=http%3A%2F%2F10.0.0.1")).toBe("tenant-base-url-not-allowed");
    expect(tenantModelEndpointProblem("llm://openai/m?BASEURL=http%3A%2F%2F10.0.0.1")).toBe("tenant-base-url-not-allowed");
    expect(tenantModelEndpointProblem(`llm://vllm/m?baseUrl=${encodeURIComponent("http://127.0.0.1:8000/v1")}&baseUrl=${encodeURIComponent("http://10.0.0.1/v1")}`)).toBe("tenant-base-url-not-loopback");
  });

  it("leaves operator-registered private routes and in-process runtimes alone", () => {
    vi.stubEnv(FLAG, "false");
    expect(tenantModelEndpointProblem("llm://private/gpu-a/model")).toBeNull();
    expect(tenantModelEndpointProblem("llm://transformers.js/Xenova/bge-m3")).toBeNull();
    expect(tenantModelEndpointProblem("llm://local-cli/florence")).toBeNull();
  });
});

describe("tenant model endpoints on a trusted single-tenant host (flag on)", () => {
  it("allows a literal loopback server for local providers", () => {
    vi.stubEnv(FLAG, "true");
    for (const destination of ["http://127.0.0.1:11434/v1", "http://localhost:1234/v1", "http://[::1]:8000/v1", "http://127.1:8000/v1"]) {
      expect(tenantModelEndpointProblem(uri("ollama", destination)), destination).toBeNull();
    }
    expect(tenantModelEndpointProblem(uri("ollama"))).toBeNull();
  });

  it("still refuses link-local, private, internal and look-alike hosts", () => {
    vi.stubEnv(FLAG, "true");
    for (const destination of [
      "http://169.254.169.254/latest/meta-data/",
      "http://10.0.0.5:8000/v1",
      "http://192.168.1.10/v1",
      "http://172.16.0.9:8000/v1",
      "http://[fd12:3456:789a::3]:8080/v1",
      "http://[::ffff:127.0.0.1]/v1",
      "http://service.internal.example:8080/v1",
      "http://localhost.evil.example/v1",
      "http://127.0.0.1.nip.io/v1",
      "http://0.0.0.0:11434/v1",
    ]) {
      expect(tenantModelEndpointProblem(uri("vllm", destination)), destination).toBe("tenant-base-url-not-loopback");
    }
    for (const destination of [
      "http://user:pass@localhost:8000/v1",
      "http://api.openai.com@127.0.0.1:8000/v1",
      "file:///etc/passwd",
      "ftp://127.0.0.1/v1",
      "not a url",
    ]) {
      expect(tenantModelEndpointProblem(uri("vllm", destination)), destination).toBe("tenant-base-url-invalid");
    }
  });

  it("checks a resolved profile's base URL the same way", () => {
    vi.stubEnv(FLAG, "true");
    expect(() => assertTenantModelBaseUrlAllowed("vllm", "http://127.0.0.1:8000/v1")).not.toThrow();
    expect(() => assertTenantModelBaseUrlAllowed("vllm", "http://169.254.169.254/v1")).toThrow(TenantModelEndpointRefusedError);
    expect(() => assertTenantModelBaseUrlAllowed("vllm", null)).not.toThrow();
    vi.stubEnv(FLAG, "false");
    expect(() => assertTenantModelBaseUrlAllowed("vllm", "http://127.0.0.1:8000/v1")).toThrow("Tenant-selected local model endpoints are disabled");
  });
});

describe("loopback detection", () => {
  it("accepts only the canonical loopback hosts, never credentials or other schemes", () => {
    expect(isLoopbackModelBaseUrl("http://127.0.0.1:11434/v1")).toBe(true);
    expect(isLoopbackModelBaseUrl("https://localhost/v1")).toBe(true);
    expect(isLoopbackModelBaseUrl("http://[::1]/v1")).toBe(true);
    expect(isLoopbackModelBaseUrl("http://user@localhost/v1")).toBe(false);
    expect(isLoopbackModelBaseUrl("http://localhost.:8000/v1")).toBe(false);
    expect(isLoopbackModelBaseUrl("ws://127.0.0.1/v1")).toBe(false);
    expect(isLoopbackModelBaseUrl("http://[::ffff:7f00:1]/v1")).toBe(false);
  });
});

describe("platform key grants match the provider base URL exactly", () => {
  const grant = { baseUrl: "https://api.openai.com/v1", key: "platform-openai-key" };

  it("sends the key to the provider's own origin", () => {
    expect(platformKeyForDestination("https://api.openai.com/v1", grant)).toBe("platform-openai-key");
    expect(platformKeyForDestination("https://API.OpenAI.com:443/v1/", grant)).toBe("platform-openai-key");
  });

  it.each([
    "https://api.openai.com.evil.example/v1",
    "https://api.openai.com@evil.example/v1",
    "https://user:pass@api.openai.com/v1",
    "https://api.openai.com:8443/v1",
    "http://api.openai.com/v1",
    "https://evil.example/api.openai.com/v1",
    "https://evil.example/v1?u=https://api.openai.com/v1",
    "http://127.0.0.1:8080/v1",
    "http://169.254.169.254/v1",
    "https://api.openai.com/other",
    "https://api.openai.com/v1?x=1",
    "https://api.openai.com/v1#f",
    "",
    "not a url",
  ])("sends no key to %s", (destination) => {
    expect(platformKeyForDestination(destination, grant)).toBe("");
  });

  it("sends no key when there is no destination or no grant", () => {
    expect(platformKeyForDestination(null, grant)).toBe("");
    expect(platformKeyForDestination("https://api.openai.com/v1", { baseUrl: "https://api.openai.com/v1", key: undefined })).toBe("");
    expect(platformKeyForDestination("https://api.openai.com/v1", { baseUrl: "garbage", key: "k" })).toBe("");
  });

  it("normalises origins", () => {
    expect(modelEndpointOrigin("https://OpenRouter.ai:443/api/v1")).toBe("https://openrouter.ai");
    expect(modelEndpointOrigin("https://u@openrouter.ai/api/v1")).toBeNull();
    expect(modelEndpointOrigin("javascript:alert(1)")).toBeNull();
  });
});

describe("pipeline admission covers every tenant model URI", () => {
  it("reports the embedding, vision and vision fallback routes", () => {
    vi.stubEnv(FLAG, "false");
    const problems = tenantPipelineEndpointProblems({
      embedding: { modelUri: uri("ollama", "http://127.0.0.1:11434/v1") },
      vision: { modelUri: "llm://openrouter/google/gemini-3.1-flash-lite", remoteFallbackModelUri: uri("vllm", "http://10.0.0.5/v1") },
    });
    expect(problems).toEqual([
      { path: "embedding.modelUri", code: "tenant-local-endpoints-disabled" },
      { path: "vision.remoteFallbackModelUri", code: "tenant-local-endpoints-disabled" },
    ]);
    expect(tenantPipelineEndpointProblems({ embedding: { modelUri: "llm://openrouter/perplexity/pplx-embed-v1-0.6b" } })).toEqual([]);
    expect(tenantPipelineEndpointProblems(null)).toEqual([]);
  });

  it("does not let one organization's setting change another's", () => {
    vi.stubEnv(FLAG, "false");
    const orgA = { embedding: { modelUri: uri("vllm", "http://169.254.169.254/v1") } };
    const orgB = { embedding: { modelUri: "llm://openrouter/perplexity/pplx-embed-v1-0.6b" } };
    expect(tenantPipelineEndpointProblems(orgA)).toHaveLength(1);
    expect(tenantPipelineEndpointProblems(orgB)).toEqual([]);
  });
});

describe("tenant loopback base URL shape, port and request URL (flag on)", () => {
  it.each([
    "http://127.0.0.1:8000/v1?",
    "http://127.0.0.1:8000/v1?q=",
    "http://127.0.0.1:8000/admin?x=/v1",
    "http://127.0.0.1:8000/v1#",
    "http://127.0.0.1:8000/v1#frag",
  ])("refuses a query or fragment: %s", (destination) => {
    vi.stubEnv(FLAG, "true");
    expect(tenantModelEndpointProblem(uri("vllm", destination))).toBe("tenant-base-url-invalid");
    expect(() => assertTenantModelBaseUrlAllowed("vllm", destination)).toThrow(TenantModelEndpointRefusedError);
  });

  it("keeps encoded query and fragment characters in the path, where the request URL keeps them too", () => {
    vi.stubEnv(FLAG, "true");
    for (const destination of ["http://127.0.0.1:8000/v1%3Fq%3D", "http://127.0.0.1:8000/v1%23frag"]) {
      expect(tenantModelEndpointProblem(uri("vllm", destination)), destination).toBeNull();
      const request = new URL(modelEndpointUrl(destination, "chat/completions"));
      expect(request.search).toBe("");
      expect(request.hash).toBe("");
      expect(request.pathname.endsWith("/chat/completions")).toBe(true);
    }
  });

  it("resolves dot segments (also percent-encoded) before the endpoint is appended", () => {
    expect(modelEndpointUrl("http://127.0.0.1:8000/v1/../../admin", "chat/completions")).toBe("http://127.0.0.1:8000/admin/chat/completions");
    expect(modelEndpointUrl("http://127.0.0.1:8000/v1/%2e%2e/%2E%2E/admin", "embeddings")).toBe("http://127.0.0.1:8000/admin/embeddings");
    expect(modelEndpointUrl("http://127.0.0.1:8000/v1/", "chat/completions")).toBe("http://127.0.0.1:8000/v1/chat/completions");
    expect(modelEndpointUrl("http://127.0.0.1:8000/v1/chat/completions", "chat/completions")).toBe("http://127.0.0.1:8000/v1/chat/completions");
    // An operator gateway's version query stays a query, after the path.
    expect(modelEndpointUrl("https://gateway.example/v1?api-version=2", "chat/completions")).toBe("https://gateway.example/v1/chat/completions?api-version=2");
  });

  it("allows only the standard local server ports unless the operator lists others", () => {
    vi.stubEnv(FLAG, "true");
    for (const port of [11434, 8000, 1234]) expect(tenantModelEndpointProblem(uri("vllm", `http://127.0.0.1:${port}/v1`)), String(port)).toBeNull();
    for (const destination of ["http://127.0.0.1:6379/v1", "http://127.0.0.1/v1", "https://localhost/v1", "http://[::1]:5432/v1"]) {
      expect(tenantModelEndpointProblem(uri("vllm", destination)), destination).toBe("tenant-base-url-port-not-allowed");
    }
    vi.stubEnv("DOCSLURP_TENANT_LOCAL_MODEL_PORTS", "8001, 8002");
    expect(tenantModelEndpointProblem(uri("vllm", "http://127.0.0.1:8001/v1"))).toBeNull();
    expect(tenantModelEndpointProblem(uri("vllm", "http://127.0.0.1:8000/v1"))).toBe("tenant-base-url-port-not-allowed");
    // A list with no valid port allows none (fail closed).
    vi.stubEnv("DOCSLURP_TENANT_LOCAL_MODEL_PORTS", "all");
    expect(tenantModelEndpointProblem(uri("vllm", "http://127.0.0.1:8000/v1"))).toBe("tenant-base-url-port-not-allowed");
  });
});

describe("the run-creation rule judges only a tenant-supplied endpoint", () => {
  it.each(Object.keys(visionProfileCatalog))("admits the %s vision profile's model with the flag off", (profile) => {
    vi.stubEnv(FLAG, "false");
    const config = visionProfileCatalog[profile as keyof typeof visionProfileCatalog].config;
    expect(tenantSuppliedEndpointProblem(config.modelUri)).toBeNull();
    expect(tenantPipelineEndpointProblems({ vision: { ...config } }, process.env, { rule: "run" })).toEqual([]);
  });

  it("still refuses a tenant baseUrl at run creation, and the profile's local route at call time", () => {
    vi.stubEnv(FLAG, "false");
    expect(tenantSuppliedEndpointProblem(uri("vllm", "http://127.0.0.1:8000/v1"))).toBe("tenant-local-endpoints-disabled");
    expect(tenantSuppliedEndpointProblem(uri("openai", "https://gateway.example/v1"))).toBe("tenant-base-url-not-allowed");
    expect(tenantSuppliedEndpointProblem("not a uri")).toBe("tenant-model-uri-invalid");
    // The call-time rule keeps refusing the profile's local server route while the flag is off.
    expect(tenantModelEndpointProblem(visionProfileCatalog["fastest-local"].config.modelUri)).toBe("tenant-local-endpoints-disabled");
    expect(() => assertTenantModelBaseUrlAllowed("vllm", null)).toThrow(TenantModelEndpointRefusedError);
    // The save rule is the call-time rule.
    expect(tenantPipelineEndpointProblems({ vision: { modelUri: visionProfileCatalog["fastest-local"].config.modelUri } }))
      .toEqual([{ path: "vision.modelUri", code: "tenant-local-endpoints-disabled" }]);
  });
});

describe("a local route with no baseUrl is judged at its default base URL", () => {
  it("refuses the default port when the operator's list leaves it out", () => {
    vi.stubEnv(FLAG, "true");
    expect(tenantModelEndpointProblem(uri("vllm"))).toBeNull();
    vi.stubEnv("DOCSLURP_TENANT_LOCAL_MODEL_PORTS", "11434");
    expect(tenantModelEndpointProblem(uri("vllm"))).toBe("tenant-base-url-port-not-allowed");
    expect(tenantModelEndpointProblem(uri("ollama"))).toBeNull();
    expect(() => assertTenantModelBaseUrlAllowed("vllm", null)).toThrow(TenantModelEndpointRefusedError);
    expect(() => assertTenantModelBaseUrlAllowed("lmstudio", "")).toThrow(TenantModelEndpointRefusedError);
    expect(() => assertTenantModelBaseUrlAllowed("ollama", undefined)).not.toThrow();
  });
});

describe("the port list", () => {
  it("unset means the standard ports; set but empty means none", () => {
    expect([...tenantLocalModelPorts({})].sort((a, b) => a - b)).toEqual([1234, 8000, 11434]);
    expect(tenantLocalModelPorts({ DOCSLURP_TENANT_LOCAL_MODEL_PORTS: "" }).size).toBe(0);
    expect(tenantLocalModelPorts({ DOCSLURP_TENANT_LOCAL_MODEL_PORTS: "  " }).size).toBe(0);
  });

  it("drops invalid entries and logs them once", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const env = { DOCSLURP_TENANT_LOCAL_MODEL_PORTS: "8000, 0, 70000, 8000-8100, abc, 1234" };
    expect([...tenantLocalModelPorts(env)].sort((a, b) => a - b)).toEqual([1234, 8000]);
    tenantLocalModelPorts(env);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain("8000-8100");
    warn.mockRestore();
  });
});

describe("the stored-row rule", () => {
  it("refuses only what no deployment setting could allow, in the spelling the resolver reads", () => {
    vi.stubEnv(FLAG, "true");
    vi.stubEnv("DOCSLURP_TENANT_LOCAL_MODEL_PORTS", "11434");
    // Shape refusals.
    expect(storedModelEndpointRefusal(uri("openai", "https://gateway.example/v1"))).toBe("tenant-base-url-not-allowed");
    expect(storedModelEndpointRefusal(uri("vllm", "http://10.0.0.5:8000/v1"))).toBe("tenant-base-url-not-loopback");
    expect(storedModelEndpointRefusal(uri("vllm", "http://127.0.0.1:8000/v1?x=1"))).toBe("tenant-base-url-invalid");
    // Operator decisions (port list, flag) are not: the row stays and is refused at call time.
    expect(storedModelEndpointRefusal(uri("vllm", "http://127.0.0.1:9999/v1"))).toBeNull();
    expect(storedModelEndpointRefusal(uri("vllm"))).toBeNull();
    vi.stubEnv(FLAG, "false");
    expect(storedModelEndpointRefusal(uri("vllm", "http://127.0.0.1:8000/v1"))).toBeNull();
    // A key the resolver never reads sends nothing anywhere, so it does not drop the setting.
    expect(storedModelEndpointRefusal("llm://openai/text-embedding-3-small?BASEURL=https%3A%2F%2Fgateway.example")).toBeNull();
    // Padded text is judged as the schema trims it.
    expect(storedModelEndpointRefusal(` ${uri("openai", "https://gateway.example/v1")}\u00a0`)).toBe("tenant-base-url-not-allowed");
  });
});

describe("tenant request base URL", () => {
  it("pins the name localhost to 127.0.0.1", () => {
    expect(canonicalModelBaseUrl("http://localhost:11434/v1/")).toBe("http://127.0.0.1:11434/v1");
    expect(canonicalModelBaseUrl("http://LOCALHOST:8000/v1")).toBe("http://127.0.0.1:8000/v1");
    expect(canonicalModelBaseUrl("http://[::1]:8000/v1")).toBe("http://[::1]:8000/v1");
  });
});

describe("refusal messages", () => {
  it("names the problem for a loopback URL with a query", async () => {
    const { embeddingConfigSchema } = await import("../embedding.js");
    const result = embeddingConfigSchema.safeParse({ modelUri: uri("vllm", "http://127.0.0.1:8000/v1?x=1") });
    expect(result.success).toBe(false);
    const message = result.success ? "" : result.error.issues.map((issue) => issue.message).join("\n");
    expect(message).toContain("no user info, query or fragment");
    expect(message).not.toContain("must use a loopback host");
  });
});
