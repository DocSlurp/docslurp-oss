import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { beforeAll, afterAll, it, expect, vi } from "vitest";
import { defaultPipelineFeatures, normalizePipelineFeatures } from "@docslurp/shared";
import { startMigratedPostgres } from "@docslurp/worker/testing";
import type { RequestActor } from "../lib/request-actor.js";
let sql: postgres.Sql;
let stop: () => Promise<void>;
let service: typeof import("../services/settings-publication.js");
let failSearch = false;
let beforeConfigurationLock: ((client: typeof sql) => Promise<void>) | undefined;
let afterProjectWrite: ((client: typeof sql) => Promise<void>) | undefined;
let policyBarrier: ((phase: 'before' | 'after', client: typeof sql) => Promise<void>) | undefined;
beforeAll(async () => {
  const db = process.env.TEST_DATABASE_URL ? null : await startMigratedPostgres(); stop = db?.stop ?? (async () => {});
  sql = postgres(process.env.TEST_DATABASE_URL ?? db!.url, { max: process.env.TEST_DATABASE_URL ? 4 : 1, prepare: false, onnotice: () => {} });
  vi.doMock("../db.js", () => ({ sql }));
  vi.doMock("../lib/auth.js", () => ({ auth: { api: { getSession: async () => null } }, appDbPool: null }));
  vi.doMock("../services/search-controls.js", async () => {
    const actual = await vi.importActual<typeof import("../services/search-controls.js")>("../services/search-controls.js");
    return { ...actual, upsertProjectSearchSettings: async (...args: Parameters<typeof actual.upsertProjectSearchSettings>) => {
      await actual.upsertProjectSearchSettings(...args);
      if (failSearch) throw new Error("injected search failure");
    } };
  });
  vi.doMock("../services/policy-transition.js", async () => {
    const actual = await vi.importActual<typeof import("../services/policy-transition.js")>("../services/policy-transition.js");
    return { ...actual, assertPolicyTransitionAllowed: async (...args: Parameters<typeof actual.assertPolicyTransitionAllowed>) => {
      await policyBarrier?.('before', args[0]);
      await actual.assertPolicyTransitionAllowed(...args);
      await policyBarrier?.('after', args[0]);
    } };
  });
  vi.doMock("../services/project-write-lock.js", async () => {
    const actual = await vi.importActual<typeof import("../services/project-write-lock.js")>("../services/project-write-lock.js");
    return { ...actual, lockProjectConfigurationWrite: async (...args: Parameters<typeof actual.lockProjectConfigurationWrite>) => {
      await beforeConfigurationLock?.(args[0]);
      return actual.lockProjectConfigurationWrite(...args);
    } };
  });
  vi.doMock("../services/projects.js", async () => {
    const actual = await vi.importActual<typeof import("../services/projects.js")>("../services/projects.js");
    return { ...actual, updateProject: async (...args: Parameters<typeof actual.updateProject>) => {
      const result = await actual.updateProject(...args);
      if (args[3]?.client) await afterProjectWrite?.(args[3].client);
      return result;
    } };
  });
  service = await import("../services/settings-publication.js");
}, 120_000);
afterAll(async () => { await sql?.end(); await stop?.(); });
async function fixture() {
  const id = randomUUID(); const userId = randomUUID();
  await sql`insert into "user"(id,name,email) values (${userId},'Owner',${userId+'@example.com'})`;
  await sql`insert into organizations(id,name,slug,created_by_user_id,credit_balance_cents) values (${id},'Org',${id},${userId},10000)`;
  await sql`insert into org_memberships(org_id,user_id,role) values (${id},${userId},'owner')`;
  await sql`insert into projects(id,org_id,user_id,name,pipeline) values (${id},${id},${userId},'Project',${sql.json(JSON.parse(JSON.stringify(defaultPipelineFeatures)))})`;
  const actor: RequestActor = { type: "session", userId, sessionId: randomUUID(), user: { id: userId, email: userId+'@example.com', name: 'Owner' } };
  const snapshot = await service.readSettingsSnapshot(actor, id);
  return { actor, projectId: id, snapshot };
}
function input(f: Awaited<ReturnType<typeof fixture>>) {
  return { requestId: randomUUID(), expected: f.snapshot.revision, project: { pipeline: { preserveCode: false }, monthlyBudgetCents: null }, search: { chat: { enabled: false }, retrievalDefaults: { graphHops: null } } };
}
it("publishes sparse false/null values and retries without duplicate effects", async () => {
  const f = await fixture(); const body = input(f);
  const first = await service.publishSettings({ ...f, input: body });
  expect(first.snapshot.project.pipeline).toMatchObject({ preserveCode: false, preserveTables: true });
  expect(first.snapshot.settings.chat).toMatchObject({ enabled: false, citations: true });
  const retry = await service.publishSettings({ ...f, input: body });
  expect(retry).toMatchObject({ replayed: true, snapshot: first.snapshot });
  expect(await sql`select count(*)::int n from project_settings_publications where project_id=${f.projectId}`).toEqual([{ n: 1 }]);
  await expect(service.publishSettings({ ...f, input: { ...body, search: {} } })).rejects.toMatchObject({ status: 409, code: 'settings_idempotency_conflict' });
});
it("rolls back pipeline, both revisions and receipts when search persistence fails", async () => {
  const f = await fixture(); failSearch = true;
  try { await expect(service.publishSettings({ ...f, input: input(f) })).rejects.toThrow('injected search failure'); }
  finally { failSearch = false; }
  expect(await service.readSettingsSnapshot(f.actor, f.projectId)).toEqual(f.snapshot);
  expect(await sql`select count(*)::int n from project_settings_publications where project_id=${f.projectId}`).toEqual([{ n: 0 }]);
  expect(await sql`select count(*)::int n from project_runs where project_id=${f.projectId}`).toEqual([{ n: 0 }]);
});
it("rejects stale project revisions", async () => {
  const f = await fixture(); await sql`update projects set updated_at=now() where id=${f.projectId}`;
  await expect(service.publishSettings({ ...f, input: input(f) })).rejects.toMatchObject({ status: 409 });
});
it("rejects a search first-insert race even when the project row did not change", async () => {
  const f = await fixture();
  await sql`insert into project_search_settings(project_id,user_id) values (${f.projectId},${f.actor.userId})`;
  await expect(service.publishSettings({ ...f, input: input(f) })).rejects.toMatchObject({ status: 409 });
});
it("rejects cross-tenant actors and read-only members", async () => {
  const f = await fixture(), other = await fixture();
  await expect(service.publishSettings({ actor: other.actor, projectId: f.projectId, input: input(f) })).rejects.toMatchObject({ status: 404 });
  await sql`delete from org_memberships where user_id=${other.actor.userId}`;
  await sql`insert into org_memberships(org_id,user_id,role) values (${f.projectId},${other.actor.userId},'member')`;
  await sql`insert into project_members(project_id,user_id,role) values (${f.projectId},${other.actor.userId},'viewer')`;
  await expect(service.publishSettings({ actor: other.actor, projectId: f.projectId, input: input(f) })).rejects.toMatchObject({ status: 403 });
});
it("rejects unknown keys, oversized instructions and execution controls", async () => {
  const f = await fixture(), body = input(f);
  await expect(service.publishSettings({ ...f, input: { ...body, surprise: true } })).rejects.toThrow();
  await expect(service.publishSettings({ ...f, input: { ...body, project: { pipeline: { embedding: { unexpected: true } } } } })).rejects.toThrow();
  await expect(service.publishSettings({ ...f, input: { ...body, search: { chat: { unexpected: true } } } })).rejects.toThrow();
  await expect(service.publishSettings({ ...f, input: { ...body, search: { chat: { searchInstructions: 'x'.repeat(100000) } } } })).rejects.toThrow();
  await expect(service.publishSettings({ ...f, input: { ...body, project: { pipeline: { stageSubset: ['embed'] } } } })).rejects.toThrow();
});
it("refuses impossible candidate counts atomically", async () => {
  const f = await fixture();
  await expect(service.publishSettings({ ...f, input: { ...input(f), search: { retrievalDefaults: { resultCount: 20, candidateDepth: 2 } } } })).rejects.toMatchObject({ status: 400, code: 'unsupported_search_settings' });
  expect(await service.readSettingsSnapshot(f.actor, f.projectId)).toEqual(f.snapshot);
});
it("clears an output schema only with explicit reset, preserving it on omission", async () => {
  const f = await fixture();
  await sql`update projects set pipeline=pipeline || ${sql.json({ outputSchema: { type: 'object', properties: { reference: { type: 'string' } } } })}::jsonb where id=${f.projectId}`;
  const snapshot = await service.readSettingsSnapshot(f.actor, f.projectId);
  const first = await service.publishSettings({ ...f, input: { ...input(f), expected: snapshot.revision } });
  expect(first.snapshot.project.pipeline.outputSchema).toBeDefined();
  const next = await service.publishSettings({ ...f, input: { ...input(f), requestId: randomUUID(), expected: first.snapshot.revision, clearOutputSchema: true } });
  expect(next.snapshot.project.pipeline.outputSchema).toBeUndefined();
});
it("refuses an older whole-pipeline writer after a publication commits", async () => {
  const f = await fixture();
  const projects = await import('../services/projects.js');
  const stale = await projects.getProject(f.projectId, f.actor.userId);
  const published = await service.publishSettings({ ...f, input: input(f) });
  await expect(projects.updateProject(f.projectId, f.actor.userId, { pipeline: stale!.pipeline }, { expectedUpdatedAt: stale!.updatedAt })).rejects.toMatchObject({ status: 409, code: 'settings_stale' });
  const latest = await service.readSettingsSnapshot(f.actor, f.projectId);
  expect(latest.project.pipeline.preserveCode).toBe(false);
  expect(latest.revision).toEqual(published.snapshot.revision);
});
it("reports unknown vector coverage, then clears rebuild-required state after a real current-generation write", async () => {
  const f = await fixture();
  const runId = randomUUID(), docId = randomUUID();
  await sql`insert into project_runs(id,org_id,user_id,project_id,kind,status,stage,pipeline,monthly_reservation_cents) values (${runId},${f.projectId},${f.actor.userId},${f.projectId},'upload','completed','index','{}',1)`;
  await sql`insert into documents(id,org_id,user_id,project_id,run_id,filename,mime_type,source_key,status,page_count) values (${docId},${f.projectId},${f.actor.userId},${f.projectId},${runId},'synthetic.txt','text/plain','synthetic','completed',1)`;
  await sql`insert into vector_indexes(id,document_id,backend,bucket,path,embedding_model,dimension) values (${randomUUID()},${docId},'lancedb','test','synthetic','test',384)`;
  expect((await service.readSettingsSnapshot(f.actor, f.projectId)).legacyIndexes).toEqual({ documents: 1, documentIds: [docId] });
  const { indexConfigHash, indexConfigOf } = await import('@docslurp/shared');
  const rebuiltHash = indexConfigHash(indexConfigOf(f.snapshot.project.pipeline));
  await sql`update documents set index_config_hash=${rebuiltHash} where id=${docId}`;
  expect((await service.readSettingsSnapshot(f.actor, f.projectId)).legacyIndexes).toEqual({ documents: 0, documentIds: [] });
});

