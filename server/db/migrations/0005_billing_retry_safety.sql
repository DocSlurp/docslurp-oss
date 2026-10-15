alter table stripe_topups
  drop constraint if exists stripe_topups_amount_cents_check;

alter table stripe_topups
  add constraint stripe_topups_amount_cents_check
  check (amount_cents >= 0);
