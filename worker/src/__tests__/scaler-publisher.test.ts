import { EMPTY_WORKER_SCALER_SNAPSHOT, type WorkerScalerConfig, type WorkerScalerSnapshot } from "@docslurp/shared";
import { describe, expect, it, vi } from "vitest";

import { ScalerPublisher } from "../temporal/scaler-publisher.js";

const config: WorkerScalerConfig = { slotsPerMachine: 8, globalSlotCap: 0, headroom: 1, maxMachines: 125, excludedOrgKeys: new Set() };
const params = { pageFanout: 128, defaultOrgSlots: 2, loadtestMaxMachines: 125 };
const busy: WorkerScalerSnapshot = {
  ...EMPTY_WORKER_SCALER_SNAPSHOT,
  queue_depth: 1,
  worker_active: 2,
  org_demand: [{ org_key: "org-a", slots: 64, demand: 20 }],
};

function publisher(overrides: Partial<ConstructorParameters<typeof ScalerPublisher>[0]> = {}) {
  let leader = true;
  const read = vi.fn(async () => busy);
  const fetchImpl = vi.fn(async () => new Response("ok"));
  const instance = new ScalerPublisher({ isLeader: () => leader, read, config, params, keepAliveUrl: "https://app.invalid/health", fetchImpl: fetchImpl as unknown as typeof fetch, cacheMs: 10_000, ...overrides });
  return { instance, read, fetchImpl, setLeader: (value: boolean) => { leader = value; } };
}

describe("worker scaler publisher", () => {
  it("publishes the fleet target only from the maintenance leader", async () => {
    const { instance, read, setLeader } = publisher();
    const leaderText = await instance.metrics();
    expect(leaderText).toContain("docslurp_worker_scaler_leader 1");
    expect(leaderText).toContain("docslurp_worker_target_machines 3"); // ceil(20 / 8)
    setLeader(false);
    const followerText = await instance.metrics();
    expect(followerText).toContain("docslurp_worker_scaler_leader 0");
    expect(followerText).not.toContain("docslurp_worker_target_machines");
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("keeps the app awake only while work exists", async () => {
    const { instance, fetchImpl } = publisher();
    expect(await instance.tick()).toEqual({ work: true, pinged: true });
    expect(fetchImpl).toHaveBeenCalledWith("https://app.invalid/health", expect.anything());

    const idle = publisher({ read: async () => EMPTY_WORKER_SCALER_SNAPSHOT });
    expect(await idle.instance.tick()).toEqual({ work: false, pinged: false });
    expect(idle.fetchImpl).not.toHaveBeenCalled();
  });

  it("never throws from the leader tick when the database or app is down", async () => {
    const dbDown = publisher({ read: async () => { throw new Error("db down"); } });
    expect(await dbDown.instance.tick()).toEqual({ work: false, pinged: false });
    const appDown = publisher({ fetchImpl: (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch });
    expect(await appDown.instance.tick()).toEqual({ work: true, pinged: false });
  });
});
