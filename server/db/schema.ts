import {
  pgTable,
  foreignKey,
  text,
  numeric,
  jsonb,
  timestamp,
  uniqueIndex,
  unique,
  check,
  boolean,
  integer,
  index,
  bigint,
  primaryKey,
  pgMaterializedView,
  pgView,
  doublePrecision,
  customType,
  date,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

const tsvector = customType<{ data: string }>({
  dataType() {
    return "tsvector";
  },
});

const bytea = customType<{ data: Buffer }>({
  dataType() {
    return "bytea";
  },
});

export const creditLedger = pgTable(
  "credit_ledger",
  {
    id: text().primaryKey().notNull(),
    userId: text("user_id").notNull(),
    orgId: text("org_id"),
    /** Which credit pool moved: "included" (plan allowance) or "prepaid". */
    pool: text(),
    /** Dollars (credits / 100). */
    delta: numeric({ precision: 24, scale: 12 }).notNull(),
    reason: text().notNull(),
    metadata: jsonb().default({}).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.userId],
      foreignColumns: [user.id],
      name: "credit_ledger_user_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.orgId],
      foreignColumns: [organizations.id],
      name: "credit_ledger_org_id_fkey",
    }).onDelete("cascade"),
    index("credit_ledger_org_created_idx").using(
      "btree",
      table.orgId.asc().nullsLast().op("text_ops"),
      table.createdAt.desc().nullsFirst().op("timestamptz_ops"),
    ),
    check("credit_ledger_pool_check", sql`(pool IS NULL) OR (pool = ANY (ARRAY['included'::text, 'prepaid'::text]))`),
    uniqueIndex("credit_ledger_starter_credit_user_idx")
      .on(table.userId)
      .where(sql`${table.reason} = 'new-account-starter-credit'`),
  ],
);

export const organizations = pgTable(
  "organizations",
  {
    id: text().primaryKey().notNull(),
    name: text().notNull(),
    slug: text(),
    isPersonal: boolean("is_personal").default(false).notNull(),
    personalOwnerUserId: text("personal_owner_user_id"),
    createdByUserId: text("created_by_user_id").notNull(),
    /** Prepaid credit pool (1 credit = 1 cent): top-ups, auto-recharge, starter. May go negative. */
    creditBalanceCents: numeric("credit_balance_cents", { precision: 24, scale: 12, mode: "number" }).default(0).notNull(),
    planId: text("plan_id").default("free").notNull(),
    /** Org-wide concurrency ceiling; follows the plan, drops to free after the past-due grace. */
    workerSlots: integer("worker_slots").default(50).notNull(),
    /** Plan allowance for the current period; spent before prepaid, expires at renewal. */
    includedCreditsRemaining: numeric("included_credits_remaining", { precision: 24, scale: 12, mode: "number" }).default(0).notNull(),
    includedCreditsGranted: numeric("included_credits_granted", { precision: 24, scale: 12, mode: "number" }).default(0).notNull(),
    subscriptionStatus: text("subscription_status").default("none").notNull(),
    currentPeriodStart: timestamp("current_period_start", { withTimezone: true, mode: "string" }),
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true, mode: "string" }),
    cancelAtPeriodEnd: boolean("cancel_at_period_end").default(false).notNull(),
    scheduledPlanId: text("scheduled_plan_id"),
    pastDueSince: timestamp("past_due_since", { withTimezone: true, mode: "string" }),
    autoRechargeEnabled: boolean("auto_recharge_enabled").default(false).notNull(),
    autoRechargeThresholdCredits: integer("auto_recharge_threshold_credits"),
    autoRechargeAmountCents: integer("auto_recharge_amount_cents"),
    autoRechargeMonthlyLimitCents: integer("auto_recharge_monthly_limit_cents"),
    autoRechargeLastAttemptAt: timestamp("auto_recharge_last_attempt_at", { withTimezone: true, mode: "string" }),
    autoRechargeConsecutiveFailures: integer("auto_recharge_consecutive_failures").default(0).notNull(),
    autoRechargeLastFailureRef: text("auto_recharge_last_failure_ref"),
    autoRechargeAuthorizedAt: timestamp("auto_recharge_authorized_at", { withTimezone: true, mode: "string" }),
    autoRechargeAuthorizedByUserId: text("auto_recharge_authorized_by_user_id"),
    lastBillableActivityAt: timestamp("last_billable_activity_at", { withTimezone: true, mode: "string" }),
    monthlyBudgetCents: integer("monthly_budget_cents"),
    budgetAlertThresholdPercent: integer("budget_alert_threshold_percent")
      .default(80)
      .notNull(),
    budgetAlertLevel: integer("budget_alert_level").default(0).notNull(),
    budgetAlertUpdatedAt: timestamp("budget_alert_updated_at", {
      withTimezone: true,
      mode: "string",
    }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    stripeCustomerId: text("stripe_customer_id"),
    stripeSubscriptionId: text("stripe_subscription_id"),
    budgetPaused: boolean("budget_paused").default(false).notNull(),
    ssoConfig: jsonb("sso_config").default({}).notNull(),
  },
  (table) => [
    uniqueIndex("organizations_stripe_customer_id_idx")
      .using("btree", table.stripeCustomerId.asc().nullsLast().op("text_ops"))
      .where(sql`(stripe_customer_id IS NOT NULL)`),
    foreignKey({
      columns: [table.createdByUserId],
      foreignColumns: [user.id],
      name: "organizations_created_by_user_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.personalOwnerUserId],
      foreignColumns: [user.id],
      name: "organizations_personal_owner_user_id_fkey",
    }).onDelete("set null"),
    unique("organizations_slug_key").on(table.slug),
    unique("organizations_personal_owner_user_id_key").on(
      table.personalOwnerUserId,
    ),
    index("organizations_auto_recharge_idx")
      .using("btree", table.id.asc().nullsLast().op("text_ops"))
      .where(sql`auto_recharge_enabled`),
    index("organizations_past_due_idx")
      .using("btree", table.pastDueSince.asc().nullsLast().op("timestamptz_ops"))
      .where(sql`(past_due_since IS NOT NULL)`),
    foreignKey({
      columns: [table.autoRechargeAuthorizedByUserId],
      foreignColumns: [user.id],
      name: "organizations_auto_recharge_authorized_by_fkey",
    }).onDelete("set null"),
    check(
      "organizations_plan_id_check",
      sql`plan_id = ANY (ARRAY['free'::text, 'silver'::text, 'gold'::text, 'platinum'::text])`,
    ),
    check(
      "organizations_scheduled_plan_id_check",
      sql`(scheduled_plan_id IS NULL) OR (scheduled_plan_id = ANY (ARRAY['free'::text, 'silver'::text, 'gold'::text, 'platinum'::text]))`,
    ),
    check("organizations_worker_slots_check", sql`worker_slots > 0`),
    check("organizations_included_credits_check", sql`included_credits_remaining >= (0)::numeric`),
    check(
      "organizations_budget_alert_threshold_percent_check",
      sql`(budget_alert_threshold_percent >= 1) AND (budget_alert_threshold_percent <= 100)`,
    ),
  ],
);

/** External cleanup (storage artifacts, LanceDB rows) for documents deleted by hand; drained by the worker. */
export const documentCleanupQueue = pgTable(
  "document_cleanup_queue",
  {
    documentId: text("document_id").primaryKey().notNull(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    runId: text("run_id"),
    sourceKey: text("source_key"),
    deleteSource: boolean("delete_source").default(false).notNull(),
    keepSharedArtifacts: boolean("keep_shared_artifacts").default(false).notNull(),
    vectorTargets: jsonb("vector_targets").default([]).notNull(),
    artifactUris: text("artifact_uris").array().default(sql`'{}'::text[]`).notNull(),
    kgNodeIds: text("kg_node_ids").array().default(sql`'{}'::text[]`).notNull(),
    attempts: integer().default(0).notNull(),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("document_cleanup_queue_created_idx").using(
      "btree",
      table.createdAt.asc().nullsLast().op("timestamptz_ops"),
    ),
  ],
);

/** Current-corpus counters (completed, non-superseded documents), maintained by a documents trigger. */
export const workspaceCorpusStats = pgTable(
  "workspace_corpus_stats",
  {
    workspaceId: text("workspace_id").primaryKey().notNull(),
    documentCount: bigint("document_count", { mode: "number" }).default(0).notNull(),
    pageCount: bigint("page_count", { mode: "number" }).default(0).notNull(),
    sourceBytes: bigint("source_bytes", { mode: "number" }).default(0).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.workspaceId],
      foreignColumns: [workspaces.id],
      name: "workspace_corpus_stats_workspace_id_fkey",
    }).onDelete("cascade"),
  ],
);

/** Worker-recorded webhook events, drained and signed by the API. */
export const webhookOutbox = pgTable(
  "webhook_outbox",
  {
    id: text().primaryKey().notNull(),
    userId: text("user_id").notNull(),
    eventType: text("event_type").notNull(),
    payload: jsonb().default({}).notNull(),
    attempts: integer().default(0).notNull(),
    claimedAt: timestamp("claimed_at", { withTimezone: true, mode: "string" }),
    dispatchedAt: timestamp("dispatched_at", { withTimezone: true, mode: "string" }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("webhook_outbox_pending_idx")
      .using("btree", table.createdAt.asc().nullsLast().op("timestamptz_ops"))
      .where(sql`(dispatched_at IS NULL)`),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [user.id],
      name: "webhook_outbox_user_id_fkey",
    }).onDelete("cascade"),
  ],
);

export const vectorIndexes = pgTable(
  "vector_indexes",
  {
    id: text().primaryKey().notNull(),
    documentId: text("document_id").notNull(),
    backend: text().notNull(),
    bucket: text().notNull(),
    path: text().notNull(),
    embeddingModel: text("embedding_model").notNull(),
    dimension: integer().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("vector_indexes_document_id_idx").using(
      "btree",
      table.documentId.asc().nullsLast().op("text_ops"),
    ),
    uniqueIndex("vector_indexes_document_backend_model_idx").using(
      "btree",
      table.documentId.asc().nullsLast().op("text_ops"),
      table.backend.asc().nullsLast().op("text_ops"),
      table.embeddingModel.asc().nullsLast().op("text_ops"),
      table.dimension.asc().nullsLast().op("int4_ops"),
    ),
    foreignKey({
      columns: [table.documentId],
      foreignColumns: [documents.id],
      name: "vector_indexes_document_id_fkey",
    }).onDelete("cascade"),
  ],
);

export const usageEvents = pgTable(
  "usage_events",
  {
    id: text().primaryKey().notNull(),
    userId: text("user_id").notNull(),
    runId: text("run_id"),
    documentId: text("document_id"),
    provider: text().notNull(),
    model: text().notNull(),
    metric: text().notNull(),
    amount: numeric({ precision: 12, scale: 4 }).notNull(),
    unit: text().notNull(),
    costCents: numeric("cost_cents", { precision: 24, scale: 12, mode: "number" }).default(0).notNull(),
    metadata: jsonb().default({}).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    inputTokens: integer("input_tokens").default(0).notNull(),
    outputTokens: integer("output_tokens").default(0).notNull(),
    // Stamped at write time, no FKs: spend outlives the run, workspace and key (migration 0041).
    orgId: text("org_id"),
    workspaceId: text("workspace_id"),
    apiKeyId: text("api_key_id"),
  },
  (table) => [
    index("usage_events_org_created_idx").on(table.orgId, table.createdAt),
    index("usage_events_workspace_created_idx").on(table.workspaceId, table.createdAt),
    index("usage_events_run_id_idx").using(
      "btree",
      table.runId.asc().nullsLast().op("text_ops"),
    ),
    foreignKey({
      columns: [table.runId],
      foreignColumns: [workspaceRuns.id],
      name: "usage_events_run_id_fkey",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.documentId],
      foreignColumns: [documents.id],
      name: "usage_events_document_id_fkey",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [user.id],
      name: "usage_events_user_id_fkey",
    }).onDelete("cascade"),
  ],
);

