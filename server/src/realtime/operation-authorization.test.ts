import type postgres from "postgres";
import { expect, it, vi } from "vitest";
vi.mock("../db.js", () => ({ sql: vi.fn() }));
import { revalidateOperationScopes } from "./operation-authorization.js";

it("cancels stalled permission SQL when its observer detaches", async () => {
  const controller = new AbortController();
  let reject!: (reason: Error) => void;
  const pending = new Promise<never>((_resolve, fail) => { reject = fail; });
  const cancel = vi.fn(async () => { reject(new Error("query_cancelled")); });
  const query = Object.assign(pending, { cancel });
  const client = vi.fn(() => query);
  const result = revalidateOperationScopes("owner", "operation", controller.signal, client as unknown as postgres.Sql);
  controller.abort();
  await expect(result).rejects.toThrow("query_cancelled");
  expect(cancel).toHaveBeenCalledTimes(1);
});

it("does not enqueue permission SQL for an already detached observer", async () => {
  const client = vi.fn();
  const controller = new AbortController(); controller.abort();
  await expect(revalidateOperationScopes("owner", "operation", controller.signal, client as unknown as postgres.Sql)).rejects.toThrow();
  expect(client).not.toHaveBeenCalled();
});

it.each([{ scopes: [] }, { scopes: [{ permitted: false }] }, { scopes: Array.from({ length: 129 }, () => ({ permitted: true })) }])(
  "fails closed on missing, denied or oversized scope results (%#)", async ({ scopes }) => {
    const query = Object.assign(Promise.resolve(scopes), { cancel: vi.fn() });
    const client = vi.fn(() => query);
    await expect(revalidateOperationScopes("owner", "operation", new AbortController().signal, client as unknown as postgres.Sql)).rejects.toThrow("operation_forbidden");
  });

it("releases the abort listener after a successful fresh permission batch", async () => {
  const controller = new AbortController();
  const cancel = vi.fn();
  const query = Object.assign(Promise.resolve([{ permitted: true }]), { cancel });
  await revalidateOperationScopes("owner", "operation", controller.signal, vi.fn(() => query) as unknown as postgres.Sql);
  controller.abort();
  expect(cancel).not.toHaveBeenCalled();
});

it("refuses an authorized task tree containing an organization outside the cohort", async () => {
  const org = "00000000-0000-4000-8000-000000000001";
  vi.stubEnv("REALTIME_CANARY_ORG_IDS", org);
  const query = Object.assign(Promise.resolve([{permitted:true,org_id:org},{permitted:true,org_id:"foreign"}]), {cancel:vi.fn()});
  try {
    await expect(revalidateOperationScopes("owner","operation",new AbortController().signal,vi.fn(()=>query) as unknown as postgres.Sql)).rejects.toThrow("operation_forbidden");
  } finally { vi.unstubAllEnvs(); }
});
