-- Shared replay and challenge state for agent machine payments (MPP via mppx).
-- Every API instance must see the same claims, or a Tempo transfer could be
-- redeemed once per instance. Values are mppx's own JSON encoding.
create table machine_payment_store (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);
--> statement-breakpoint
create index machine_payment_store_updated_at_idx on machine_payment_store (updated_at);