export const documents = pgTable(
  "documents",
  {
    id: text().primaryKey().notNull(),
    userId: text("user_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    runId: text("run_id"),
    filename: text().notNull(),
    mimeType: text("mime_type").notNull(),
    sourceKey: text("source_key").notNull(),
    status: text().notNull(),
    extractionMode: text("extraction_mode").default("hybrid").notNull(),
    pageCount: integer("page_count").default(0).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    orgId: text("org_id"),
    versionNumber: integer("version_number").default(1).notNull(),
    previousVersionId: text("previous_version_id"),
    sourceSha256: text("source_sha256"),
    dedupedFromDocumentId: text("deduped_from_document_id"),
    reusedFromDocumentId: text("reused_from_document_id"),
    dedupScope: text("dedup_scope"),
    // You can use { mode: "bigint" } if numbers are exceeding js number limitations
    fileSize: bigint("file_size", { mode: "number" }).default(0).notNull(),
    metadata: jsonb().default({}).notNull(),
    canonicalId: text("canonical_id"),
    supersededAt: timestamp("superseded_at", { withTimezone: true, mode: "string" }),
    supersededByDocumentId: text("superseded_by_document_id"),
    purgedAt: timestamp("purged_at", { withTimezone: true, mode: "string" }),
    // Chunks fully materialized: keyword search may serve this version before completion.
    lexicalSearchableAt: timestamp("lexical_searchable_at", { withTimezone: true, mode: "string" }),
  },
  (table) => [
    index("documents_superseded_unpurged_idx")
      .using("btree", table.supersededAt.asc().nullsLast().op("timestamptz_ops"))
      .where(sql`(superseded_at IS NOT NULL) AND (purged_at IS NULL)`),
    index("documents_workspace_in_flight_idx")
      .using("btree", table.workspaceId.asc().nullsLast().op("text_ops"))
      .where(sql`status NOT IN ('completed', 'failed', 'cancelled')`),
    index("documents_workspace_canonical_idx")
      .using(
        "btree",
        table.workspaceId.asc().nullsLast().op("text_ops"),
        table.canonicalId.asc().nullsLast().op("text_ops"),
        table.createdAt.desc().nullsFirst().op("timestamptz_ops"),
      )
      .where(sql`(canonical_id IS NOT NULL)`),
    check(
      "documents_canonical_id_length_check",
      sql`(canonical_id IS NULL) OR (char_length(canonical_id) BETWEEN 1 AND 2048)`,
    ),
    index("documents_org_id_idx").using(
      "btree",
      table.orgId.asc().nullsLast().op("text_ops"),
      table.createdAt.desc().nullsFirst().op("timestamptz_ops"),
    ),
    index("documents_org_source_sha256_idx")
      .using(
        "btree",
        table.orgId.asc().nullsLast().op("text_ops"),
        table.sourceSha256.asc().nullsLast().op("text_ops"),
      )
      .where(sql`(source_sha256 IS NOT NULL)`),
    index("documents_run_id_idx").using(
      "btree",
      table.runId.asc().nullsLast().op("text_ops"),
    ),
    index("documents_workspace_id_idx").using(
      "btree",
      table.workspaceId.asc().nullsLast().op("timestamptz_ops"),
      table.createdAt.desc().nullsFirst().op("timestamptz_ops"),
    ),
    index("documents_workspace_source_sha256_idx")
      .using(
        "btree",
        table.workspaceId.asc().nullsLast().op("text_ops"),
        table.sourceSha256.asc().nullsLast().op("text_ops"),
      )
      .where(sql`(source_sha256 IS NOT NULL)`),
    foreignKey({
      columns: [table.workspaceId],
      foreignColumns: [workspaces.id],
      name: "documents_workspace_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.runId],
      foreignColumns: [workspaceRuns.id],
      name: "documents_run_id_fkey",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [user.id],
      name: "documents_user_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.dedupedFromDocumentId],
      foreignColumns: [table.id],
      name: "documents_deduped_from_document_id_fkey",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.reusedFromDocumentId],
      foreignColumns: [table.id],
      name: "documents_reused_from_document_id_fkey",
    }).onDelete("set null"),
    check(
      "documents_dedup_scope_check",
      sql`dedup_scope = ANY (ARRAY['workspace'::text, 'org'::text])`,
    ),
  ],
);

export const performanceLog = pgTable(
  "performance_log",
  {
    id: text().primaryKey().notNull(),
    userId: text("user_id").notNull(),
    runId: text("run_id"),
    documentId: text("document_id"),
    scope: text().notNull(),
    stageName: text("stage_name").notNull(),
    metric: text().notNull(),
    pageNumber: integer("page_number"),
    value: numeric({ precision: 16, scale: 4 }).notNull(),
    unit: text().notNull(),
    tags: text().array().default([""]).notNull(),
    metadata: jsonb().default({}).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("performance_log_document_id_idx").using(
      "btree",
      table.documentId.asc().nullsLast().op("text_ops"),
      table.createdAt.desc().nullsFirst().op("timestamptz_ops"),
    ),
    index("performance_log_run_id_idx").using(
      "btree",
      table.runId.asc().nullsLast().op("timestamptz_ops"),
      table.createdAt.desc().nullsFirst().op("timestamptz_ops"),
    ),
    index("performance_log_stage_name_idx").using(
      "btree",
      table.stageName.asc().nullsLast().op("text_ops"),
      table.createdAt.desc().nullsFirst().op("text_ops"),
    ),
    foreignKey({
      columns: [table.runId],
      foreignColumns: [workspaceRuns.id],
      name: "performance_log_run_id_fkey",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.documentId],
      foreignColumns: [documents.id],
      name: "performance_log_document_id_fkey",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [user.id],
      name: "performance_log_user_id_fkey",
    }).onDelete("cascade"),
  ],
);

export const workspaceRunEvents = pgTable(
  "workspace_run_events",
  {
    id: text().primaryKey().notNull(),
    userId: text("user_id").notNull(),
    runId: text("run_id").notNull(),
    documentId: text("document_id"),
    stageName: text("stage_name"),
    eventType: text("event_type").notNull(),
    status: text(),
    message: text(),
    progress: jsonb().default({}).notNull(),
    stats: jsonb().default({}).notNull(),
    payload: jsonb().default({}).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("workspace_run_events_run_id_idx").using(
      "btree",
      table.runId.asc().nullsLast().op("text_ops"),
      table.createdAt.desc().nullsFirst().op("text_ops"),
    ),
    index("workspace_run_events_user_id_idx").using(
      "btree",
      table.userId.asc().nullsLast().op("text_ops"),
      table.createdAt.desc().nullsFirst().op("text_ops"),
    ),
    foreignKey({
      columns: [table.runId],
      foreignColumns: [workspaceRuns.id],
      name: "workspace_run_events_run_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.documentId],
      foreignColumns: [documents.id],
      name: "workspace_run_events_document_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [user.id],
      name: "workspace_run_events_user_id_fkey",
    }).onDelete("cascade"),
  ],
);

