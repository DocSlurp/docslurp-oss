import postgres from "postgres";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { defaultPipelineFeatures, mergePipelineFeatures } from "@docslurp/shared";
import { startMigratedPostgres } from "@docslurp/worker/testing";
import type { RequestActor } from "../lib/request-actor.js";
import { sealSettingsProposal } from "../lib/settings-proposal-tokens.js";

let sql: postgres.Sql;
let stop: () => Promise<void>;
let service: typeof import("../services/workspace-settings-proposals.js");
let counter = 0;
beforeAll(async () => {
  vi.stubEnv("BETTER_AUTH_SECRET", "settings-proposal-test-secret-with-enough-entropy");
  const db = await startMigratedPostgres(); stop = db.stop;
  sql = postgres(db.url, { max: 1, prepare: false, onnotice: () => {} });
  vi.doMock("../db.js", () => ({ sql }));
  vi.doMock("../services/run-lifecycle.js", () => ({ runLifecycle: { start: vi.fn() } }));
  vi.doMock("../lib/temporal.js", () => ({ signalPipelinePause: vi.fn(), signalPipelineResume: vi.fn(), signalPipelineCancel: vi.fn() }));
  service = await import("../services/workspace-settings-proposals.js");
}, 120_000);
afterAll(async () => { await sql?.end(); await stop?.(); vi.unstubAllEnvs(); });
async function fixture() {
  const id = `proposal-${++counter}`, userId = `${id}-editor`, owner = `${id}-owner`, sessionId = `${id}-chat`;
  await sql`insert into "user" (id,name,email) values (${owner},'Owner',${owner+'@example.test'}),(${userId},'Editor',${userId+'@example.test'})`;
  await sql`insert into organizations (id,name,slug,created_by_user_id) values (${id},'Test',${id},${owner})`;
  await sql`insert into org_memberships(org_id,user_id,role) values (${id},${owner},'owner'),(${id},${userId},'member')`;
  const pipeline = mergePipelineFeatures(defaultPipelineFeatures, { mediaVideo: { enabled: false }, preserveCode: false, parserPlaybook: "fast" });
  await sql`insert into workspaces(id,org_id,user_id,name,pipeline) values (${id},${id},${owner},'Test',${sql.json(JSON.parse(JSON.stringify(pipeline)))})`;
  await sql`insert into workspace_members(workspace_id,user_id,role) values (${id},${userId},'editor')`;
  await sql`insert into chat_sessions(id,workspace_id,user_id) values (${sessionId},${id},${userId})`;
  const actor: RequestActor = { type: "session", userId, sessionId: `${id}-auth`, user: { id: userId, email: userId+'@example.test', name: 'Editor' } };
  return { actor, workspaceId: id, sessionId, userId, id };
}
const changes = { pipeline: { mediaVideo: { enabled: true } } };
async function saved(workspaceId: string) { return (await sql`select pipeline from workspaces where id=${workspaceId}`)[0].pipeline; }

it("only proposes until the trusted Apply call, then preserves unrelated nested settings and audits atomically", async () => {
  const f = await fixture();
  const proposal = await service.proposeWorkspaceSettings({ ...f, changes });
  expect((await saved(f.id)).mediaVideo.enabled).toBe(false);
  expect(proposal.changes).toContainEqual({ key: 'pipeline.mediaVideo.enabled', label: 'Video frame analysis', before: false, after: true });
  expect(proposal.reprocessAvailable).toBe(false);
  expect(await service.applySettingsProposal({ ...f, token: proposal.token, reprocessExisting: false })).toMatchObject({ applied: true, reprocess: { requested: false, status: 'not-requested' } });
  expect(await saved(f.id)).toMatchObject({ mediaVideo: { enabled: true }, preserveCode: false, parserPlaybook: 'fast' });
  expect(await sql`select count(*)::int n from audit_log where workspace_id=${f.id} and action='workspace.updated'`).toEqual([{ n: 1 }]);
  await expect(service.applySettingsProposal({ ...f, token: proposal.token, reprocessExisting: false })).rejects.toMatchObject({ status: 409, category: 'settings_proposal_stale' });
});

