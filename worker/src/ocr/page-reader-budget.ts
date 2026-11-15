/*
 * The page reader's spend bound per organization per UTC day (DOCSLURP_OCR_PAGE_READER_ORG_DAILY_MAX_COST_CENTS).
 *
 * Reader usage bills 0 credits (the page was already charged as one Rich page), so the run cost cap cannot bound the
 * reader's provider cost. This ledger does, across every worker: a job is admitted only if the organization's settled
 * cost today, plus the reservations of its unsettled jobs, plus this job's reservation, stays within the cap. Admission
 * is atomic (the organization's advisory lock in Postgres, one process in memory), so concurrent workers cannot pass the
 * cap together. A job settles its ticket with the provider cost it recorded; a ticket never settled keeps its reservation
 * for the rest of the day (fail closed).
 */
import { randomUUID } from "node:crypto";

import type { Sql, TransactionSql } from "postgres";

export interface PageReaderAdmitRequest {
  orgId: string;
  /** The provider's upper estimate of this job's cost, in cents (0 when it gives none). */
  reserveCents: number;
  /** The organization's daily cap, in cents. */
  capCents: number;
}

export type PageReaderAdmission = { admitted: true; ticket: string } | { admitted: false; committedCents: number };

export interface PageReaderOrgBudget {
  admit(request: PageReaderAdmitRequest): Promise<PageReaderAdmission>;
  /** Replace the ticket's reservation with the cost the job recorded. */
  settle(ticket: string, costCents: number): Promise<void>;
}

function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function cents(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.round(value * 10_000) / 10_000 : 0;
}

/** One process (store-less runs, tests). Same rules as the Postgres ledger. */
export class InMemoryPageReaderOrgBudget implements PageReaderOrgBudget {
  private readonly tickets = new Map<string, { orgId: string; day: string; reserved: number; cost: number; settled: boolean }>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  async admit({ orgId, reserveCents, capCents }: PageReaderAdmitRequest): Promise<PageReaderAdmission> {
    const day = utcDay(this.now());
    let committed = 0;
    for (const [id, ticket] of this.tickets) {
      if (ticket.day < day) { this.tickets.delete(id); continue; }
      if (ticket.orgId === orgId && ticket.day === day) committed += ticket.settled ? ticket.cost : Math.max(ticket.reserved, ticket.cost);
    }
    const reserve = cents(reserveCents);
    if (committed >= capCents || committed + reserve > capCents) return { admitted: false, committedCents: committed };
    const ticket = randomUUID();
    this.tickets.set(ticket, { orgId, day, reserved: reserve, cost: 0, settled: false });
    return { admitted: true, ticket };
  }

  async settle(ticket: string, costCents: number): Promise<void> {
    const row = this.tickets.get(ticket);
    if (row) Object.assign(row, { cost: cents(costCents), settled: true });
  }
}

type Client = Sql<Record<string, unknown>>;
type Tx = TransactionSql<Record<string, unknown>>;

/** Fleet-wide ledger (migration 0163). */
export class PostgresPageReaderOrgBudget implements PageReaderOrgBudget {
  constructor(private readonly sql: Client) {}

  async admit({ orgId, reserveCents, capCents }: PageReaderAdmitRequest): Promise<PageReaderAdmission> {
    const reserve = cents(reserveCents);
    return await this.sql.begin(async (tx: Tx) => {
      await tx`select pg_advisory_xact_lock(hashtextextended(${`ocr-page-reader-org:${orgId}`}, 0))`;
      await tx`delete from ocr_page_reader_org_spend where org_id = ${orgId} and day < (now() at time zone 'utc')::date - 1`;
      const [row] = await tx<{ committed: string | number }[]>`
        select coalesce(sum(case when settled then cost_cents else greatest(reserved_cents, cost_cents) end), 0) as committed
        from ocr_page_reader_org_spend
        where org_id = ${orgId} and day = (now() at time zone 'utc')::date`;
      const committed = Number(row?.committed ?? 0);
      if (committed >= capCents || committed + reserve > capCents) return { admitted: false as const, committedCents: committed };
      const ticket = randomUUID();
      await tx`
        insert into ocr_page_reader_org_spend (id, org_id, day, reserved_cents)
        values (${ticket}, ${orgId}, (now() at time zone 'utc')::date, ${reserve})`;
      return { admitted: true as const, ticket };
    });
  }

  async settle(ticket: string, costCents: number): Promise<void> {
    await this.sql`update ocr_page_reader_org_spend set cost_cents = ${cents(costCents)}, settled = true where id = ${ticket}`;
  }
}

/** The ledger of store-less runs in this process. */
export const processPageReaderOrgBudget = new InMemoryPageReaderOrgBudget();