export const workspaceSecrets = pgTable(
  "workspace_secrets",
  {
    id: text().primaryKey().notNull(),
    workspaceId: text("workspace_id").notNull(),
    name: text().notNull(),
    type: text().notNull(),
    encryptedValue: text("encrypted_value").notNull(),
    rotatedAt: timestamp("rotated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "string" }),
    lastUsedAt: timestamp("last_used_at", {
      withTimezone: true,
      mode: "string",
    }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("workspace_secrets_expires_at_idx")
      .using("btree", table.expiresAt.asc().nullsLast().op("timestamptz_ops"))
      .where(sql`(expires_at IS NOT NULL)`),
    index("workspace_secrets_workspace_id_idx").using(
      "btree",
      table.workspaceId.asc().nullsLast().op("text_ops"),
    ),
    foreignKey({
      columns: [table.workspaceId],
      foreignColumns: [workspaces.id],
      name: "workspace_secrets_workspace_id_fkey",
    }).onDelete("cascade"),
    unique("workspace_secrets_workspace_id_name_key").on(
      table.workspaceId,
      table.name,
    ),
  ],
);

export const schemaMigrations = pgTable("schema_migrations", {
  name: text().primaryKey().notNull(),
  checksum: text().notNull(),
  appliedAt: timestamp("applied_at", { withTimezone: true, mode: "string" })
    .defaultNow()
    .notNull(),
  executionMs: integer("execution_ms").default(0).notNull(),
});

export const user = pgTable(
  "user",
  {
    id: text().primaryKey().notNull(),
    name: text().notNull(),
    email: text().notNull(),
    emailVerified: boolean().default(false).notNull(),
    image: text(),
    createdAt: timestamp({ withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp({ withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [unique("user_email_key").on(table.email)],
);

export const session = pgTable(
  "session",
  {
    id: text().primaryKey().notNull(),
    expiresAt: timestamp({ withTimezone: true, mode: "string" }).notNull(),
    token: text().notNull(),
    createdAt: timestamp({ withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp({ withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    ipAddress: text(),
    userAgent: text(),
    userId: text().notNull(),
  },
  (table) => [
    index("session_user_id_idx").using(
      "btree",
      table.userId.asc().nullsLast().op("text_ops"),
    ),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [user.id],
      name: "session_userId_fkey",
    }).onDelete("cascade"),
    unique("session_token_key").on(table.token),
  ],
);

export const verification = pgTable(
  "verification",
  {
    id: text().primaryKey().notNull(),
    identifier: text().notNull(),
    value: text().notNull(),
    expiresAt: timestamp({ withTimezone: true, mode: "string" }).notNull(),
    createdAt: timestamp({ withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp({ withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("verification_identifier_idx").using(
      "btree",
      table.identifier.asc().nullsLast().op("text_ops"),
    ),
  ],
);

export const account = pgTable(
  "account",
  {
    id: text().primaryKey().notNull(),
    accountId: text().notNull(),
    providerId: text().notNull(),
    userId: text().notNull(),
    accessToken: text(),
    refreshToken: text(),
    idToken: text(),
    accessTokenExpiresAt: timestamp({ withTimezone: true, mode: "string" }),
    refreshTokenExpiresAt: timestamp({ withTimezone: true, mode: "string" }),
    scope: text(),
    password: text(),
    createdAt: timestamp({ withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp({ withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("account_provider_account_idx").using(
      "btree",
      table.providerId.asc().nullsLast().op("text_ops"),
      table.accountId.asc().nullsLast().op("text_ops"),
    ),
    index("account_user_id_idx").using(
      "btree",
      table.userId.asc().nullsLast().op("text_ops"),
    ),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [user.id],
      name: "account_userId_fkey",
    }).onDelete("cascade"),
  ],
);

export const workspaceInvites = pgTable(
  "workspace_invites",
  {
    id: text().primaryKey().notNull(),
    workspaceId: text("workspace_id").notNull(),
    orgId: text("org_id").notNull(),
    email: text().notNull(),
    role: text().notNull(),
    token: text().notNull(),
    status: text().default("pending").notNull(),
    invitedByUserId: text("invited_by_user_id").notNull(),
    acceptedByUserId: text("accepted_by_user_id"),
    expiresAt: timestamp("expires_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    acceptedAt: timestamp("accepted_at", {
      withTimezone: true,
      mode: "string",
    }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("workspace_invites_email_idx").using(
      "btree",
      table.email.asc().nullsLast().op("text_ops"),
      table.status.asc().nullsLast().op("timestamptz_ops"),
      table.createdAt.desc().nullsFirst().op("timestamptz_ops"),
    ),
    index("workspace_invites_workspace_id_idx").using(
      "btree",
      table.workspaceId.asc().nullsLast().op("timestamptz_ops"),
      table.createdAt.desc().nullsFirst().op("text_ops"),
    ),
    foreignKey({
      columns: [table.workspaceId],
      foreignColumns: [workspaces.id],
      name: "workspace_invites_workspace_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.orgId],
      foreignColumns: [organizations.id],
      name: "workspace_invites_org_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.acceptedByUserId],
      foreignColumns: [user.id],
      name: "workspace_invites_accepted_by_user_id_fkey",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.invitedByUserId],
      foreignColumns: [user.id],
      name: "workspace_invites_invited_by_user_id_fkey",
    }).onDelete("cascade"),
    unique("workspace_invites_token_key").on(table.token),
  ],
);

export const documentCorrections = pgTable(
  "document_corrections",
  {
    id: text().primaryKey().notNull(),
    documentId: text("document_id").notNull(),
    runId: text("run_id"),
    userId: text("user_id").notNull(),
    correctedMarkdown: text("corrected_markdown"),
    correctedStructuredData: jsonb("corrected_structured_data"),
    notes: text(),
    reindexRequestedAt: timestamp("reindex_requested_at", {
      withTimezone: true,
      mode: "string",
    }),
    reindexCompletedAt: timestamp("reindex_completed_at", {
      withTimezone: true,
      mode: "string",
    }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("document_corrections_run_id_idx").using(
      "btree",
      table.runId.asc().nullsLast().op("text_ops"),
      table.updatedAt.desc().nullsFirst().op("timestamptz_ops"),
    ),
    index("document_corrections_user_id_idx").using(
      "btree",
      table.userId.asc().nullsLast().op("text_ops"),
      table.updatedAt.desc().nullsFirst().op("text_ops"),
    ),
    foreignKey({
      columns: [table.documentId],
      foreignColumns: [documents.id],
      name: "document_corrections_document_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.runId],
      foreignColumns: [workspaceRuns.id],
      name: "document_corrections_run_id_fkey",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [user.id],
      name: "document_corrections_user_id_fkey",
    }).onDelete("cascade"),
    unique("document_corrections_document_id_key").on(table.documentId),
  ],
);

export const pageStageStates = pgTable(
  "page_stage_states",
  {
    id: text().default(sql`gen_random_uuid()`).primaryKey().notNull(),
    runId: text("run_id").notNull(),
    documentId: text("document_id").notNull(),
    stageName: text("stage_name").notNull(),
    pageNumber: integer("page_number").notNull(),
    status: text().default("completed").notNull(),
    completedAt: timestamp("completed_at", {
      withTimezone: true,
      mode: "string",
    }).defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("page_stage_states_run_doc_stage_idx").using(
      "btree",
      table.runId.asc().nullsLast().op("text_ops"),
      table.documentId.asc().nullsLast().op("text_ops"),
      table.stageName.asc().nullsLast().op("text_ops"),
    ),
    uniqueIndex("page_stage_states_unique_idx").using(
      "btree",
      table.runId.asc().nullsLast().op("text_ops"),
      table.documentId.asc().nullsLast().op("text_ops"),
      table.stageName.asc().nullsLast().op("int4_ops"),
      table.pageNumber.asc().nullsLast().op("text_ops"),
    ),
    foreignKey({
      columns: [table.runId],
      foreignColumns: [workspaceRuns.id],
      name: "page_stage_states_run_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.documentId],
      foreignColumns: [documents.id],
      name: "page_stage_states_document_id_fkey",
    }).onDelete("cascade"),
  ],
);

export const workspaceConnectors = pgTable(
  "workspace_connectors",
  {
    id: text().default(sql`gen_random_uuid()`).primaryKey().notNull(),
    workspaceId: text("workspace_id").notNull(),
    type: text().notNull(),
    name: text().notNull(),
    credentialsEncrypted: text("credentials_encrypted").default("").notNull(),
    config: jsonb().default({}).notNull(),
    status: text().default("active").notNull(),
    lastSyncAt: timestamp("last_sync_at", {
      withTimezone: true,
      mode: "string",
    }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("idx_workspace_connectors_status").using(
      "btree",
      table.status.asc().nullsLast().op("text_ops"),
    ),
    index("idx_workspace_connectors_workspace_id").using(
      "btree",
      table.workspaceId.asc().nullsLast().op("text_ops"),
    ),
    foreignKey({
      columns: [table.workspaceId],
      foreignColumns: [workspaces.id],
      name: "workspace_connectors_workspace_id_fkey",
    }).onDelete("cascade"),
  ],
);

export const webhooks = pgTable(
  "webhooks",
  {
    id: text().primaryKey().notNull(),
    userId: text("user_id").notNull(),
    url: text().notNull(),
    secret: text().notNull(),
    events: text().array().default(["run.completed", "run.failed"]).notNull(),
    active: boolean().default(true).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("webhooks_user_id_idx").using(
      "btree",
      table.userId.asc().nullsLast().op("text_ops"),
    ),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [user.id],
      name: "webhooks_user_id_fkey",
    }).onDelete("cascade"),
  ],
);

export const documentChunks = pgTable(
  "document_chunks",
  {
    id: text().primaryKey().notNull(),
    documentId: text("document_id").notNull(),
    runId: text("run_id").notNull(),
    userId: text("user_id").notNull(),
    chunkIndex: integer("chunk_index").notNull(),
    text: text().notNull(),
    headingPath: text("heading_path").array().default([""]).notNull(),
    pageNumber: integer("page_number"),
    tokenEstimate: integer("token_estimate").default(0).notNull(),
    metadata: jsonb().default({}).notNull(),
    contentHash: text("content_hash"),
    pipelineVersion: text("pipeline_version"),
    parentPageId: text("parent_page_id"),
    tsContent: tsvector("ts_content").generatedAlwaysAs(
      sql`to_tsvector('english'::regconfig, text)`,
    ),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("document_chunks_ts_content_idx").using(
      "gin",
      table.tsContent.asc().nullsLast().op("tsvector_ops"),
    ),
    index("document_chunks_ts_content_idx1").using(
      "gin",
      table.tsContent.asc().nullsLast().op("tsvector_ops"),
    ),
    index("document_chunks_user_id_run_id_idx").using(
      "btree",
      table.userId.asc().nullsLast().op("text_ops"),
      table.runId.asc().nullsLast().op("text_ops"),
    ),
    index("document_chunks_user_id_run_id_idx1").using(
      "btree",
      table.userId.asc().nullsLast().op("text_ops"),
      table.runId.asc().nullsLast().op("text_ops"),
    ),
    foreignKey({
      columns: [table.documentId],
      foreignColumns: [documents.id],
      name: "document_chunks_document_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.runId],
      foreignColumns: [workspaceRuns.id],
      name: "document_chunks_run_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.parentPageId],
      foreignColumns: [documentPages.id],
      name: "document_chunks_parent_page_id_fkey",
    }),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [user.id],
      name: "document_chunks_user_id_fkey",
    }).onDelete("cascade"),
  ],
);

export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: text().primaryKey().notNull(),
    webhookId: text("webhook_id").notNull(),
    userId: text("user_id").notNull(),
    eventType: text("event_type").notNull(),
    targetUrl: text("target_url").notNull(),
    payload: jsonb().default({}).notNull(),
    responseStatus: integer("response_status"),
    responseBody: text("response_body"),
    delivered: boolean().default(false).notNull(),
    error: text(),
    replayOfDeliveryId: text("replay_of_delivery_id"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("webhook_deliveries_user_id_idx").using(
      "btree",
      table.userId.asc().nullsLast().op("text_ops"),
      table.createdAt.desc().nullsFirst().op("timestamptz_ops"),
    ),
    index("webhook_deliveries_webhook_id_idx").using(
      "btree",
      table.webhookId.asc().nullsLast().op("timestamptz_ops"),
      table.createdAt.desc().nullsFirst().op("text_ops"),
    ),
    foreignKey({
      columns: [table.webhookId],
      foreignColumns: [webhooks.id],
      name: "webhook_deliveries_webhook_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.replayOfDeliveryId],
      foreignColumns: [table.id],
      name: "webhook_deliveries_replay_of_delivery_id_fkey",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [user.id],
      name: "webhook_deliveries_user_id_fkey",
    }).onDelete("cascade"),
  ],
);

export const notificationPrefs = pgTable(
  "notification_prefs",
  {
    userId: text("user_id").primaryKey().notNull(),
    orgId: text("org_id"),
    workspaceId: text("workspace_id"),
    runCompleted: boolean("run_completed").default(true).notNull(),
    runFailed: boolean("run_failed").default(true).notNull(),
    qualityWarning: boolean("quality_warning").default(true).notNull(),
    costAlert: boolean("cost_alert").default(true).notNull(),
    workspaceInvite: boolean("workspace_invite").default(true).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.orgId],
      foreignColumns: [organizations.id],
      name: "notification_prefs_org_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.workspaceId],
      foreignColumns: [workspaces.id],
      name: "notification_prefs_workspace_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [user.id],
      name: "notification_prefs_user_id_fkey",
    }).onDelete("cascade"),
  ],
);

export const documentPages = pgTable(
  "document_pages",
  {
    id: text().primaryKey().notNull(),
    documentId: text("document_id").notNull(),
    runId: text("run_id").notNull(),
    userId: text("user_id").notNull(),
    pageNumber: integer("page_number").notNull(),
    text: text().notNull(),
    tokenEstimate: integer("token_estimate").default(0).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("document_pages_document_id_page_number_idx").using(
      "btree",
      table.documentId.asc().nullsLast().op("int4_ops"),
      table.pageNumber.asc().nullsLast().op("int4_ops"),
    ),
    index("document_pages_document_id_page_number_idx1").using(
      "btree",
      table.documentId.asc().nullsLast().op("int4_ops"),
      table.pageNumber.asc().nullsLast().op("int4_ops"),
    ),
    index("document_pages_run_id_idx").using(
      "btree",
      table.runId.asc().nullsLast().op("text_ops"),
    ),
    index("document_pages_run_id_idx1").using(
      "btree",
      table.runId.asc().nullsLast().op("text_ops"),
    ),
    foreignKey({
      columns: [table.documentId],
      foreignColumns: [documents.id],
      name: "document_pages_document_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.runId],
      foreignColumns: [workspaceRuns.id],
      name: "document_pages_run_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [user.id],
      name: "document_pages_user_id_fkey",
    }).onDelete("cascade"),
  ],
);

export const notificationDeliveries = pgTable(
  "notification_deliveries",
  {
    id: text().primaryKey().notNull(),
    userId: text("user_id").notNull(),
    orgId: text("org_id"),
    workspaceId: text("workspace_id"),
    eventType: text("event_type").notNull(),
    provider: text().notNull(),
    recipient: text().notNull(),
    subject: text().notNull(),
    delivered: boolean().default(false).notNull(),
    metadata: jsonb().default({}).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    readAt: timestamp("read_at", { withTimezone: true, mode: "string" }),
  },
  (table) => [
    index("notification_deliveries_user_id_idx").using(
      "btree",
      table.userId.asc().nullsLast().op("text_ops"),
      table.createdAt.desc().nullsFirst().op("text_ops"),
    ),
    index("notification_deliveries_user_read_idx").using(
      "btree",
      table.userId.asc().nullsLast().op("timestamptz_ops"),
      table.readAt.asc().nullsLast().op("text_ops"),
      table.createdAt.desc().nullsFirst().op("timestamptz_ops"),
    ),
    index("notification_deliveries_workspace_id_idx").using(
      "btree",
      table.workspaceId.asc().nullsLast().op("timestamptz_ops"),
      table.createdAt.desc().nullsFirst().op("text_ops"),
    ),
    foreignKey({
      columns: [table.orgId],
      foreignColumns: [organizations.id],
      name: "notification_deliveries_org_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.workspaceId],
      foreignColumns: [workspaces.id],
      name: "notification_deliveries_workspace_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [user.id],
      name: "notification_deliveries_user_id_fkey",
    }).onDelete("cascade"),
  ],
);

export const apiKeys = pgTable(
  "api_keys",
  {
    id: text().primaryKey().notNull(),
    userId: text("user_id").notNull(),
    keyHash: text("key_hash").notNull(),
    name: text().notNull(),
    keyType: text("key_type").default("server").notNull(),
    allowedDomains: text("allowed_domains").array().default([]).notNull(),
    scopes: text().array().default(["ingest", "search", "artifacts"]).notNull(),
    rateLimitRpm: integer("rate_limit_rpm").default(60).notNull(),
    rateLimitPpd: integer("rate_limit_ppd").default(10000).notNull(),
    rateLimits: jsonb("rate_limits").default([]).notNull(),
    lastUsedAt: timestamp("last_used_at", {
      withTimezone: true,
      mode: "string",
    }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "string" }),
    orgId: text("org_id"),
  },
  (table) => [
    index("api_keys_org_id_idx").using(
      "btree",
      table.orgId.asc().nullsLast().op("text_ops"),
      table.createdAt.desc().nullsFirst().op("text_ops"),
    ),
    foreignKey({
      columns: [table.orgId],
      foreignColumns: [organizations.id],
      name: "api_keys_org_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [user.id],
      name: "api_keys_user_id_fkey",
    }).onDelete("cascade"),
    unique("api_keys_key_hash_key").on(table.keyHash),
  ],
);

export const documentSummaries = pgTable(
  "document_summaries",
  {
    id: text().primaryKey().notNull(),
    documentId: text("document_id").notNull(),
    runId: text("run_id").notNull(),
    userId: text("user_id").notNull(),
    summary: text().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("document_summaries_user_id_run_id_idx").using(
      "btree",
      table.userId.asc().nullsLast().op("text_ops"),
      table.runId.asc().nullsLast().op("text_ops"),
    ),
    index("document_summaries_user_id_run_id_idx1").using(
      "btree",
      table.userId.asc().nullsLast().op("text_ops"),
      table.runId.asc().nullsLast().op("text_ops"),
    ),
    foreignKey({
      columns: [table.documentId],
      foreignColumns: [documents.id],
      name: "document_summaries_document_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.runId],
      foreignColumns: [workspaceRuns.id],
      name: "document_summaries_run_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [user.id],
      name: "document_summaries_user_id_fkey",
    }).onDelete("cascade"),
  ],
);

export const searchSessions = pgTable(
  "search_sessions",
  {
    id: text().primaryKey().notNull(),
    userId: text("user_id").notNull(),
    query: text().notNull(),
    variant: text(),
    resultCount: integer("result_count").default(0).notNull(),
    metadata: jsonb().default({}).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("search_sessions_user_id_created_at_idx").using(
      "btree",
      table.userId.asc().nullsLast().op("text_ops"),
      table.createdAt.desc().nullsFirst().op("text_ops"),
    ),
    index("search_sessions_user_id_created_at_idx1").using(
      "btree",
      table.userId.asc().nullsLast().op("text_ops"),
      table.createdAt.desc().nullsFirst().op("text_ops"),
    ),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [user.id],
      name: "search_sessions_user_id_fkey",
    }).onDelete("cascade"),
  ],
);

export const searchSessionResults = pgTable(
  "search_session_results",
  {
    id: text().primaryKey().notNull(),
    sessionId: text("session_id").notNull(),
    chunkId: text("chunk_id").notNull(),
    rank: integer().notNull(),
    score: numeric({ precision: 8, scale: 6 }).default("0").notNull(),
    clicked: boolean().default(false).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("search_session_results_chunk_id_idx").using(
      "btree",
      table.chunkId.asc().nullsLast().op("text_ops"),
    ),
    index("search_session_results_chunk_id_idx1").using(
      "btree",
      table.chunkId.asc().nullsLast().op("text_ops"),
    ),
    index("search_session_results_session_id_idx").using(
      "btree",
      table.sessionId.asc().nullsLast().op("text_ops"),
    ),
    index("search_session_results_session_id_idx1").using(
      "btree",
      table.sessionId.asc().nullsLast().op("text_ops"),
    ),
    foreignKey({
      columns: [table.sessionId],
      foreignColumns: [searchSessions.id],
      name: "search_session_results_session_id_fkey",
    }).onDelete("cascade"),
  ],
);

export const auditLog = pgTable(
  "audit_log",
  {
    id: text().primaryKey().notNull(),
    orgId: text("org_id"),
    userId: text("user_id"),
    workspaceId: text("workspace_id"),
    runId: text("run_id"),
    documentId: text("document_id"),
    apiKeyId: text("api_key_id"),
    action: text().notNull(),
    resourceType: text("resource_type").notNull(),
    resourceId: text("resource_id"),
    ipAddress: text("ip_address"),
    metadata: jsonb().default({}).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("audit_log_action_idx").using(
      "btree",
      table.action.asc().nullsLast().op("text_ops"),
      table.createdAt.desc().nullsFirst().op("timestamptz_ops"),
    ),
    index("audit_log_created_at_idx").using(
      "btree",
      table.createdAt.desc().nullsFirst().op("timestamptz_ops"),
      table.id.desc().nullsFirst().op("timestamptz_ops"),
    ),
    index("audit_log_org_id_idx").using(
      "btree",
      table.orgId.asc().nullsLast().op("timestamptz_ops"),
      table.createdAt.desc().nullsFirst().op("text_ops"),
    ),
    index("audit_log_resource_idx").using(
      "btree",
      table.resourceType.asc().nullsLast().op("timestamptz_ops"),
      table.resourceId.asc().nullsLast().op("timestamptz_ops"),
      table.createdAt.desc().nullsFirst().op("text_ops"),
    ),
    index("audit_log_run_id_idx").using(
      "btree",
      table.runId.asc().nullsLast().op("text_ops"),
      table.createdAt.desc().nullsFirst().op("text_ops"),
    ),
    index("audit_log_user_id_idx").using(
      "btree",
      table.userId.asc().nullsLast().op("text_ops"),
      table.createdAt.desc().nullsFirst().op("text_ops"),
    ),
    index("audit_log_workspace_id_idx").using(
      "btree",
      table.workspaceId.asc().nullsLast().op("timestamptz_ops"),
      table.createdAt.desc().nullsFirst().op("text_ops"),
    ),
    foreignKey({
      columns: [table.orgId],
      foreignColumns: [organizations.id],
      name: "audit_log_org_id_fkey",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.workspaceId],
      foreignColumns: [workspaces.id],
      name: "audit_log_workspace_id_fkey",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.runId],
      foreignColumns: [workspaceRuns.id],
      name: "audit_log_run_id_fkey",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.documentId],
      foreignColumns: [documents.id],
      name: "audit_log_document_id_fkey",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.apiKeyId],
      foreignColumns: [apiKeys.id],
      name: "audit_log_api_key_id_fkey",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [user.id],
      name: "audit_log_user_id_fkey",
    }).onDelete("set null"),
  ],
);

export const searchEvalFixtures = pgTable(
  "search_eval_fixtures",
  {
    id: text().primaryKey().notNull(),
    userId: text("user_id").notNull(),
    runId: text("run_id"),
    question: text().notNull(),
    expectedChunkIds: text("expected_chunk_ids")
      .array()
      .default([""])
      .notNull(),
    tags: text().array().default([""]).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("search_eval_fixtures_user_id_idx").using(
      "btree",
      table.userId.asc().nullsLast().op("text_ops"),
    ),
    index("search_eval_fixtures_user_id_idx1").using(
      "btree",
      table.userId.asc().nullsLast().op("text_ops"),
    ),
    foreignKey({
      columns: [table.runId],
      foreignColumns: [workspaceRuns.id],
      name: "search_eval_fixtures_run_id_fkey",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [user.id],
      name: "search_eval_fixtures_user_id_fkey",
    }).onDelete("cascade"),
  ],
);

export const searchIndexStaleness = pgTable(
  "search_index_staleness",
  {
    id: text().primaryKey().notNull(),
    userId: text("user_id").notNull(),
    runId: text("run_id").notNull(),
    documentId: text("document_id").notNull(),
    reason: text().notNull(),
    detectedAt: timestamp("detected_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    reindexQueuedAt: timestamp("reindex_queued_at", {
      withTimezone: true,
      mode: "string",
    }),
    reindexCompletedAt: timestamp("reindex_completed_at", {
      withTimezone: true,
      mode: "string",
    }),
  },
  (table) => [
    index("search_index_staleness_run_id_idx").using(
      "btree",
      table.runId.asc().nullsLast().op("text_ops"),
    ),
    index("search_index_staleness_run_id_idx1").using(
      "btree",
      table.runId.asc().nullsLast().op("text_ops"),
    ),
    index("search_index_staleness_user_id_detected_at_idx").using(
      "btree",
      table.userId.asc().nullsLast().op("timestamptz_ops"),
      table.detectedAt.desc().nullsFirst().op("text_ops"),
    ),
    index("search_index_staleness_user_id_detected_at_idx1").using(
      "btree",
      table.userId.asc().nullsLast().op("text_ops"),
      table.detectedAt.desc().nullsFirst().op("text_ops"),
    ),
    foreignKey({
      columns: [table.runId],
      foreignColumns: [workspaceRuns.id],
      name: "search_index_staleness_run_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.documentId],
      foreignColumns: [documents.id],
      name: "search_index_staleness_document_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [user.id],
      name: "search_index_staleness_user_id_fkey",
    }).onDelete("cascade"),
  ],
);

