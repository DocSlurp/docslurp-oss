// The fleet-target formula, demand query and scaler metric lines live in
// @docslurp/shared so the worker's maintenance leader can export the same
// target (packages/shared/src/worker-autoscale.ts).
export {
  calculatePoolTargetMachines,
  calculateWorkerTargetMachines,
  formatWorkerScalerMetricLines,
  parseOrgDemand,
  parseOrgList,
  queryWorkerScalerSnapshot,
  resolveWorkerScalerConfig,
  resolveWorkerScalerQueryParams,
  slotDemand,
  type OrgSlotDemand,
  type WorkerScalerConfig,
  type WorkerScalerQueryParams,
  type WorkerScalerSnapshot,
} from "@docslurp/shared";
