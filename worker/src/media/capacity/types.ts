import type { MediaScope } from "../types.js";
export interface CapacityResource { id: string; name: string; createdAt: number; state: string; }
export interface CapacityQuote { hourlyUsd: number; fixedReserveUsd: number; observedAt: number; }
export interface CapacityProvider {
  readonly id: string;
  quote(): Promise<CapacityQuote>;
  inventory(): Promise<CapacityResource[]>;
  create(name: string): Promise<string>;
  destroy(id: string): Promise<void>;
}
export interface CapacityLease {
  id: string; provider: string; name: string; scope: MediaScope; createdAt: number; deadline: number;
  resourceId: string | null; beforeIds: string[]; hourlyUsd: number; reservedUsd: number;
  status: "creating" | "active" | "deleting" | "deleted"; costUsd: number | null;
}
export interface CapacityLeaseStore {
  reserve(args: { scope: MediaScope; provider: string; beforeIds: string[]; quote: CapacityQuote;
    ttlMs: number; budgetUsd: number; maxConcurrent: number; maxRunCostCents: number | null }): Promise<CapacityLease>;
  attach(id: string, resourceId: string): Promise<void>;
  deleting(id: string): Promise<void>;
  /** Persist deletion evidence AND scoped usage atomically. */
  deleted(lease: CapacityLease, verifiedAt: number): Promise<number>;
  outstanding(): Promise<CapacityLease[]>;
  heartbeat(): Promise<void>;
}