export const documentPropositions = pgTable(
  "document_propositions",
  {
    id: text().primaryKey().notNull(),
    documentId: text("document_id").notNull(),
    runId: text("run_id").notNull(),
    userId: text("user_id").notNull(),
    chunkIndex: integer("chunk_index").notNull(),
    text: text().notNull(),
    sourceParagraph: text("source_paragraph").notNull(),
    tokenEstimate: integer("token_estimate").default(0).notNull(),
    tsContent: tsvector("ts_content").generatedAlwaysAs(
      sql`to_tsvector('english'::regconfig, text)`,
    ),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("document_propositions_document_id_idx").using(
      "btree",
      table.documentId.asc().nullsLast().op("text_ops"),
    ),
    index("document_propositions_document_id_idx1").using(
      "btree",
      table.documentId.asc().nullsLast().op("text_ops"),
    ),
    index("document_propositions_ts_content_idx").using(
      "gin",
      table.tsContent.asc().nullsLast().op("tsvector_ops"),
    ),
    index("document_propositions_ts_content_idx1").using(
      "gin",
      table.tsContent.asc().nullsLast().op("tsvector_ops"),
    ),
    index("document_propositions_user_id_run_id_idx").using(
      "btree",
      table.userId.asc().nullsLast().op("text_ops"),
      table.runId.asc().nullsLast().op("text_ops"),
    ),
    index("document_propositions_user_id_run_id_idx1").using(
      "btree",
      table.userId.asc().nullsLast().op("text_ops"),
      table.runId.asc().nullsLast().op("text_ops"),
    ),
    foreignKey({
      columns: [table.documentId],
      foreignColumns: [documents.id],
      name: "document_propositions_document_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.runId],
      foreignColumns: [workspaceRuns.id],
      name: "document_propositions_run_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [user.id],
      name: "document_propositions_user_id_fkey",
    }).onDelete("cascade"),
  ],
);

export const idempotencyCache = pgTable(
  "idempotency_cache",
  {
    id: text().default(sql`gen_random_uuid()`).primaryKey().notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    routeKey: text("route_key").notNull(),
    requestHash: text("request_hash").notNull(),
    userId: text("user_id"),
    responseStatus: integer("response_status").notNull(),
    responseBody: jsonb("response_body").default({}).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    expiresAt: timestamp("expires_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
  },
  (table) => [
    index("idempotency_cache_expires_at_idx").using(
      "btree",
      table.expiresAt.asc().nullsLast().op("timestamptz_ops"),
    ),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [user.id],
      name: "idempotency_cache_user_id_fkey",
    }).onDelete("set null"),
    unique("idempotency_cache_idempotency_key_route_key_key").on(
      table.idempotencyKey,
      table.routeKey,
    ),
  ],
);

export const searchExperiments = pgTable(
  "search_experiments",
  {
    id: text().primaryKey().notNull(),
    userId: text("user_id").notNull(),
    name: text().notNull(),
    description: text(),
    controlConfig: jsonb("control_config").default({}).notNull(),
    treatmentConfig: jsonb("treatment_config").default({}).notNull(),
    trafficPercent: integer("traffic_percent").default(50).notNull(),
    active: boolean().default(true).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true, mode: "string" }),
  },
  (table) => [
    index("search_experiments_user_id_active_idx").using(
      "btree",
      table.userId.asc().nullsLast().op("text_ops"),
      table.active.asc().nullsLast().op("bool_ops"),
    ),
    index("search_experiments_user_id_active_idx1").using(
      "btree",
      table.userId.asc().nullsLast().op("text_ops"),
      table.active.asc().nullsLast().op("text_ops"),
    ),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [user.id],
      name: "search_experiments_user_id_fkey",
    }).onDelete("cascade"),
    unique("search_experiments_name_key").on(table.name),
    check(
      "search_experiments_traffic_percent_check",
      sql`(traffic_percent >= 0) AND (traffic_percent <= 100)`,
    ),
  ],
);

