import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  run: { id:"retry-r", orgId:"retry-o", workspaceId:"retry-w", status:"completed", pipeline:{speedBoost:true} },
  prepare: vi.fn(), start: vi.fn(), lease: vi.fn(), admit: vi.fn(),
}));
vi.mock("../db.js",()=>({sql:Object.assign(vi.fn(async()=>[{}]),{array:(v:unknown)=>v})}));
vi.mock("../services/organizations.js",()=>({listAccessibleWorkspaceIds:async()=>['retry-w'],getWorkspaceAccess:async()=>({}),canContributeToWorkspace:()=>true}));
vi.mock("../services/run-records.js",async original=>({...await original<object>(),mapWorkspaceRun:()=>mocks.run}));
vi.mock("../services/usage-attribution.js",async original=>({...await original<object>(),runUsageCostSummaries:async()=>new Map()}));
vi.mock("../services/run-lifecycle.js",async original=>({...await original<object>(),runLifecycle:{prepareRetry:mocks.prepare,start:mocks.start}}));
vi.mock("../services/billing/spend-guard.js",async original=>({...await original<object>(),admitRunSpend:mocks.admit}));
const { retryRun } = await import("../services/runs.js");
beforeEach(()=>{
  vi.clearAllMocks();
  mocks.run.pipeline.speedBoost = true;
  mocks.admit.mockImplementation(async (_org,_workspace,callback)=>{const result=await callback({});await mocks.lease();return result;});
});
it("rolls back the no-op retry before lease acquisition or workflow start",async()=>{
  mocks.prepare.mockResolvedValue('not-retryable');
  expect((await retryRun('retry-r','user'))?.outcome).toEqual({status:'not-retryable'});
  expect(mocks.lease).not.toHaveBeenCalled();
  expect(mocks.start).not.toHaveBeenCalled();
  expect(mocks.admit.mock.calls[0]![3]).toEqual({speedBoost:true,leaseRunId:'retry-r',readmission:true});
});
it("propagates real admission failures without starting work",async()=>{
  mocks.prepare.mockResolvedValue('resumed');
  const failure = new Error('lease failure');
  mocks.lease.mockRejectedValueOnce(failure);
  await expect(retryRun('retry-r','user')).rejects.toBe(failure);
  expect(mocks.start).not.toHaveBeenCalled();
});

it.each([false, true])("reserves a lease before starting a retry with speedBoost=%s", async speedBoost => {
  mocks.run.pipeline.speedBoost = speedBoost;
  mocks.prepare.mockResolvedValue("resumed");
  mocks.start.mockImplementation(async () => {
    expect(mocks.lease).toHaveBeenCalledTimes(1);
    return { status: "started" };
  });
  await retryRun("retry-r", "user");
  expect(mocks.admit.mock.calls[0]![3]).toEqual({ speedBoost, leaseRunId: "retry-r", readmission: true });
  expect(mocks.start).toHaveBeenCalledTimes(1);
});
