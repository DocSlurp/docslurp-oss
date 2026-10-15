-- Billing system: rate limits, subscriptions, and usage tracking

-- Rate limit configuration per organization
create table if not exists org_rate_limits (
  id text primary key default gen_random_uuid()::text,
  org_id text not null unique references organizations(id) on delete cascade,
  tier_id text,
  daily_token_cap integer not null default 0,
  monthly_safety_cap integer not null default 0,
  burst_per_minute integer not null default 60,
  custom_daily_cap boolean not null default false,
  custom_monthly_cap boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists org_rate_limits_org_id_idx on org_rate_limits(org_id);

-- Rate limit usage tracking (sliding window)
create table if not exists rate_limit_usage (
  id text primary key default gen_random_uuid()::text,
  org_id text not null references organizations(id) on delete cascade,
  tokens integer not null default 0,
  window_start timestamptz not null,
  window_end timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists rate_limit_usage_org_window_idx on rate_limit_usage(org_id, window_end desc);
create index if not exists rate_limit_usage_org_created_idx on rate_limit_usage(org_id, created_at desc);

-- Subscription tier price IDs (maps our tier IDs to Stripe price IDs)
create table if not exists subscription_tier_prices (
  id text primary key default gen_random_uuid()::text,
  tier_id text not null unique,
  stripe_price_id text,
  stripe_product_id text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists subscription_tier_prices_tier_id_idx on subscription_tier_prices(tier_id);

-- Subscription usage per billing period
create table if not exists subscription_usage (
  id text primary key default gen_random_uuid()::text,
  org_id text not null references organizations(id) on delete cascade,
  period_start timestamptz not null,
  period_end timestamptz not null,
  tokens_used integer not null default 0,
  tokens_included integer not null default 0,
  overage_tokens integer not null default 0,
  overage_cost_cents integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists subscription_usage_org_period_idx on subscription_usage(org_id, period_end desc);

-- Budget alert history
create table if not exists budget_alerts (
  id text primary key default gen_random_uuid()::text,
  org_id text not null references organizations(id) on delete cascade,
  alert_type text not null,
  threshold_percent integer not null,
  current_usage_cents integer not null,
  budget_cents integer not null,
  notified_at timestamptz not null default now()
);

create index if not exists budget_alerts_org_notified_idx on budget_alerts(org_id, notified_at desc);