export const chatSessions = pgTable(
  "chat_sessions",
  {
    id: text().primaryKey().notNull(),
    workspaceId: text("workspace_id").notNull(),
    userId: text("user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    /** Thread-scoped retrieval overrides set from chat; never the workspace defaults. */
    searchOverrides: jsonb("search_overrides").default({}).notNull(),
  },
  (table) => [
    index("chat_sessions_user_id_idx").using(
      "btree",
      table.userId.asc().nullsLast().op("text_ops"),
      table.createdAt.desc().nullsFirst().op("timestamptz_ops"),
    ),
    index("chat_sessions_workspace_id_idx").using(
      "btree",
      table.workspaceId.asc().nullsLast().op("timestamptz_ops"),
      table.createdAt.desc().nullsFirst().op("text_ops"),
    ),
    foreignKey({
      columns: [table.workspaceId],
      foreignColumns: [workspaces.id],
      name: "chat_sessions_workspace_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [user.id],
      name: "chat_sessions_user_id_fkey",
    }).onDelete("cascade"),
  ],
);

export const chatTurns = pgTable(
  "chat_turns",
  {
    id: text().primaryKey().notNull(),
    sessionId: text("session_id").notNull(),
    role: text().notNull(),
    content: text().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("chat_turns_session_id_idx").using(
      "btree",
      table.sessionId.asc().nullsLast().op("text_ops"),
      table.createdAt.asc().nullsLast().op("text_ops"),
    ),
    foreignKey({
      columns: [table.sessionId],
      foreignColumns: [chatSessions.id],
      name: "chat_turns_session_id_fkey",
    }).onDelete("cascade"),
  ],
);

export const chatMessageFeedback = pgTable(
  "chat_message_feedback",
  {
    id: text().primaryKey().notNull(),
    workspaceId: text("workspace_id").notNull(),
    userId: text("user_id").notNull(),
    threadId: text("thread_id"),
    messageId: text("message_id").notNull(),
    rating: text().notNull(),
    comment: text(),
    question: text(),
    answer: text(),
    model: text(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("chat_message_feedback_user_workspace_message_idx").using(
      "btree",
      table.userId.asc().nullsLast().op("text_ops"),
      table.workspaceId.asc().nullsLast().op("text_ops"),
      table.messageId.asc().nullsLast().op("text_ops"),
    ),
    index("chat_message_feedback_workspace_id_idx").using(
      "btree",
      table.workspaceId.asc().nullsLast().op("text_ops"),
      table.createdAt.desc().nullsFirst().op("timestamptz_ops"),
    ),
    foreignKey({
      columns: [table.workspaceId],
      foreignColumns: [workspaces.id],
      name: "chat_message_feedback_workspace_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [user.id],
      name: "chat_message_feedback_user_id_fkey",
    }).onDelete("cascade"),
    check(
      "chat_message_feedback_rating_check",
      sql`rating = ANY (ARRAY['up'::text, 'down'::text])`,
    ),
  ],
);

export const workspaces = pgTable(
  "workspaces",
  {
    id: text().primaryKey().notNull(),
    userId: text("user_id").notNull(),
    name: text().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    orgId: text("org_id"),
    templateKey: text("template_key"),
    monthlyBudgetCents: integer("monthly_budget_cents"),
    budgetAlertThresholdPercent: integer("budget_alert_threshold_percent")
      .default(80)
      .notNull(),
    budgetAlertLevel: integer("budget_alert_level").default(0).notNull(),
    budgetAlertUpdatedAt: timestamp("budget_alert_updated_at", {
      withTimezone: true,
      mode: "string",
    }),
    artifactRetentionDays: integer("artifact_retention_days"),
    runRetentionDays: integer("run_retention_days"),
    pipeline: jsonb().default({}).notNull(),
    systemPrompt: text("system_prompt"),
    budgetPaused: boolean("budget_paused").default(false).notNull(),
    archivedAt: timestamp("archived_at", {
      withTimezone: true,
      mode: "string",
    }),
    isDefault: boolean("is_default").default(false).notNull(),
    slug: text().default(sql`generate_workspace_slug()`).notNull(),
  },
  (table) => [
    uniqueIndex("workspaces_slug_idx").using("btree", table.slug.asc().nullsLast().op("text_ops")),
    uniqueIndex("workspaces_org_default_idx")
      .using("btree", table.orgId.asc().nullsLast().op("text_ops"))
      .where(sql`is_default`),
    index("workspaces_archived_at_idx").using(
      "btree",
      table.archivedAt.asc().nullsLast().op("timestamptz_ops"),
      table.updatedAt.desc().nullsFirst().op("timestamptz_ops"),
    ),
    index("workspaces_org_id_idx").using(
      "btree",
      table.orgId.asc().nullsLast().op("text_ops"),
      table.updatedAt.desc().nullsFirst().op("text_ops"),
    ),
    index("workspaces_user_id_idx").using(
      "btree",
      table.userId.asc().nullsLast().op("text_ops"),
      table.updatedAt.desc().nullsFirst().op("timestamptz_ops"),
    ),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [user.id],
      name: "workspaces_user_id_fkey",
    }).onDelete("cascade"),
    check(
      "workspaces_system_prompt_length_check",
      sql`(system_prompt IS NULL) OR (char_length(system_prompt) <= 2000)`,
    ),
  ],
);

/** Every slug a workspace has used; old slugs keep resolving after renames. */
export const workspaceSlugs = pgTable(
  "workspace_slugs",
  {
    slug: text().primaryKey().notNull(),
    workspaceId: text("workspace_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("workspace_slugs_workspace_id_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops")),
    foreignKey({
      columns: [table.workspaceId],
      foreignColumns: [workspaces.id],
      name: "workspace_slugs_workspace_id_fkey",
    }).onDelete("cascade"),
  ],
);

export const piiDetections = pgTable(
  "pii_detections",
  {
    id: text().default(sql`gen_random_uuid()`).primaryKey().notNull(),
    documentId: text("document_id").notNull(),
    runId: text("run_id").notNull(),
    patternType: text("pattern_type").notNull(),
    matchedPrefix: text("matched_prefix").notNull(),
    pageNumber: integer("page_number"),
    byteOffset: integer("byte_offset"),
    redacted: boolean().default(false).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("idx_pii_detections_document_id").using(
      "btree",
      table.documentId.asc().nullsLast().op("text_ops"),
    ),
    index("idx_pii_detections_run_id").using(
      "btree",
      table.runId.asc().nullsLast().op("text_ops"),
    ),
    foreignKey({
      columns: [table.documentId],
      foreignColumns: [documents.id],
      name: "pii_detections_document_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.runId],
      foreignColumns: [workspaceRuns.id],
      name: "pii_detections_run_id_fkey",
    }).onDelete("cascade"),
  ],
);

export const chatAnswerEvidenceSpans = pgTable(
  "chat_answer_evidence_spans",
  {
    id: text().primaryKey().notNull(),
    answerId: text("answer_id").notNull(),
    sessionId: text("session_id").notNull(),
    searchSessionId: text("search_session_id"),
    userId: text("user_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    citationIndex: integer("citation_index").notNull(),
    answerStart: integer("answer_start").notNull(),
    answerEnd: integer("answer_end").notNull(),
    answerText: text("answer_text").notNull(),
    sourceText: text("source_text").notNull(),
    sourceStart: integer("source_start").notNull(),
    sourceEnd: integer("source_end").notNull(),
    citation: jsonb().default({}).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("chat_answer_evidence_spans_answer_id_idx").using(
      "btree",
      table.answerId.asc().nullsLast().op("int4_ops"),
      table.citationIndex.asc().nullsLast().op("text_ops"),
    ),
    index("chat_answer_evidence_spans_session_id_idx").using(
      "btree",
      table.sessionId.asc().nullsLast().op("text_ops"),
      table.createdAt.desc().nullsFirst().op("text_ops"),
    ),
    foreignKey({
      columns: [table.sessionId],
      foreignColumns: [chatSessions.id],
      name: "chat_answer_evidence_spans_session_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.searchSessionId],
      foreignColumns: [searchSessions.id],
      name: "chat_answer_evidence_spans_search_session_id_fkey",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.workspaceId],
      foreignColumns: [workspaces.id],
      name: "chat_answer_evidence_spans_workspace_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [user.id],
      name: "chat_answer_evidence_spans_user_id_fkey",
    }).onDelete("cascade"),
  ],
);

export const parserEvalFixtures = pgTable(
  "parser_eval_fixtures",
  {
    id: text().primaryKey().notNull(),
    userId: text("user_id").notNull(),
    runId: text("run_id"),
    documentId: text("document_id").notNull(),
    name: text().notNull(),
    parser: text().notNull(),
    minMatchRatio: numeric("min_match_ratio", { precision: 8, scale: 6 })
      .default("0")
      .notNull(),
    minBboxRatio: numeric("min_bbox_ratio", { precision: 8, scale: 6 })
      .default("0")
      .notNull(),
    minPageRatio: numeric("min_page_ratio", { precision: 8, scale: 6 })
      .default("0")
      .notNull(),
    requireSelected: boolean("require_selected").default(true).notNull(),
    tags: text().array().default([""]).notNull(),
    notes: text(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("parser_eval_fixtures_document_id_idx").using(
      "btree",
      table.documentId.asc().nullsLast().op("timestamptz_ops"),
      table.createdAt.desc().nullsFirst().op("timestamptz_ops"),
    ),
    index("parser_eval_fixtures_parser_idx").using(
      "btree",
      table.parser.asc().nullsLast().op("timestamptz_ops"),
      table.createdAt.desc().nullsFirst().op("timestamptz_ops"),
    ),
    index("parser_eval_fixtures_run_id_idx").using(
      "btree",
      table.runId.asc().nullsLast().op("text_ops"),
      table.createdAt.desc().nullsFirst().op("text_ops"),
    ),
    index("parser_eval_fixtures_user_id_idx").using(
      "btree",
      table.userId.asc().nullsLast().op("timestamptz_ops"),
      table.createdAt.desc().nullsFirst().op("timestamptz_ops"),
    ),
    foreignKey({
      columns: [table.runId],
      foreignColumns: [workspaceRuns.id],
      name: "parser_eval_fixtures_run_id_fkey",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.documentId],
      foreignColumns: [documents.id],
      name: "parser_eval_fixtures_document_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [user.id],
      name: "parser_eval_fixtures_user_id_fkey",
    }).onDelete("cascade"),
  ],
);

export const parserEvalResults = pgTable(
  "parser_eval_results",
  {
    id: text().primaryKey().notNull(),
    userId: text("user_id").notNull(),
    runId: text("run_id").notNull(),
    documentId: text("document_id").notNull(),
    stageName: text("stage_name").notNull(),
    parser: text().notNull(),
    matchedBlocks: integer("matched_blocks").default(0).notNull(),
    bboxBlocks: integer("bbox_blocks").default(0).notNull(),
    pageBackedBlocks: integer("page_backed_blocks").default(0).notNull(),
    matchRatio: numeric("match_ratio", { precision: 8, scale: 6 })
      .default("0")
      .notNull(),
    bboxRatio: numeric("bbox_ratio", { precision: 8, scale: 6 })
      .default("0")
      .notNull(),
    pageRatio: numeric("page_ratio", { precision: 8, scale: 6 })
      .default("0")
      .notNull(),
    selected: boolean().default(false).notNull(),
    artifactUri: text("artifact_uri"),
    metadata: jsonb().default({}).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("parser_eval_results_document_id_idx").using(
      "btree",
      table.documentId.asc().nullsLast().op("timestamptz_ops"),
      table.createdAt.desc().nullsFirst().op("timestamptz_ops"),
    ),
    index("parser_eval_results_parser_idx").using(
      "btree",
      table.parser.asc().nullsLast().op("timestamptz_ops"),
      table.createdAt.desc().nullsFirst().op("timestamptz_ops"),
    ),
    index("parser_eval_results_run_id_idx").using(
      "btree",
      table.runId.asc().nullsLast().op("text_ops"),
      table.createdAt.desc().nullsFirst().op("text_ops"),
    ),
    index("parser_eval_results_user_id_idx").using(
      "btree",
      table.userId.asc().nullsLast().op("timestamptz_ops"),
      table.createdAt.desc().nullsFirst().op("timestamptz_ops"),
    ),
    foreignKey({
      columns: [table.runId],
      foreignColumns: [workspaceRuns.id],
      name: "parser_eval_results_run_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.documentId],
      foreignColumns: [documents.id],
      name: "parser_eval_results_document_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [user.id],
      name: "parser_eval_results_user_id_fkey",
    }).onDelete("cascade"),
  ],
);

export const uploadSessions = pgTable(
  "upload_sessions",
  {
    id: text().primaryKey().notNull(),
    userId: text("user_id").notNull(),
    orgId: text("org_id"),
    workspaceId: text("workspace_id"),
    workspaceName: text("workspace_name"),
    templateKey: text("template_key"),
    pipeline: jsonb().default({}).notNull(),
    status: text().default("pending").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("upload_sessions_user_id_idx").using(
      "btree",
      table.userId.asc().nullsLast().op("text_ops"),
      table.createdAt.desc().nullsFirst().op("text_ops"),
    ),
    index("upload_sessions_workspace_id_idx").using(
      "btree",
      table.workspaceId.asc().nullsLast().op("text_ops"),
      table.createdAt.desc().nullsFirst().op("text_ops"),
    ),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [user.id],
      name: "upload_sessions_user_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.orgId],
      foreignColumns: [organizations.id],
      name: "upload_sessions_org_id_fkey",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.workspaceId],
      foreignColumns: [workspaces.id],
      name: "upload_sessions_workspace_id_fkey",
    }).onDelete("set null"),
  ],
);

