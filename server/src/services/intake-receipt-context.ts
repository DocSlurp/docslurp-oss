import { AsyncLocalStorage } from "node:async_hooks";
import type { TransactionSql } from "postgres";

export type IntakeReceipt = { key: string; route: string; hash: string; userId: string };
export const intakeReceiptContext = new AsyncLocalStorage<IntakeReceipt>();

/** Called within the run admission transaction, before publication. */
export async function bindIntakeReceipt(tx: TransactionSql, runId: string): Promise<void> {
  const receipt = intakeReceiptContext.getStore();
  if (!receipt) return;
  const [bound] = await tx`update intake_request_receipts set run_id = ${runId}
    where idempotency_key = ${receipt.key} and route_key = ${receipt.route}
      and request_hash = ${receipt.hash} and user_id = ${receipt.userId} and run_id is null
    returning run_id`;
  if (!bound) throw new Error("Intake receipt is missing or already bound");
}
