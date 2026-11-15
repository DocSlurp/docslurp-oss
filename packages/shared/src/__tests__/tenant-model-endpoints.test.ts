import { afterEach, expect, it, vi } from "vitest";
import { assertTenantModelEndpointAllowed } from "../embedding.js";

afterEach(() => vi.unstubAllEnvs());
it.each(["ollama", "vllm", "lmstudio"])("refuses tenant loopback routes for %s by default", (provider) => {
  vi.stubEnv("DOCSLURP_ALLOW_TENANT_LOCAL_MODEL_ENDPOINTS", "false");
  for (const destination of ["http://127.0.0.1:9000/v1", "http://localhost/v1", "http://[::1]/v1"]) {
    expect(() => assertTenantModelEndpointAllowed(`llm://${provider}/model?baseUrl=${encodeURIComponent(destination)}`)).toThrow("disabled");
  }
  vi.stubEnv("DOCSLURP_ALLOW_TENANT_LOCAL_MODEL_ENDPOINTS", "true");
  expect(() => assertTenantModelEndpointAllowed(`llm://${provider}/model`)).not.toThrow();
});