export const uploadSessionFiles = pgTable(
  "upload_session_files",
  {
    id: text().primaryKey().notNull(),
    sessionId: text("session_id").notNull(),
    filename: text().notNull(),
    mimeType: text("mime_type").notNull(),
    // You can use { mode: "bigint" } if numbers are exceeding js number limitations
    sizeBytes: bigint("size_bytes", { mode: "number" }).default(0).notNull(),
    sourceKey: text("source_key").notNull(),
    uploadMode: text("upload_mode").notNull(),
    uploadId: text("upload_id"),
    partSize: integer("part_size"),
    status: text().default("pending").notNull(),
    etag: text(),
    completedParts: jsonb("completed_parts").default([]).notNull(),
    sha256: text(),
    canonicalId: text("canonical_id"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("upload_session_files_session_id_idx").using(
      "btree",
      table.sessionId.asc().nullsLast().op("text_ops"),
      table.createdAt.asc().nullsLast().op("text_ops"),
    ),
    index("upload_session_files_source_key_idx").using(
      "btree",
      table.sourceKey.asc().nullsLast().op("text_ops"),
    ),
    foreignKey({
      columns: [table.sessionId],
      foreignColumns: [uploadSessions.id],
      name: "upload_session_files_session_id_fkey",
    }).onDelete("cascade"),
  ],
);

export const workspaceRuns = pgTable(
  "workspace_runs",
  {
    id: text().primaryKey().notNull(),
    userId: text("user_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    kind: text().notNull(),
    status: text().notNull(),
    stage: text().notNull(),
    totalDocuments: integer("total_documents").default(0).notNull(),
    processedDocuments: integer("processed_documents").default(0).notNull(),
    pagesTotal: integer("pages_total").default(0).notNull(),
    pagesProcessed: integer("pages_processed").default(0).notNull(),
    /** @deprecated Replaced by spentCents (migration 0056); no longer read or written, dropped in a later migration. */
    inputCostCents: numeric("input_cost_cents", { precision: 24, scale: 12, mode: "number" }).default(0).notNull(),
    /** @deprecated Replaced by spentCents (migration 0056); no longer read or written, dropped in a later migration. */
    outputCostCents: numeric("output_cost_cents", { precision: 24, scale: 12, mode: "number" }).default(0).notNull(),
    /**
     * Billed run spend checked against the run cost cap: sum(usage_events.cost_cents)
     * for the run, kept by the usage_events_run_spent_cents trigger (0056). Never write it.
     */
    spentCents: numeric("spent_cents", { precision: 24, scale: 12, mode: "number" }).default(0).notNull(),
    pipeline: jsonb().default({}).notNull(),
    stats: jsonb().default({}).notNull(),
    artifacts: jsonb().default({}).notNull(),
    runId: text("run_id"),
    leaseExpiresAt: timestamp("lease_expires_at", {
      withTimezone: true,
      mode: "string",
    }),
    lastHeartbeatAt: timestamp("last_heartbeat_at", {
      withTimezone: true,
      mode: "string",
    }),
    error: text(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    orgId: text("org_id"),
    priority: integer().default(0).notNull(),
    controlState: text("control_state"),
    controlRequestedAt: timestamp("control_requested_at", {
      withTimezone: true,
      mode: "string",
    }),
    artifactsPurgedAt: timestamp("artifacts_purged_at", {
      withTimezone: true,
      mode: "string",
    }),
    failureCount: integer("failure_count").default(0).notNull(),
    deadLetteredAt: timestamp("dead_lettered_at", {
      withTimezone: true,
      mode: "string",
    }),
    deadLetterReason: text("dead_letter_reason"),
    // Creation publishes this only after every Document is durable.
    creationSourceKeys: text("creation_source_keys").array().default([]).notNull(),
    creationReadyAt: timestamp("creation_ready_at", { withTimezone: true, mode: "string" }),
    creationExpiresAt: timestamp("creation_expires_at", { withTimezone: true, mode: "string" })
      .default(sql`now() + interval '5 minutes'`),
    // Null until a Temporal workflow start is confirmed; run-start recovery
    // retries queued runs without one (0029_run_workflow_start_tracking).
    workflowStartedAt: timestamp("workflow_started_at", {
      withTimezone: true,
      mode: "string",
    }),
    workflowStartAttempts: integer("workflow_start_attempts").default(0).notNull(),
    workflowStartNextAt: timestamp("workflow_start_next_at", {
      withTimezone: true,
      mode: "string",
    }),
  },
  (table) => [
    index("workspace_runs_creation_pending_idx").on(table.creationExpiresAt)
      .where(sql`creation_ready_at IS NULL AND workflow_started_at IS NULL`),
    index("workspace_runs_workflow_start_pending_idx")
      .using("btree", table.createdAt.asc().nullsLast().op("timestamptz_ops"))
      .where(sql`((status = 'queued'::text) AND (workflow_started_at IS NULL))`),
    index("workspace_runs_dead_letter_idx").using(
      "btree",
      table.controlState.asc().nullsLast().op("timestamptz_ops"),
      table.deadLetteredAt.desc().nullsFirst().op("timestamptz_ops"),
    ),
    index("workspace_runs_lease_idx").using(
      "btree",
      table.status.asc().nullsLast().op("timestamptz_ops"),
      table.leaseExpiresAt.asc().nullsLast().op("text_ops"),
    ),
    index("workspace_runs_org_id_idx").using(
      "btree",
      table.orgId.asc().nullsLast().op("timestamptz_ops"),
      table.createdAt.desc().nullsFirst().op("text_ops"),
    ),
    index("workspace_runs_priority_idx").using(
      "btree",
      table.status.asc().nullsLast().op("text_ops"),
      table.priority.desc().nullsFirst().op("int4_ops"),
      table.createdAt.asc().nullsLast().op("timestamptz_ops"),
    ),
    index("workspace_runs_status_idx").using(
      "btree",
      table.status.asc().nullsLast().op("timestamptz_ops"),
      table.createdAt.desc().nullsFirst().op("timestamptz_ops"),
    ),
    index("workspace_runs_workspace_id_idx").using(
      "btree",
      table.workspaceId.asc().nullsLast().op("timestamptz_ops"),
      table.createdAt.desc().nullsFirst().op("timestamptz_ops"),
    ),
    foreignKey({
      columns: [table.workspaceId],
      foreignColumns: [workspaces.id],
      name: "workspace_runs_workspace_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [user.id],
      name: "workspace_runs_user_id_fkey",
    }).onDelete("cascade"),
  ],
);

export const searchZeroResults = pgTable(
  "search_zero_results",
  {
    id: text().primaryKey().notNull(),
    sessionId: text("session_id").notNull(),
    userId: text("user_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    reason: text().notNull(),
    suggestions: jsonb().default([]).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("search_zero_results_user_idx").using(
      "btree",
      table.userId.asc().nullsLast().op("text_ops"),
      table.createdAt.desc().nullsFirst().op("text_ops"),
    ),
    index("search_zero_results_workspace_idx").using(
      "btree",
      table.workspaceId.asc().nullsLast().op("text_ops"),
      table.createdAt.desc().nullsFirst().op("text_ops"),
    ),
    foreignKey({
      columns: [table.sessionId],
      foreignColumns: [searchSessions.id],
      name: "search_zero_results_session_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [user.id],
      name: "search_zero_results_user_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.workspaceId],
      foreignColumns: [workspaces.id],
      name: "search_zero_results_workspace_id_fkey",
    }).onDelete("cascade"),
  ],
);

export const workspaceSearchSettings = pgTable(
  "workspace_search_settings",
  {
    workspaceId: text("workspace_id").primaryKey().notNull(),
    userId: text("user_id").notNull(),
    typoTolerance: boolean("typo_tolerance").default(true).notNull(),
    dedupeByFilename: boolean("dedupe_by_filename").default(true).notNull(),
    rankingRules: jsonb("ranking_rules").default({}).notNull(),
    boosts: jsonb().default({}).notNull(),
    pinnedResults: jsonb("pinned_results").default([]).notNull(),
    synonyms: jsonb().default({}).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    compatSettings: jsonb("compat_settings").default({}).notNull(),
    rules: jsonb().default([]).notNull(),
    compatMetadata: jsonb("compat_metadata").default({}).notNull(),
  },
  (table) => [
    index("workspace_search_settings_updated_idx").using(
      "btree",
      table.updatedAt.desc().nullsFirst().op("timestamptz_ops"),
    ),
    foreignKey({
      columns: [table.workspaceId],
      foreignColumns: [workspaces.id],
      name: "workspace_search_settings_workspace_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [user.id],
      name: "workspace_search_settings_user_id_fkey",
    }).onDelete("cascade"),
  ],
);

export const querySuggestions = pgTable(
  "query_suggestions",
  {
    id: text().primaryKey().notNull(),
    userId: text("user_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    phrase: text().notNull(),
    weight: integer().default(1).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("query_suggestions_ws_idx").using(
      "btree",
      table.workspaceId.asc().nullsLast().op("int4_ops"),
      table.weight.desc().nullsFirst().op("int4_ops"),
      table.createdAt.desc().nullsFirst().op("int4_ops"),
    ),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [user.id],
      name: "query_suggestions_user_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.workspaceId],
      foreignColumns: [workspaces.id],
      name: "query_suggestions_workspace_id_fkey",
    }).onDelete("cascade"),
  ],
);

export const privacyAuditLog = pgTable(
  "privacy_audit_log",
  {
    id: text().default(sql`gen_random_uuid()`).primaryKey().notNull(),
    documentId: text("document_id"),
    runId: text("run_id"),
    workspaceId: text("workspace_id"),
    modelId: text("model_id").notNull(),
    endpoint: text().notNull(),
    privacyMode: text("privacy_mode").default("standard").notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("idx_privacy_audit_log_document_id").using(
      "btree",
      table.documentId.asc().nullsLast().op("text_ops"),
    ),
    index("idx_privacy_audit_log_workspace_id").using(
      "btree",
      table.workspaceId.asc().nullsLast().op("text_ops"),
    ),
    foreignKey({
      columns: [table.documentId],
      foreignColumns: [documents.id],
      name: "privacy_audit_log_document_id_fkey",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.runId],
      foreignColumns: [workspaceRuns.id],
      name: "privacy_audit_log_run_id_fkey",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.workspaceId],
      foreignColumns: [workspaces.id],
      name: "privacy_audit_log_workspace_id_fkey",
    }).onDelete("set null"),
  ],
);

export const connectorSyncLog = pgTable(
  "connector_sync_log",
  {
    id: text().default(sql`gen_random_uuid()`).primaryKey().notNull(),
    connectorId: text("connector_id").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    finishedAt: timestamp("finished_at", {
      withTimezone: true,
      mode: "string",
    }),
    status: text().default("running").notNull(),
    filesAdded: integer("files_added").default(0).notNull(),
    filesUpdated: integer("files_updated").default(0).notNull(),
    filesDeleted: integer("files_deleted").default(0).notNull(),
    errorMessage: text("error_message"),
    costCents: integer("cost_cents").default(0).notNull(),
  },
  (table) => [
    index("idx_connector_sync_log_connector_id").using(
      "btree",
      table.connectorId.asc().nullsLast().op("text_ops"),
    ),
    index("idx_connector_sync_log_started_at").using(
      "btree",
      table.startedAt.desc().nullsFirst().op("timestamptz_ops"),
    ),
    foreignKey({
      columns: [table.connectorId],
      foreignColumns: [workspaceConnectors.id],
      name: "connector_sync_log_connector_id_fkey",
    }).onDelete("cascade"),
  ],
);

export const oauthAccounts = pgTable(
  "oauth_accounts",
  {
    id: text().default(sql`gen_random_uuid()`).primaryKey().notNull(),
    userId: text("user_id").notNull(),
    provider: text().notNull(),
    providerAccountId: text("provider_account_id").notNull(),
    accessTokenEncrypted: bytea("access_token_encrypted"),
    refreshTokenEncrypted: bytea("refresh_token_encrypted"),
    tokenExpiresAt: timestamp("token_expires_at", {
      withTimezone: true,
      mode: "string",
    }),
    rawProfile: jsonb("raw_profile").default({}).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("oauth_accounts_user_id_idx").using(
      "btree",
      table.userId.asc().nullsLast().op("text_ops"),
    ),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [user.id],
      name: "oauth_accounts_user_id_fkey",
    }).onDelete("cascade"),
    unique("oauth_accounts_provider_provider_account_id_key").on(
      table.provider,
      table.providerAccountId,
    ),
  ],
);