for (const state of ['processing', 'deferred', 'busy', 'archived', 'superseded', 'unindexed', 'old-generation', 'run-only']) {
  it(`refuses policy tightening over all retained corpus: ${state}`, async () => {
    const f = await fixture();
    const local = normalizePipelineFeatures({ ...defaultPipelineFeatures, embedding: { profile: 'fastest-local' } });
    await sql`update projects set pipeline=${sql.json(JSON.parse(JSON.stringify(local)))} where id=${f.projectId}`;
    f.snapshot = await service.readSettingsSnapshot(f.actor, f.projectId);
    const runId = randomUUID();
    await sql`insert into project_runs(id,org_id,user_id,project_id,kind,status,stage,pipeline,monthly_reservation_cents) values (${runId},${f.projectId},${f.actor.userId},${f.projectId},'upload',${state === 'processing' ? 'processing' : 'completed'},'index',${sql.json(JSON.parse(JSON.stringify(f.snapshot.project.pipeline)))},1)`;
    if (state !== 'run-only') {
      await sql`insert into documents(id,org_id,user_id,project_id,run_id,filename,mime_type,source_key,status,indexing_mode,archived_at,superseded_at,index_config_hash) values (${randomUUID()},${f.projectId},${f.actor.userId},${f.projectId},${runId},'synthetic.txt','text/plain','synthetic',${state === 'processing' ? 'processing' : 'completed'},${state === 'deferred' ? 'map' : 'full'},${state === 'archived' ? new Date() : null},${state === 'superseded' ? new Date() : null},${state === 'old-generation' ? 'historical' : null})`;
    }
    if (state === 'busy') await sql`insert into project_runs(id,org_id,user_id,project_id,kind,status,stage,pipeline,monthly_reservation_cents) values (${randomUUID()},${f.projectId},${f.actor.userId},${f.projectId},'full-index','processing','index',${sql.json(JSON.parse(JSON.stringify(f.snapshot.project.pipeline)))},1)`;
    const before = await service.readSettingsSnapshot(f.actor, f.projectId);
    const [balance] = await sql`select credit_balance_cents from organizations where id=${f.projectId}`;
    const runs = await sql`select id,monthly_reservation_cents from project_runs where project_id=${f.projectId} order by id`;
    for (const pipeline of [{ privacyMode: 'local-only', embed: false, indexVectors: false }, { piiPolicy: { enabled: true, action: 'redact_artifacts' } }]) {
      await expect(service.publishSettings({ ...f, input: { ...input(f), project: { pipeline, monthlyBudgetCents: 1, apply: 'reindex' } } })).rejects.toMatchObject({ status: 409, code: 'policy_publication_unavailable' });
      expect(await service.readSettingsSnapshot(f.actor, f.projectId)).toEqual(before);
      expect(await sql`select id,monthly_reservation_cents from project_runs where project_id=${f.projectId} order by id`).toEqual(runs);
      expect(await sql`select credit_balance_cents from organizations where id=${f.projectId}`).toEqual([balance]);
      expect(await sql`select count(*)::int n from project_settings_publications where project_id=${f.projectId}`).toEqual([{ n: 0 }]);
    }
    const { updateProject } = await import('../services/projects.js');
    await expect(updateProject(f.projectId, f.actor.userId, { pipeline: { ...f.snapshot.project.pipeline, piiPolicy: { ...f.snapshot.project.pipeline.piiPolicy, enabled: true } } })).rejects.toMatchObject({ status: 409, code: 'policy_publication_unavailable' });
  });
}
it('allows tightening an actually empty project, but refuses stale-policy intake after it', async () => {
  const f = await fixture();
  const result = await service.publishSettings({ ...f, input: { ...input(f), project: { pipeline: { piiPolicy: { enabled: true, action: 'redact_artifacts' } } } } });
  expect(result.snapshot.project.pipeline.piiPolicy.enabled).toBe(true);
  await expect(sql`insert into project_runs(id,org_id,user_id,project_id,kind,status,stage,pipeline,monthly_reservation_cents) values (${randomUUID()},${f.projectId},${f.actor.userId},${f.projectId},'upload','queued','queued',${sql.json(JSON.parse(JSON.stringify(f.snapshot.project.pipeline)))},1)`).rejects.toThrow(/policy/);
});
it('rejects bypassed template locks atomically instead of silently restoring them', async () => {
  const f = await fixture(); const { getProjectTemplate } = await import('@docslurp/shared');
  const template = getProjectTemplate('engineering-docs')!;
  await sql`update projects set template_key='engineering-docs',pipeline=${sql.json(JSON.parse(JSON.stringify(template.pipeline)))} where id=${f.projectId}`;
  f.snapshot = await service.readSettingsSnapshot(f.actor, f.projectId);
  for (const pipeline of [{ chunkOverlap: !template.pipeline.chunkOverlap }, { embedding: { normalize: !template.pipeline.embedding.normalize } }]) {
    await expect(service.publishSettings({ ...f, input: { ...input(f), project: { pipeline } } })).rejects.toMatchObject({ status: 409 });
    expect(await service.readSettingsSnapshot(f.actor, f.projectId)).toEqual(f.snapshot);
    expect(await sql`select count(*)::int n from project_settings_publications where project_id=${f.projectId}`).toEqual([{ n: 0 }]);
  }
});

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
async function waitForLock(pid: number) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const [row] = await sql`select wait_event_type from pg_stat_activity where pid=${pid}`;
    if (row?.wait_event_type === 'Lock') return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Expected independent transaction to wait for the policy fence');
}
const native = it.runIf(!!process.env.TEST_DATABASE_URL);
native('native: arrival commits first, then publication rechecks and refuses without side effects', async () => {
  const f = await fixture(); const inserted = barrier(), releaseArrival = barrier(), checking = barrier();
  let publicationPid = 0;
  const arrival = sql.begin(async tx => {
    await tx`insert into project_runs(id,org_id,user_id,project_id,kind,status,stage,pipeline,monthly_reservation_cents) values (${randomUUID()},${f.projectId},${f.actor.userId},${f.projectId},'upload','processing','index',${tx.json(JSON.parse(JSON.stringify(f.snapshot.project.pipeline)))},1)`;
    inserted.release(); await releaseArrival.promise;
  });
  await inserted.promise;
  beforeConfigurationLock = async client => {
    const [row] = await client`select pg_backend_pid() pid`; publicationPid = row!.pid; checking.release();
  };
  const publication = service.publishSettings({ ...f, input: { ...input(f), project: { pipeline: { piiPolicy: { enabled: true, action: 'redact_artifacts' } } } } });
  const refused = expect(publication).rejects.toMatchObject({ status: 409, code: 'policy_publication_unavailable' });
  try { await checking.promise; await waitForLock(publicationPid); }
  finally { releaseArrival.release(); }
  try { await arrival; await refused; } finally { beforeConfigurationLock = undefined; }
  expect((await service.readSettingsSnapshot(f.actor, f.projectId)).revision).toEqual(f.snapshot.revision);
  expect(await sql`select count(*)::int n from project_settings_publications where project_id=${f.projectId}`).toEqual([{ n: 0 }]);
});
native('native: publication fences empty corpus first and rejects stale-policy arrival after commit', async () => {
  const f = await fixture(); const checked = barrier(), releasePublication = barrier(), attempting = barrier();
  policyBarrier = async phase => { if (phase === 'after') { checked.release(); await releasePublication.promise; } };
  const publication = service.publishSettings({ ...f, input: { ...input(f), project: { pipeline: { piiPolicy: { enabled: true, action: 'redact_artifacts' } } } } });
  await checked.promise;
  let arrivalPid = 0;
  const arrival = sql.begin(async tx => {
    const [row] = await tx`select pg_backend_pid() pid`; arrivalPid = row!.pid; attempting.release();
    await tx`insert into project_runs(id,org_id,user_id,project_id,kind,status,stage,pipeline,monthly_reservation_cents) values (${randomUUID()},${f.projectId},${f.actor.userId},${f.projectId},'upload','processing','index',${tx.json(JSON.parse(JSON.stringify(f.snapshot.project.pipeline)))},1)`;
  });
  const refused = expect(arrival).rejects.toThrow(/policy/);
  try { await attempting.promise; await waitForLock(arrivalPid); }
  finally { releasePublication.release(); }
  try { expect((await publication).snapshot.project.pipeline.piiPolicy.enabled).toBe(true); await refused; }
  finally { policyBarrier = undefined; }
  expect(await sql`select count(*)::int n from project_runs where project_id=${f.projectId}`).toEqual([{ n: 0 }]);
});
native('native: concurrent identical publications commit once and replay the receipt', async () => {
  const f = await fixture(), body = input(f);
  const results = await Promise.all([service.publishSettings({ ...f, input: body }), service.publishSettings({ ...f, input: body })]);
  expect(results.filter(r => r.replayed)).toHaveLength(1);
  expect(results[0].snapshot).toEqual(results[1].snapshot);
  expect(await sql`select count(*)::int n from project_settings_publications where project_id=${f.projectId}`).toEqual([{ n: 1 }]);
});
it('run admission checks tenant scope and each policy dimension without weakening stricter requests', async () => {
  const f = await fixture(), other = await fixture();
  await expect(sql`insert into project_runs(id,org_id,user_id,project_id,kind,status,stage,pipeline) values (${randomUUID()},${other.projectId},${f.actor.userId},${f.projectId},'upload','completed','index','{}')`).rejects.toThrow(/policy/);
  const required = { privacyMode: 'local-only', piiPolicy: { enabled: true, action: 'redact_artifacts', patterns: ['ssn'], allowlistPatterns: ['permitted'] } };
  for (const [candidate, covers] of [
    [required, true],
    [{ ...required, privacyMode: 'standard' }, false],
    [{ ...required, privacyMode: 'strict-privacy' }, true],
    [{ ...required, piiPolicy: { ...required.piiPolicy, enabled: false } }, false],
    [{ ...required, piiPolicy: { ...required.piiPolicy, action: 'flag_for_review' } }, false],
    [{ ...required, piiPolicy: { ...required.piiPolicy, patterns: [] } }, false],
    [{ ...required, piiPolicy: { ...required.piiPolicy, allowlistPatterns: ['permitted', 'bypass'] } }, false],
    [{ ...required, piiPolicy: { ...required.piiPolicy, patterns: ['ssn', 'credit-card'], allowlistPatterns: [], action: 'block_indexing' } }, true],
  ] as const) {
    const [row] = await sql`select docslurp_pipeline_policy_covers(${sql.json(candidate)},${sql.json(required)}) as covers`;
    expect(row!.covers).toBe(covers);
  }
});
native('native: concurrent conflicting request IDs produce one commit and one conflict', async () => {
  const f = await fixture(), body = input(f);
  const results = await Promise.allSettled([service.publishSettings({ ...f, input: body }), service.publishSettings({ ...f, input: { ...body, search: {} } })]);
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  const rejected = results.find(r => r.status === 'rejected') as PromiseRejectedResult;
  expect(rejected.reason).toMatchObject({ status: 409, code: 'settings_idempotency_conflict' });
  expect(await sql`select count(*)::int n from project_settings_publications where project_id=${f.projectId}`).toEqual([{ n: 1 }]);
});

