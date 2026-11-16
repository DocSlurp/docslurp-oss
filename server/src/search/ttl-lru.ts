/** Bounded in-memory LRU with a per-entry TTL. Insertion order of the Map is the recency order. */
export class TtlLruCache<V> {
  private readonly entries = new Map<string, { value: V; expiresAt: number }>();
  hits = 0;
  misses = 0;

  constructor(
    private readonly maxEntries: number,
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  get enabled(): boolean {
    return this.maxEntries > 0 && this.ttlMs > 0;
  }

  get size(): number {
    return this.entries.size;
  }

  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (!entry || entry.expiresAt <= this.now()) {
      if (entry) this.entries.delete(key);
      this.misses += 1;
      return undefined;
    }
    // Refresh recency.
    this.entries.delete(key);
    this.entries.set(key, entry);
    this.hits += 1;
    return entry.value;
  }

  set(key: string, value: V): void {
    if (!this.enabled) return;
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
    this.hits = 0;
    this.misses = 0;
  }
}

/** Read a non-negative integer env value; unset or invalid values use the fallback. */
export function envInt(name: string, fallback: number, env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

type PartitionEntry<V> = { value: V; expiresAt: number };

/**
 * Bounded LRU with a per-entry TTL, partitioned by organization, so one organization's traffic cannot push out
 * another's entries (a volume side channel: org B would see its own hits turn into misses when org A is busy).
 *
 * - Each organization holds at most `perOrgMaxEntries` and evicts only its own oldest entry past that.
 * - The whole cache holds at most `maxEntries`. When it is full, expired entries go first. Then an organization at or
 *   above an equal share (`maxEntries / active organizations`) evicts its own oldest entry; one below it evicts from
 *   the largest organization, which is necessarily above its share. So an organization's entries are never evicted by
 *   another organization while it holds no more than an equal share; within that they leave only by its own writes,
 *   expiry or deletion. With the default per-organization cap (a quarter of the cache) no eviction crosses
 *   organizations at all until more than four are active.
 * - Every read and write names the organization; a blank one is refused (no shared or null partition).
 */
export class OrgPartitionedTtlLru<V> {
  private readonly partitions = new Map<string, Map<string, PartitionEntry<V>>>();
  private total = 0;
  hits = 0;
  misses = 0;
  readonly perOrgMaxEntries: number;

  constructor(
    private readonly maxEntries: number,
    private readonly ttlMs: number,
    perOrgMaxEntries?: number,
    private readonly now: () => number = Date.now,
  ) {
    const fallback = Math.max(1, Math.floor(maxEntries / 4));
    this.perOrgMaxEntries = Math.max(0, Math.min(maxEntries, perOrgMaxEntries ?? fallback));
  }

  get enabled(): boolean {
    return this.maxEntries > 0 && this.ttlMs > 0 && this.perOrgMaxEntries > 0;
  }

  /** Entries across every organization (operator metrics only; never report it to a caller). */
  get size(): number {
    return this.total;
  }

  /** Entries held for one organization. */
  sizeFor(orgId: string): number {
    return this.partitions.get(requirePartition(orgId))?.size ?? 0;
  }

  get(orgId: string, key: string): V | undefined {
    const org = requirePartition(orgId);
    const partition = this.partitions.get(org);
    const entry = partition?.get(key);
    if (!partition || !entry || entry.expiresAt <= this.now()) {
      if (partition && entry) this.remove(org, partition, key);
      this.misses += 1;
      return undefined;
    }
    partition.delete(key);
    partition.set(key, entry);
    this.hits += 1;
    return entry.value;
  }

  set(orgId: string, key: string, value: V): void {
    const org = requirePartition(orgId);
    if (!this.enabled) return;
    let partition = this.partitions.get(org);
    if (!partition) {
      partition = new Map();
      this.partitions.set(org, partition);
    }
    if (partition.delete(key)) this.total -= 1;
    partition.set(key, { value, expiresAt: this.now() + this.ttlMs });
    this.total += 1;
    while (partition.size > this.perOrgMaxEntries) this.evictOldest(org);
    if (this.total > this.maxEntries) this.purgeExpired();
    while (this.total > this.maxEntries) {
      const own = this.partitions.get(org)?.size ?? 0;
      const share = this.maxEntries / this.partitions.size;
      this.evictOldest(own >= share ? org : this.largestPartition(org) ?? org);
    }
  }

  delete(orgId: string, key: string): void {
    const org = requirePartition(orgId);
    const partition = this.partitions.get(org);
    if (partition?.has(key)) this.remove(org, partition, key);
  }

  clear(): void {
    this.partitions.clear();
    this.total = 0;
    this.hits = 0;
    this.misses = 0;
  }

  private remove(orgId: string, partition: Map<string, PartitionEntry<V>>, key: string): void {
    partition.delete(key);
    this.total -= 1;
    if (partition.size === 0) this.partitions.delete(orgId);
  }

  private evictOldest(orgId: string): void {
    const partition = this.partitions.get(orgId);
    const oldest = partition?.keys().next().value;
    if (partition && oldest !== undefined) this.remove(orgId, partition, oldest);
  }

  /** The largest partition other than `except` (it is above its equal share whenever the caller is below its own). */
  private largestPartition(except: string): string | null {
    let largest: string | null = null;
    let size = -1;
    for (const [org, partition] of this.partitions) {
      if (org !== except && partition.size > size) {
        largest = org;
        size = partition.size;
      }
    }
    return largest;
  }

  private purgeExpired(): void {
    const now = this.now();
    for (const [org, partition] of this.partitions) {
      for (const [key, entry] of partition) if (entry.expiresAt <= now) this.remove(org, partition, key);
    }
  }
}

function requirePartition(orgId: string): string {
  const org = typeof orgId === "string" ? orgId.trim() : "";
  if (!org) throw new Error("organization-partitioned cache: an organization id is required");
  return org;
}