export const ssoAuthRequests = pgTable(
  "sso_auth_requests",
  {
    id: text().default(sql`gen_random_uuid()`).primaryKey().notNull(),
    state: text().notNull(),
    orgId: text("org_id").notNull(),
    provider: text().notNull(),
    codeVerifier: text("code_verifier"),
    nonce: text(),
    redirectPath: text("redirect_path"),
    linkUserId: text("link_user_id").references(() => user.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    consumedAt: timestamp("consumed_at", {
      withTimezone: true,
      mode: "string",
    }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("sso_auth_requests_expires_idx").using(
      "btree",
      table.expiresAt.asc().nullsLast().op("timestamptz_ops"),
    ),
    index("sso_auth_requests_org_idx").using(
      "btree",
      table.orgId.asc().nullsLast().op("text_ops"),
    ),
    index("sso_auth_requests_provider_idx").using(
      "btree",
      table.provider.asc().nullsLast().op("text_ops"),
    ),
    foreignKey({
      columns: [table.orgId],
      foreignColumns: [organizations.id],
      name: "sso_auth_requests_org_id_fkey",
    }).onDelete("cascade"),
    unique("sso_auth_requests_state_key").on(table.state),
    check(
      "sso_auth_requests_provider_check",
      sql`provider = ANY (ARRAY['oidc'::text, 'saml'::text])`,
    ),
  ],
);

/**
 * An org's DNS-verified claim on an email domain
 * (server/db/migrations/0032_sso_domain_verification.sql). One org per verified domain.
 */
export const ssoDomains = pgTable("sso_domains", {
  id: text().default(sql`gen_random_uuid()`).primaryKey().notNull(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  domain: text().notNull(),
  verificationToken: text("verification_token").notNull(),
  verifiedAt: timestamp("verified_at", { withTimezone: true, mode: "string" }),
  lastCheckedAt: timestamp("last_checked_at", { withTimezone: true, mode: "string" }),
  lastError: text("last_error"),
  createdByUserId: text("created_by_user_id"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).defaultNow().notNull(),
}, table => [unique("sso_domains_org_domain_key").on(table.orgId, table.domain),
  uniqueIndex("sso_domains_verified_domain_key").on(table.domain).where(sql`verified_at IS NOT NULL`),
  check("sso_domains_domain_lower_check", sql`${table.domain} = lower(${table.domain})`)]);

/** An IdP identity a signed-in user linked to their account for one org. */
export const ssoIdentityLinks = pgTable("sso_identity_links", {
  id: text().default(sql`gen_random_uuid()`).primaryKey().notNull(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  provider: text().notNull(),
  issuer: text().notNull(),
  subject: text().notNull(),
  email: text().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).defaultNow().notNull(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true, mode: "string" }),
}, table => [unique("sso_identity_links_org_user_key").on(table.orgId, table.userId),
  unique("sso_identity_links_identity_key").on(table.orgId, table.provider, table.issuer, table.subject),
  check("sso_identity_links_provider_check", sql`${table.provider} IN ('oidc', 'saml')`)]);

export const stripeWebhookEvents = pgTable(
  "stripe_webhook_events",
  {
    eventId: text("event_id").primaryKey().notNull(),
    eventType: text("event_type").notNull(),
    payload: jsonb().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    processedAt: timestamp("processed_at", {
      withTimezone: true,
      mode: "string",
    })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("stripe_webhook_events_event_type_idx").using(
      "btree",
      table.eventType.asc().nullsLast().op("text_ops"),
    ),
  ],
);

export const kgNodes = pgTable(
  "kg_nodes",
  {
    id: text().primaryKey().notNull(),
    workspaceId: text("workspace_id").notNull(),
    runId: text("run_id").notNull(),
    userId: text("user_id").notNull(),
    canonicalName: text("canonical_name").notNull(),
    normalizedName: text("normalized_name").notNull(),
    entityType: text("entity_type").notNull(),
    aliases: jsonb().default([]).notNull(),
    metadata: jsonb().default({}).notNull(),
    mentionCount: integer("mention_count").default(0).notNull(),
    sourceDocumentCount: integer("source_document_count").default(0).notNull(),
    confidence: numeric({ precision: 5, scale: 4 }).default("0.5").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("kg_nodes_lookup_idx").using(
      "btree",
      table.workspaceId.asc().nullsLast().op("text_ops"),
      table.entityType.asc().nullsLast().op("text_ops"),
      table.normalizedName.asc().nullsLast().op("text_ops"),
    ),
    index("kg_nodes_rank_idx").using(
      "btree",
      table.workspaceId.asc().nullsLast().op("text_ops"),
      table.mentionCount.desc().nullsFirst().op("text_ops"),
      table.sourceDocumentCount.desc().nullsFirst().op("text_ops"),
    ),
    foreignKey({
      columns: [table.workspaceId],
      foreignColumns: [workspaces.id],
      name: "kg_nodes_workspace_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.runId],
      foreignColumns: [workspaceRuns.id],
      name: "kg_nodes_run_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [user.id],
      name: "kg_nodes_user_id_fkey",
    }).onDelete("cascade"),
    unique("kg_nodes_workspace_id_normalized_name_entity_type_key").on(
      table.workspaceId,
      table.normalizedName,
      table.entityType,
    ),
  ],
);

export const kgEdges = pgTable(
  "kg_edges",
  {
    id: text().primaryKey().notNull(),
    workspaceId: text("workspace_id").notNull(),
    runId: text("run_id").notNull(),
    userId: text("user_id").notNull(),
    sourceNodeId: text("source_node_id").notNull(),
    targetNodeId: text("target_node_id").notNull(),
    predicate: text().notNull(),
    normalizedPredicate: text("normalized_predicate").notNull(),
    confidence: numeric({ precision: 5, scale: 4 }).default("0.5").notNull(),
    weight: integer().default(1).notNull(),
    metadata: jsonb().default({}).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("kg_edges_predicate_idx").using(
      "btree",
      table.workspaceId.asc().nullsLast().op("int4_ops"),
      table.normalizedPredicate.asc().nullsLast().op("text_ops"),
      table.weight.desc().nullsFirst().op("text_ops"),
    ),
    index("kg_edges_source_idx").using(
      "btree",
      table.workspaceId.asc().nullsLast().op("text_ops"),
      table.sourceNodeId.asc().nullsLast().op("text_ops"),
    ),
    index("kg_edges_target_idx").using(
      "btree",
      table.workspaceId.asc().nullsLast().op("text_ops"),
      table.targetNodeId.asc().nullsLast().op("text_ops"),
    ),
    foreignKey({
      columns: [table.workspaceId],
      foreignColumns: [workspaces.id],
      name: "kg_edges_workspace_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.runId],
      foreignColumns: [workspaceRuns.id],
      name: "kg_edges_run_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [user.id],
      name: "kg_edges_user_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.sourceNodeId],
      foreignColumns: [kgNodes.id],
      name: "kg_edges_source_node_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.targetNodeId],
      foreignColumns: [kgNodes.id],
      name: "kg_edges_target_node_id_fkey",
    }).onDelete("cascade"),
    unique(
      "kg_edges_workspace_id_source_node_id_target_node_id_normali_key",
    ).on(
      table.workspaceId,
      table.sourceNodeId,
      table.targetNodeId,
      table.normalizedPredicate,
    ),
  ],
);

export const kgCommunities = pgTable(
  "kg_communities",
  {
    id: text().primaryKey().notNull(),
    workspaceId: text("workspace_id").notNull(),
    runId: text("run_id").notNull(),
    userId: text("user_id").notNull(),
    level: integer().default(0).notNull(),
    label: text().notNull(),
    summary: text().notNull(),
    memberCount: integer("member_count").default(0).notNull(),
    metadata: jsonb().default({}).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("kg_communities_rank_idx").using(
      "btree",
      table.workspaceId.asc().nullsLast().op("int4_ops"),
      table.level.asc().nullsLast().op("int4_ops"),
      table.memberCount.desc().nullsFirst().op("int4_ops"),
    ),
    foreignKey({
      columns: [table.workspaceId],
      foreignColumns: [workspaces.id],
      name: "kg_communities_workspace_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.runId],
      foreignColumns: [workspaceRuns.id],
      name: "kg_communities_run_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [user.id],
      name: "kg_communities_user_id_fkey",
    }).onDelete("cascade"),
  ],
);

export const orgMemberships = pgTable(
  "org_memberships",
  {
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    role: text().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("org_memberships_user_id_idx").using(
      "btree",
      table.userId.asc().nullsLast().op("text_ops"),
      table.createdAt.desc().nullsFirst().op("text_ops"),
    ),
    foreignKey({
      columns: [table.orgId],
      foreignColumns: [organizations.id],
      name: "org_memberships_org_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [user.id],
      name: "org_memberships_user_id_fkey",
    }).onDelete("cascade"),
    primaryKey({
      columns: [table.orgId, table.userId],
      name: "org_memberships_pkey",
    }),
  ],
);

export const documentTags = pgTable(
  "document_tags",
  {
    documentId: text("document_id").notNull(),
    userId: text("user_id").notNull(),
    tag: text().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("document_tags_document_id_idx").using(
      "btree",
      table.documentId.asc().nullsLast().op("text_ops"),
    ),
    index("document_tags_user_id_idx").using(
      "btree",
      table.userId.asc().nullsLast().op("text_ops"),
      table.tag.asc().nullsLast().op("text_ops"),
    ),
    foreignKey({
      columns: [table.documentId],
      foreignColumns: [documents.id],
      name: "document_tags_document_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [user.id],
      name: "document_tags_user_id_fkey",
    }).onDelete("cascade"),
    primaryKey({
      columns: [table.documentId, table.tag],
      name: "document_tags_pkey",
    }),
  ],
);

export const apiKeyUsage = pgTable(
  "api_key_usage",
  {
    keyId: text("key_id").notNull(),
    minuteBucket: timestamp("minute_bucket", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    requestCount: integer("request_count").default(0).notNull(),
    pageCount: integer("page_count").default(0).notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.keyId],
      foreignColumns: [apiKeys.id],
      name: "api_key_usage_key_id_fkey",
    }).onDelete("cascade"),
    primaryKey({
      columns: [table.keyId, table.minuteBucket],
      name: "api_key_usage_pkey",
    }),
  ],
);

export const kgCommunityMembers = pgTable(
  "kg_community_members",
  {
    communityId: text("community_id").notNull(),
    nodeId: text("node_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("kg_community_members_node_idx").using(
      "btree",
      table.workspaceId.asc().nullsLast().op("text_ops"),
      table.nodeId.asc().nullsLast().op("text_ops"),
    ),
    foreignKey({
      columns: [table.communityId],
      foreignColumns: [kgCommunities.id],
      name: "kg_community_members_community_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.nodeId],
      foreignColumns: [kgNodes.id],
      name: "kg_community_members_node_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.workspaceId],
      foreignColumns: [workspaces.id],
      name: "kg_community_members_workspace_id_fkey",
    }).onDelete("cascade"),
    primaryKey({
      columns: [table.communityId, table.nodeId],
      name: "kg_community_members_pkey",
    }),
  ],
);

export const workspaceMembers = pgTable(
  "workspace_members",
  {
    workspaceId: text("workspace_id").notNull(),
    userId: text("user_id").notNull(),
    role: text().notNull(),
    invitedByUserId: text("invited_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("workspace_members_user_id_idx").using(
      "btree",
      table.userId.asc().nullsLast().op("text_ops"),
      table.createdAt.desc().nullsFirst().op("text_ops"),
    ),
    foreignKey({
      columns: [table.workspaceId],
      foreignColumns: [workspaces.id],
      name: "workspace_members_workspace_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.invitedByUserId],
      foreignColumns: [user.id],
      name: "workspace_members_invited_by_user_id_fkey",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [user.id],
      name: "workspace_members_user_id_fkey",
    }).onDelete("cascade"),
    primaryKey({
      columns: [table.workspaceId, table.userId],
      name: "workspace_members_pkey",
    }),
  ],
);

export const workspaceRunStageStates = pgTable(
  "workspace_run_stage_states",
  {
    runId: text("run_id").notNull(),
    stageName: text("stage_name").notNull(),
    status: text().notNull(),
    attempts: integer().default(0).notNull(),
    artifactUri: text("artifact_uri"),
    stats: jsonb().default({}).notNull(),
    error: text(),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "string" }),
    completedAt: timestamp("completed_at", {
      withTimezone: true,
      mode: "string",
    }),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("workspace_run_stage_states_run_id_idx").using(
      "btree",
      table.runId.asc().nullsLast().op("text_ops"),
      table.updatedAt.desc().nullsFirst().op("text_ops"),
    ),
    foreignKey({
      columns: [table.runId],
      foreignColumns: [workspaceRuns.id],
      name: "workspace_run_stage_states_run_id_fkey",
    }).onDelete("cascade"),
    primaryKey({
      columns: [table.runId, table.stageName],
      name: "workspace_run_stage_states_pkey",
    }),
  ],
);

export const documentRunStageStates = pgTable(
  "document_run_stage_states",
  {
    runId: text("run_id").notNull(),
    documentId: text("document_id").notNull(),
    stageName: text("stage_name").notNull(),
    status: text().notNull(),
    attempts: integer().default(0).notNull(),
    artifactUri: text("artifact_uri"),
    stats: jsonb().default({}).notNull(),
    error: text(),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "string" }),
    completedAt: timestamp("completed_at", {
      withTimezone: true,
      mode: "string",
    }),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("document_run_stage_states_run_id_idx").using(
      "btree",
      table.runId.asc().nullsLast().op("text_ops"),
      table.documentId.asc().nullsLast().op("text_ops"),
      table.updatedAt.desc().nullsFirst().op("text_ops"),
    ),
    foreignKey({
      columns: [table.runId],
      foreignColumns: [workspaceRuns.id],
      name: "document_run_stage_states_run_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.documentId],
      foreignColumns: [documents.id],
      name: "document_run_stage_states_document_id_fkey",
    }).onDelete("cascade"),
    primaryKey({
      columns: [table.runId, table.documentId, table.stageName],
      name: "document_run_stage_states_pkey",
    }),
  ],
);