native.each([false, true])('native: ordinary rebuild and active intake obey spend-before-project ordering (search failure: %s)', async injectedFailure => {
  const f = await fixture(), sourceId = randomUUID(), docId = randomUUID(), intakeId = randomUUID();
  await sql`insert into project_runs(id,org_id,user_id,project_id,kind,status,stage,pipeline) values (${sourceId},${f.projectId},${f.actor.userId},${f.projectId},'upload','completed','index',${sql.json(JSON.parse(JSON.stringify(f.snapshot.project.pipeline)))})`;
  await sql`insert into documents(id,org_id,user_id,project_id,run_id,filename,mime_type,source_key,status,page_count,canonical_id) values (${docId},${f.projectId},${f.actor.userId},${f.projectId},${sourceId},'synthetic.txt','text/plain','synthetic','completed',2,${docId})`;
  await sql`insert into vector_indexes(id,document_id,backend,bucket,path,embedding_model,dimension) values (${randomUUID()},${docId},'lancedb','test','synthetic','test',384)`;
  f.snapshot = await service.readSettingsSnapshot(f.actor, f.projectId);
  const persistedBefore = await sql`select pipeline,index_configs,updated_at::text,monthly_budget_cents from projects where id=${f.projectId}`;
  const body = { ...input(f), project: { pipeline: { chunkOverlap: !f.snapshot.project.pipeline.chunkOverlap }, apply: 'reindex' } };
  const updated = barrier(), releasePublication = barrier(), attempting = barrier();
  let publicationPid = 0, intakePid = 0;
  afterProjectWrite = async client => {
    const [row] = await client`select pg_backend_pid() pid`; publicationPid = row!.pid;
    updated.release(); await releasePublication.promise;
  };
  failSearch = injectedFailure;
  const publication = service.publishSettings({ ...f, input: body });
  // Attach handlers before either transaction may reject, including the pre-fix 40P01 reproduction.
  const publicationResult = publication.then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
  await updated.promise;
  const intake = sql.begin(async tx => {
    const [row] = await tx`select pg_backend_pid() pid`; intakePid = row!.pid; attempting.release();
    await tx`insert into project_runs(id,org_id,user_id,project_id,kind,status,stage,pipeline,monthly_reservation_cents) values (${intakeId},${f.projectId},${f.actor.userId},${f.projectId},'upload','queued','queued',${tx.json(JSON.parse(JSON.stringify(f.snapshot.project.pipeline)))},5)`;
  });
  const intakeResult = intake.then(() => ({ ok: true as const }), error => ({ ok: false as const, error }));
  let waiting: { wait_event: string } | undefined;
  try {
    await attempting.promise; await waitForLock(intakePid);
    [waiting] = await sql<{ wait_event: string }[]>`select wait_event from pg_stat_activity where pid=${intakePid} and ${publicationPid}=any(pg_blocking_pids(pid))`;
  } finally { releasePublication.release(); }
  const [published, admitted] = await Promise.all([publicationResult, intakeResult]);
  afterProjectWrite = undefined; failSearch = false;
  expect([published, admitted].filter(r => !r.ok).map(r => r.ok ? null : r.error.code)).not.toContain('40P01');
  expect(waiting?.wait_event).toBe('advisory');
  expect(admitted.ok).toBe(true);
  const [receipt] = await sql`select count(*)::int n from project_settings_publications where project_id=${f.projectId}`;
  const active = await sql<{ id: string; monthly_reservation_cents: string }[]>`select id,monthly_reservation_cents::text from project_runs where project_id=${f.projectId} and status in ('queued','processing') order by id`;
  const [capacity] = await sql`select coalesce(sum(cents),0)::text cents from pending_monthly_capacity where project_id=${f.projectId}`;
  expect(Number(capacity!.cents)).toBe(active.reduce((sum, row) => sum + Number(row.monthly_reservation_cents), 0));
  const [balance] = await sql`select credit_balance_cents::text cents from organizations where id=${f.projectId}`;
  expect(Number(balance!.cents)).toBe(10000);
  if (injectedFailure) {
    expect(published).toMatchObject({ ok: false, error: { message: 'injected search failure' } });
    expect(receipt!.n).toBe(0);
    expect(active).toEqual([{ id: intakeId, monthly_reservation_cents: '5' }]);
    expect(await sql`select pipeline,index_configs,updated_at::text,monthly_budget_cents from projects where id=${f.projectId}`).toEqual(persistedBefore);
    const after = await service.readSettingsSnapshot(f.actor, f.projectId);
    expect(after.settings).toEqual(f.snapshot.settings); expect(after.revision).toEqual(f.snapshot.revision);
    expect(after.project.latestRunId).toBe(intakeId);
    expect(after.project.runCount).toBe(f.snapshot.project.runCount + 1);
    expect(await sql`select count(*)::int n from project_runs where project_id=${f.projectId} and kind='reindex'`).toEqual([{ n: 0 }]);
  } else {
    expect(published.ok).toBe(true);
    if (!published.ok) throw published.error;
    expect(published.value.queuedRunIds).toHaveLength(1);
    expect(receipt!.n).toBe(1); expect(active).toHaveLength(2);
    expect(active.some(row => row.id === published.value.queuedRunIds[0] && Number(row.monthly_reservation_cents) > 0)).toBe(true);
    expect((await service.publishSettings({ ...f, input: body })).replayed).toBe(true);
    expect(await sql`select count(*)::int n from project_settings_publications where project_id=${f.projectId}`).toEqual([{ n: 1 }]);
  }
}, 30_000);