it("merges chat and retrieval patches without resetting unrelated defaults", async () => {
  const f = await fixture();
  const proposal = await service.proposeWorkspaceSettings({ ...f, changes: { chat: { answerStyle: 'detailed', searchInstructions: 'Explain assumptions.' }, retrieval: { resultCount: 6 } } });
  expect(proposal.changes.map(c => c.key)).toEqual(expect.arrayContaining(['chat.answerStyle','chat.searchInstructions','retrieval.resultCount']));
  await service.applySettingsProposal({ ...f, token: proposal.token, reprocessExisting: false });
  const { getWorkspaceSearchSettings } = await import('../services/search-controls.js');
  expect(await getWorkspaceSearchSettings(f.id, f.userId)).toMatchObject({ chat: { enabled: true, citations: true, answerStyle: 'detailed', searchInstructions: 'Explain assumptions.' }, retrievalDefaults: { resultCount: 6 } });
  expect((await saved(f.id)).preserveCode).toBe(false);
});

it("rejects tampering, wrong purpose, expiry, cross-workspace and cross-session use", async () => {
  const f = await fixture(), other = await fixture();
  const proposal = await service.proposeWorkspaceSettings({ ...f, changes, now: 1000 });
  await expect(service.applySettingsProposal({ ...f, token: proposal.token, reprocessExisting: false, now: 602000 })).rejects.toMatchObject({ status: 410 });
  const token = proposal.token.slice(0, 10)+(proposal.token[10] === 'A' ? 'B' : 'A')+proposal.token.slice(11);
  await expect(service.applySettingsProposal({ ...f, token, reprocessExisting: false, now: 2000 })).rejects.toMatchObject({ status: 403 });
  await expect(service.applySettingsProposal({ ...f, token: sealSettingsProposal({ purpose: 'other' }), reprocessExisting: false })).rejects.toMatchObject({ status: 403 });
  await expect(service.applySettingsProposal({ ...other, token: proposal.token, reprocessExisting: false, now: 2000 })).rejects.toMatchObject({ status: 403 });
  const actor: RequestActor = { ...f.actor, sessionId: 'another-auth-session' };
  await expect(service.applySettingsProposal({ ...f, actor, token: proposal.token, reprocessExisting: false, now: 2000 })).rejects.toMatchObject({ status: 403 });
});

it("rejects a viewer and rechecks permissions after proposal generation", async () => {
  const f = await fixture();
  const proposal = await service.proposeWorkspaceSettings({ ...f, changes });
  await sql`update workspace_members set role='viewer' where workspace_id=${f.id} and user_id=${f.userId}`;
  await expect(service.proposeWorkspaceSettings({ ...f, changes })).rejects.toMatchObject({ status: 403 });
  await expect(service.applySettingsProposal({ ...f, token: proposal.token, reprocessExisting: false })).rejects.toMatchObject({ status: 403 });
  expect((await saved(f.id)).mediaVideo.enabled).toBe(false);
});

it("refuses stale pipeline, search state, unsupported fields and invented reprocessing", async () => {
  const f = await fixture();
  const proposal = await service.proposeWorkspaceSettings({ ...f, changes });
  await sql`update workspaces set updated_at=now(),pipeline=jsonb_set(pipeline,'{preserveTables}','false') where id=${f.id}`;
  await expect(service.applySettingsProposal({ ...f, token: proposal.token, reprocessExisting: false })).rejects.toMatchObject({ status: 409 });
  await expect(service.proposeWorkspaceSettings({ ...f, changes: { pipeline: { privacyMode: 'standard' } } })).rejects.toBeDefined();
  const fresh = await service.proposeWorkspaceSettings({ ...f, changes });
  await expect(service.applySettingsProposal({ ...f, token: fresh.token, reprocessExisting: true })).rejects.toMatchObject({ status: 400, category: 'reprocess_unavailable' });
  const { updateWorkspaceSearchSettingsForUser } = await import('../services/search-controls.js');
  await updateWorkspaceSearchSettingsForUser({ workspaceId: f.id, userId: f.userId, input: { chat: { citations: false } } });
  await expect(service.applySettingsProposal({ ...f, token: fresh.token, reprocessExisting: false })).rejects.toMatchObject({ status: 409 });
});