export const chunkEntities = pgTable(
  "chunk_entities",
  {
    chunkId: text("chunk_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    runId: text("run_id").notNull(),
    userId: text("user_id").notNull(),
    nodeId: text("node_id").notNull(),
    entityName: text("entity_name").notNull(),
    entityType: text("entity_type").notNull(),
    mentionCount: integer("mention_count").default(1).notNull(),
    confidence: numeric({ precision: 5, scale: 4 }).default("0.5").notNull(),
    metadata: jsonb().default({}).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("chunk_entities_lookup_idx").using(
      "btree",
      table.workspaceId.asc().nullsLast().op("text_ops"),
      table.entityName.asc().nullsLast().op("text_ops"),
      table.entityType.asc().nullsLast().op("text_ops"),
    ),
    index("chunk_entities_node_idx").using(
      "btree",
      table.workspaceId.asc().nullsLast().op("text_ops"),
      table.nodeId.asc().nullsLast().op("text_ops"),
    ),
    foreignKey({
      columns: [table.chunkId],
      foreignColumns: [documentChunks.id],
      name: "chunk_entities_chunk_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.workspaceId],
      foreignColumns: [workspaces.id],
      name: "chunk_entities_workspace_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.runId],
      foreignColumns: [workspaceRuns.id],
      name: "chunk_entities_run_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [user.id],
      name: "chunk_entities_user_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.nodeId],
      foreignColumns: [kgNodes.id],
      name: "chunk_entities_node_id_fkey",
    }).onDelete("cascade"),
    primaryKey({
      columns: [table.chunkId, table.nodeId],
      name: "chunk_entities_pkey",
    }),
  ],
);
export const creditGrants = pgTable(
  "credit_grants",
  {
    id: text().primaryKey().notNull().default(sql`gen_random_uuid()::text`),
    orgId: text("org_id").notNull(),
    source: text().notNull(),
    externalId: text("external_id"),
    credits: numeric({ precision: 24, scale: 12, mode: "number" }).notNull(),
    pool: text().notNull(),
    reversedCredits: numeric("reversed_credits", { precision: 24, scale: 12, mode: "number" }).default(0).notNull(),
    metadata: jsonb().default({}).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("credit_grants_org_created_idx").using(
      "btree",
      table.orgId.asc().nullsLast().op("text_ops"),
      table.createdAt.desc().nullsFirst().op("timestamptz_ops"),
    ),
    index("credit_grants_payment_intent_idx")
      .using("btree", sql`(metadata ->> 'paymentIntentId'::text)`)
      .where(sql`(metadata ? 'paymentIntentId'::text)`),
    foreignKey({
      columns: [table.orgId],
      foreignColumns: [organizations.id],
      name: "credit_grants_org_id_fkey",
    }).onDelete("cascade"),
    unique("credit_grants_source_external_id_key").on(table.source, table.externalId),
    check(
      "credit_grants_source_check",
      sql`source = ANY (ARRAY['subscription'::text, 'topup'::text, 'auto_recharge'::text, 'starter'::text, 'promo'::text, 'adjustment'::text])`,
    ),
    check("credit_grants_pool_check", sql`pool = ANY (ARRAY['included'::text, 'prepaid'::text])`),
    check("credit_grants_credits_check", sql`credits >= (0)::numeric`),
    check(
      "credit_grants_reversed_check",
      sql`(reversed_credits >= (0)::numeric) AND (reversed_credits <= credits)`,
    ),
  ],
);

export const billingRuntime = pgTable(
  "billing_runtime",
  {
    id: boolean().primaryKey().default(true).notNull(),
    meteringEnforced: boolean("metering_enforced").default(false).notNull(),
    stripeMode: text("stripe_mode"),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  () => [
    check("billing_runtime_id_check", sql`id`),
    check("billing_runtime_stripe_mode_check", sql`stripe_mode = ANY (ARRAY['test'::text, 'live'::text])`),
  ],
);

export const storageMeterDays = pgTable(
  "storage_meter_days",
  {
    orgId: text("org_id").notNull(),
    day: date().notNull(),
    // You can use { mode: "bigint" } if numbers are exceeding js number limitations
    objectBytes: bigint("object_bytes", { mode: "number" }).default(0).notNull(),
    // You can use { mode: "bigint" } if numbers are exceeding js number limitations
    indexBytes: bigint("index_bytes", { mode: "number" }).default(0).notNull(),
    credits: numeric({ precision: 24, scale: 12, mode: "number" }).default(0).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.day], name: "storage_meter_days_pkey" }),
    foreignKey({
      columns: [table.orgId],
      foreignColumns: [organizations.id],
      name: "storage_meter_days_org_id_fkey",
    }).onDelete("cascade"),
  ],
);

export const budgetAlerts = pgTable(
  "budget_alerts",
  {
    id: text().primaryKey().notNull().default(sql`gen_random_uuid()::text`),
    orgId: text("org_id").notNull(),
    alertType: text("alert_type").notNull(),
    thresholdPercent: integer("threshold_percent").notNull(),
    currentUsageCents: integer("current_usage_cents").notNull(),
    budgetCents: integer("budget_cents").notNull(),
    notifiedAt: timestamp("notified_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("budget_alerts_org_notified_idx").using(
      "btree",
      table.orgId.asc().nullsLast().op("text_ops"),
      table.notifiedAt.desc().nullsFirst().op("timestamptz_ops"),
    ),
    foreignKey({
      columns: [table.orgId],
      foreignColumns: [organizations.id],
      name: "budget_alerts_org_id_fkey",
    }).onDelete("cascade"),
  ],
);

export const adminStats = pgMaterializedView("admin_stats", {
  hour: timestamp({ withTimezone: true, mode: "string" }),
  // You can use { mode: "bigint" } if numbers are exceeding js number limitations
  runsCount: bigint("runs_count", { mode: "number" }),
  // You can use { mode: "bigint" } if numbers are exceeding js number limitations
  pagesTotal: bigint("pages_total", { mode: "number" }),
  avgCostCents: numeric("avg_cost_cents"),
}).as(
  sql`SELECT date_trunc('hour'::text, created_at) AS hour, count(*) AS runs_count, sum(pages_total) AS pages_total, avg(output_cost_cents + input_cost_cents) AS avg_cost_cents FROM workspace_runs GROUP BY (date_trunc('hour'::text, created_at))`,
);

export const searchExperimentResults = pgView("search_experiment_results", {
  experimentId: text("experiment_id"),
  name: text(),
  variant: text(),
  // You can use { mode: "bigint" } if numbers are exceeding js number limitations
  queryCount: bigint("query_count", { mode: "number" }),
  avgResultCount: numeric("avg_result_count"),
  ctr: doublePrecision(),
}).as(
  sql`SELECT e.id AS experiment_id, e.name, s.variant, count(DISTINCT s.id) AS query_count, avg(s.result_count) AS avg_result_count, sum( CASE WHEN sr.clicked THEN 1 ELSE 0 END)::double precision / NULLIF(count(sr.id)::double precision, 0::double precision) AS ctr FROM search_experiments e JOIN search_sessions s ON s.variant = e.id OR s.variant = e.name LEFT JOIN search_session_results sr ON sr.session_id = s.id GROUP BY e.id, e.name, s.variant`,
);

export const pageWorkTasks = pgTable("page_work_tasks", {
  runId: text("run_id").notNull().references(() => workspaceRuns.id, { onDelete: "cascade" }),
  documentId: text("document_id").notNull().references(() => documents.id, { onDelete: "cascade" }),
  pageNumber: integer("page_number").notNull(),
  status: text("status").notNull().default("queued"),
  leaseId: text("lease_id"),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true, mode: "string" }),
  workerId: text("worker_id"),
  attempts: integer("attempts").notNull().default(0),
  result: jsonb("result"),
  startedAt: timestamp("started_at", { withTimezone: true, mode: "string" }),
  completedAt: timestamp("completed_at", { withTimezone: true, mode: "string" }),
  payload: jsonb("payload"),
}, table => [primaryKey({ columns: [table.runId, table.documentId, table.pageNumber] }),
  index("page_work_tasks_pending_idx").on(table.runId, table.status),
  index("page_work_tasks_status_run_idx").on(table.status, table.runId),
  check("page_work_tasks_page_number_check", sql`${table.pageNumber} > 0`)]);

/**
 * Per-org worker slot tokens (server/db/migrations/0031_worker_slot_tokens.sql): one
 * row per slot an org may hold; a held token carries the lease. The
 * worker_slot_leases view lists held tokens.
 */
export const workerSlotTokens = pgTable("worker_slot_tokens", {
  orgKey: text("org_key").notNull(),
  slotNo: integer("slot_no").notNull(),
  leaseId: text("lease_id"),
  runId: text("run_id"),
  kind: text("kind"),
  workerId: text("worker_id"),
  acquiredAt: timestamp("acquired_at", { withTimezone: true, mode: "string" }),
  expiresAt: timestamp("expires_at", { withTimezone: true, mode: "string" }),
}, table => [primaryKey({ columns: [table.orgKey, table.slotNo], name: "worker_slot_tokens_pkey" }),
  uniqueIndex("worker_slot_tokens_lease_idx").on(table.leaseId).where(sql`lease_id IS NOT NULL`),
  index("worker_slot_tokens_live_idx").on(table.expiresAt).where(sql`lease_id IS NOT NULL`),
  check("worker_slot_tokens_slot_no_check", sql`${table.slotNo} >= 0`),
  check("worker_slot_tokens_kind_check", sql`${table.kind} IS NULL OR ${table.kind} IN ('page', 'stage')`),
  check("worker_slot_tokens_lease_check", sql`(${table.leaseId} IS NULL) = (${table.expiresAt} IS NULL)`)]);

/**
 * Credit debits not yet applied to the org's pools
 * (server/db/migrations/0030_pending_credit_debits.sql). Insert-only on the hot path;
 * apply_pending_org_debits() moves them into the pools and the ledger.
 */
export const creditDebitsPending = pgTable("credit_debits_pending", {
  id: uuid("id").primaryKey().defaultRandom().notNull(),
  orgId: text("org_id").notNull(),
  userId: text("user_id"),
  runId: text("run_id"),
  workspaceId: text("workspace_id"),
  reason: text("reason").default("usage").notNull(),
  credits: numeric("credits", { precision: 24, scale: 12 }).notNull(),
  metadata: jsonb("metadata").default({}).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).defaultNow().notNull(),
}, table => [index("credit_debits_pending_org_idx").on(table.orgId),
  check("credit_debits_pending_credits_check", sql`${table.credits} > 0`)]);

export const workerMaintenanceLeases = pgTable("worker_maintenance_leases", {
  name: text("name").primaryKey().notNull(),
  holder: text("holder").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true, mode: "string" }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).defaultNow().notNull(),
});

export const mcpOAuthClients = pgTable("mcp_oauth_clients", {
  id: text().primaryKey(), name: text().notNull(), redirectUris: jsonb("redirect_uris").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
export const mcpOAuthRequests = pgTable("mcp_oauth_requests", {
  id: text().primaryKey(), clientId: text("client_id").notNull().references(() => mcpOAuthClients.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  sessionId: text("session_id").notNull().references(() => session.id, { onDelete: "cascade" }),
  redirectUri: text("redirect_uri").notNull(), resource: text().notNull(), scopes: jsonb().notNull(), challenge: text().notNull(), state: text(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(), consumedAt: timestamp("consumed_at", { withTimezone: true }),
}, table => [index("mcp_oauth_requests_expiry_idx").on(table.expiresAt)]);
export const mcpOAuthGrants = pgTable("mcp_oauth_grants", {
  apiKeyId: text("api_key_id").notNull().references(() => apiKeys.id, { onDelete: "cascade" }),
  id: text().primaryKey(), clientId: text("client_id").notNull().references(() => mcpOAuthClients.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  resource: text().notNull(), scopes: jsonb().notNull(), createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
}, table => [index("mcp_oauth_grants_user_idx").on(table.userId), uniqueIndex("mcp_oauth_grants_api_key_id_idx").on(table.apiKeyId)]);
export const mcpOAuthTokens = pgTable("mcp_oauth_tokens", {
  hash: text().primaryKey(), grantId: text("grant_id").notNull().references(() => mcpOAuthGrants.id, { onDelete: "cascade" }),
  kind: text().notNull(), redirectUri: text("redirect_uri"), challenge: text(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(), consumedAt: timestamp("consumed_at", { withTimezone: true }),
}, table => [index("mcp_oauth_tokens_grant_idx").on(table.grantId), check("mcp_oauth_tokens_kind_check", sql`${table.kind} in ('code','access','refresh')`)]);

/**
 * Content-addressed embedding reuse pointers (server/db/migrations/0034_embedding_reuse_refs.sql):
 * per-org embed key -> embedding artifact chunk holding the vector.
 */
export const embeddingReuseRefs = pgTable("embedding_reuse_refs", {
  orgId: text("org_id").notNull(),
  embedKey: text("embed_key").notNull(),
  artifactUri: text("artifact_uri").notNull(),
  chunkIndex: integer("chunk_index").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).defaultNow().notNull(),
}, table => [primaryKey({ columns: [table.orgId, table.embedKey], name: "embedding_reuse_refs_pkey" }),
  foreignKey({ columns: [table.orgId], foreignColumns: [organizations.id], name: "embedding_reuse_refs_org_id_fkey" }).onDelete("cascade"),
  index("embedding_reuse_refs_artifact_uri_idx").using("btree", table.artifactUri.asc().nullsLast().op("text_ops"))]);
