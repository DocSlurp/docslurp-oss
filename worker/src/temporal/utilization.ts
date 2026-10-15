/**
 * Worker utilization: how much of each started machine is doing work.
 *
 * Every worker serves these on its health port `/metrics`, which Fly's
 * Prometheus scrapes from each started machine, so fleet utilization is
 *
 *   sum(rate(docslurp_worker_activity_slot_seconds_total[5m]))
 *     / sum(rate(docslurp_worker_activity_capacity_seconds_total[5m]))
 *
 * A started machine with idle slots counts against it; a stopped machine
 * reports nothing. CPU comes from /proc/stat, so it covers the parser and
 * OCR subprocesses too, and steal shows when shared vCPUs are throttled.
 * `scripts/worker-utilization.mjs` reads both for a time window.
 */

import { readFileSync } from "node:fs";
import { cpus } from "node:os";

export interface CpuTimes {
  busy: number;
  steal: number;
  total: number;
}

/** Aggregate CPU line of /proc/stat (jiffies), or null where unavailable. */
export function parseProcStat(text: string): CpuTimes | null {
  const line = text.split("\n").find((entry) => entry.startsWith("cpu "));
  if (!line) return null;
  const [user = 0, nice = 0, system = 0, idle = 0, iowait = 0, irq = 0, softirq = 0, steal = 0] =
    line.trim().split(/\s+/).slice(1).map(Number);
  const total = user + nice + system + idle + iowait + irq + softirq + steal;
  return { busy: user + nice + system + irq + softirq, steal, total };
}

function readCpuTimes(): CpuTimes | null {
  try {
    return parseProcStat(readFileSync("/proc/stat", "utf8"));
  } catch {
    return null;
  }
}

export interface UtilizationSnapshot {
  slots: number;
  busySlots: number;
  /** Mean busy slots / slots since the previous snapshot. */
  slotUtilization: number;
  cpuBusy: number | null;
  cpuSteal: number | null;
}

export class UtilizationMeter {
  private busySlotSeconds = 0;
  private capacitySeconds = 0;
  private lastSampleAt: number;
  private busyNow = 0;
  private window = { busySlotSeconds: 0, capacitySeconds: 0 };
  private cpuWindowStart: CpuTimes | null;
  private lastCpu: { busy: number | null; steal: number | null } = { busy: null, steal: null };

  constructor(
    private readonly slots: number,
    private readonly busySlots: () => number,
    private readonly now: () => number = Date.now,
    private readonly cpuTimes: () => CpuTimes | null = readCpuTimes,
  ) {
    this.lastSampleAt = now();
    this.cpuWindowStart = cpuTimes();
  }

  /** Integrates busy slots since the last sample; call every second or so. */
  sample(): void {
    const now = this.now();
    const seconds = Math.max(0, (now - this.lastSampleAt) / 1000);
    this.lastSampleAt = now;
    // Resource-tuned workers may run more than the nominal slots, so this can exceed 100%.
    const busy = Math.max(0, this.busySlots());
    this.busySlotSeconds += busy * seconds;
    this.capacitySeconds += this.slots * seconds;
    this.window.busySlotSeconds += busy * seconds;
    this.window.capacitySeconds += this.slots * seconds;
    this.busyNow = busy;
  }

  /** Averages since the previous snapshot, then starts a new window (for the periodic log line). */
  snapshot(): UtilizationSnapshot {
    this.sample();
    const cpu = this.cpuTimes();
    if (cpu && this.cpuWindowStart) {
      const total = cpu.total - this.cpuWindowStart.total;
      if (total > 0) {
        this.lastCpu = {
          busy: (cpu.busy - this.cpuWindowStart.busy) / total,
          steal: (cpu.steal - this.cpuWindowStart.steal) / total,
        };
      }
    }
    this.cpuWindowStart = cpu;
    const slotUtilization = this.window.capacitySeconds > 0 ? this.window.busySlotSeconds / this.window.capacitySeconds : 0;
    this.window = { busySlotSeconds: 0, capacitySeconds: 0 };
    return { slots: this.slots, busySlots: this.busyNow, slotUtilization, cpuBusy: this.lastCpu.busy, cpuSteal: this.lastCpu.steal };
  }

  /** Prometheus text for this machine. */
  metricLines(): string[] {
    this.sample();
    const cpu = this.cpuTimes();
    const hz = 100; // USER_HZ: /proc/stat counts in 1/100 s on Linux.
    const lines = [
      "# HELP docslurp_worker_activity_slots Activity execution slots on this worker.",
      "# TYPE docslurp_worker_activity_slots gauge",
      `docslurp_worker_activity_slots ${this.slots}`,
      "# HELP docslurp_worker_activity_slots_busy Activities running on this worker now.",
      "# TYPE docslurp_worker_activity_slots_busy gauge",
      `docslurp_worker_activity_slots_busy ${this.busyNow}`,
      "# HELP docslurp_worker_activity_slot_seconds_total Busy activity slot-seconds since the worker started.",
      "# TYPE docslurp_worker_activity_slot_seconds_total counter",
      `docslurp_worker_activity_slot_seconds_total ${this.busySlotSeconds.toFixed(3)}`,
      "# HELP docslurp_worker_activity_capacity_seconds_total Activity slot-seconds available since the worker started.",
      "# TYPE docslurp_worker_activity_capacity_seconds_total counter",
      `docslurp_worker_activity_capacity_seconds_total ${this.capacitySeconds.toFixed(3)}`,
      "# HELP docslurp_worker_cpus vCPUs on this machine.",
      "# TYPE docslurp_worker_cpus gauge",
      `docslurp_worker_cpus ${cpus().length}`,
    ];
    if (cpu) {
      lines.push(
        "# HELP docslurp_worker_cpu_busy_seconds_total Machine CPU busy time (all processes, all vCPUs).",
        "# TYPE docslurp_worker_cpu_busy_seconds_total counter",
        `docslurp_worker_cpu_busy_seconds_total ${(cpu.busy / hz).toFixed(2)}`,
        "# HELP docslurp_worker_cpu_steal_seconds_total CPU time the host withheld (shared vCPU throttling).",
        "# TYPE docslurp_worker_cpu_steal_seconds_total counter",
        `docslurp_worker_cpu_steal_seconds_total ${(cpu.steal / hz).toFixed(2)}`,
      );
    }
    return lines;
  }
}
