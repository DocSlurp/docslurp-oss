import { sql } from "../../db.js";
import { isStripeConfigured } from "./stripe-client.js";

/**
 * Metering is enforced whenever Stripe is configured: once customers can pay,
 * compute and storage must be charged. Env flags can turn metering on without
 * Stripe (testing) but cannot turn it off while Stripe is live.
 */
export function isMeteringEnforced(): boolean {
  return isStripeConfigured();
}

export function stripeMode(): "test" | "live" | null {
  const key = process.env.STRIPE_SECRET_KEY?.trim();
  if (!key) return null;
  return /^(sk|rk)_live_/.test(key) ? "live" : "test";
}

/**
 * Publish enforcement to billing_runtime so workers, which never hold the
 * Stripe secret, bill compute too. Runs at boot and on every maintenance sweep.
 */
export async function syncMeteringEnforcement(): Promise<{ enforced: boolean }> {
  const enforced = isMeteringEnforced();
  const mode = stripeMode();
  const changed = await sql<{ metering_enforced: boolean }[]>`
    insert into billing_runtime (id, metering_enforced, stripe_mode, updated_at)
    values (true, ${enforced}, ${mode}, now())
    on conflict (id) do update
      set metering_enforced = excluded.metering_enforced,
          stripe_mode = excluded.stripe_mode,
          updated_at = now()
      where billing_runtime.metering_enforced is distinct from excluded.metering_enforced
         or billing_runtime.stripe_mode is distinct from excluded.stripe_mode
    returning metering_enforced
  `;
  if (changed.length > 0) {
    console.log(`[billing] metering_enforced=${enforced} stripe_mode=${mode ?? "none"}`);
  }
  return { enforced };
}