it("requires live server-key manage scope and honors revocation", async () => {
  const f = await fixture();
  await sql`insert into api_keys(id,user_id,key_hash,name,org_id,scopes) values (${f.id},${f.userId},${f.id},'Test',${f.id},'{search}')`;
  const actor: RequestActor = { type: 'apiKey', userId: f.userId, apiKey: { keyId: f.id, userId: f.userId, orgId: f.id, keyType: 'server', scopes: ['search','workspaces:manage'], workspaceIds: [], allowedDomains: [], rateLimitRpm: null, rateLimitPpd: 0, rateLimits: [] } };
  await expect(service.proposeWorkspaceSettings({ ...f, actor, changes })).rejects.toMatchObject({ status: 403 });
  await sql`update api_keys set scopes='{search,workspaces:manage}' where id=${f.id}`;
  const proposal = await service.proposeWorkspaceSettings({ ...f, actor, changes });
  await sql`update api_keys set revoked_at=now() where id=${f.id}`;
  await expect(service.applySettingsProposal({ ...f, actor, token: proposal.token, reprocessExisting: false })).rejects.toMatchObject({ status: 403 });
});


it("requires separate reprocessing consent and handles legacy NULL index hashes without false stale rejection", async () => {
  const f = await fixture(), pipeline = await saved(f.id);
  await sql`insert into workspace_runs(id,org_id,user_id,workspace_id,kind,status,stage,pipeline,artifacts)
    values (${f.id},${f.id},${f.userId},${f.id},'upload','completed','index',${sql.json(JSON.parse(JSON.stringify(pipeline)))},${sql.json({ [`${f.id}:markdown`]: 's3://test/source.md' })})`;
  await sql`insert into documents(id,org_id,user_id,workspace_id,run_id,filename,mime_type,source_key,status,page_count,canonical_id)
    values (${f.id},${f.id},${f.userId},${f.id},${f.id},'source.txt','text/plain','source','completed',3,'source')`;
  await sql`insert into vector_indexes(id,document_id,backend,bucket,path,embedding_model,dimension)
    values (${f.id},${f.id},'lancedb','test','path','model',1024)`;
  const proposal = await service.proposeWorkspaceSettings({ ...f, changes: { pipeline: { chunkOverlap: !pipeline.chunkOverlap } } });
  expect(proposal.reprocessRequired).toBe(true);
  await expect(service.applySettingsProposal({ ...f, token: proposal.token, reprocessExisting: false })).rejects.toMatchObject({ status: 409, category: 'reprocess_consent_required' });
  expect((await saved(f.id)).chunkOverlap).toBe(pipeline.chunkOverlap);
  await expect(service.applySettingsProposal({ ...f, token: proposal.token, reprocessExisting: true })).resolves.toMatchObject({ applied: true, reprocess: { requested: true } });
  expect((await saved(f.id)).chunkOverlap).toBe(!pipeline.chunkOverlap);
});

it("rolls settings back when atomic audit persistence fails", async () => {
  const f = await fixture(), proposal = await service.proposeWorkspaceSettings({ ...f, changes });
  const audit = await import('../services/audit-log.js');
  const write = vi.spyOn(audit, 'appendAuditLog').mockRejectedValueOnce(new Error('audit unavailable'));
  await expect(service.applySettingsProposal({ ...f, token: proposal.token, reprocessExisting: false })).rejects.toThrow('audit unavailable');
  write.mockRestore();
  expect((await saved(f.id)).mediaVideo.enabled).toBe(false);
  expect(await sql`select count(*)::int n from audit_log where workspace_id=${f.id}`).toEqual([{ n: 0 }]);
});

it("rejects a change racing between planner version capture and workspace snapshot instead of overwriting it", async () => {
  const f = await fixture();
  const workspaces = await import('../services/workspaces.js'), original = workspaces.getWorkspace;
  const read = vi.spyOn(workspaces, 'getWorkspace').mockImplementationOnce(async (...args) => {
    const snapshot = await original(...args);
    await sql`update workspaces set updated_at=now(),pipeline=jsonb_set(pipeline,'{preserveTables}','false') where id=${f.id}`;
    return snapshot;
  });
  const proposal = await service.proposeWorkspaceSettings({ ...f, changes });
  expect(read).toHaveBeenCalledOnce();
  read.mockRestore();
  await expect(service.applySettingsProposal({ ...f, token: proposal.token, reprocessExisting: false })).rejects.toMatchObject({ status: 409 });
  expect((await saved(f.id)).preserveTables).toBe(false);
});
