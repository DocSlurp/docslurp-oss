import { Hono } from "hono";
import { beforeEach, expect, it, vi } from "vitest";
const { access, getVisit, ack } = vi.hoisted(() => ({ access: vi.fn(), getVisit: vi.fn(), ack: vi.fn() }));
vi.mock("../services/organizations.js", () => ({ getWorkspaceAccess: access }));
vi.mock("../services/workspace-recommendation-visits.js", () => ({ getRecommendationVisit: getVisit, acknowledgeRecommendationVisit: ack }));
import { workspaceRecommendationVisitsRoutes } from "../routes/workspace-recommendation-visits.js";
const token = '550e8400-e29b-41d4-a716-446655440000';
function app(apiKey = false) {
  return new Hono().use('*', async (c, next) => {
    c.set('sessionUser', { id: 'u', email: 'u@example.test', name: 'U' });
    if (apiKey) c.set('apiKey', { userId: 'u' } as never);
    await next();
  }).route('/v1/workspaces', workspaceRecommendationVisitsRoutes).get('/v1/workspaces/unrelated', c => c.text('ok'));
}
beforeEach(() => { vi.clearAllMocks(); access.mockResolvedValue({ workspaceId: 'w', orgId: 'o' }); getVisit.mockResolvedValue({ token }); ack.mockResolvedValue(true); });
it('derives scope from the session and authorized workspace, and disables caching', async () => {
  const response = await app().request('/v1/workspaces/w/recommendation-visit');
  expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toContain('no-store');
  expect(getVisit).toHaveBeenCalledWith({ userId: 'u', orgId: 'o', workspaceId: 'w' });
});
it('denies cross-tenant and revoked workspace access for reads and acknowledgements', async () => {
  access.mockResolvedValue(null);
  expect((await app().request('/v1/workspaces/other/recommendation-visit')).status).toBe(404);
  expect((await app().request('/v1/workspaces/w/recommendation-visit/acknowledge', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) })).status).toBe(404);
  expect(getVisit).not.toHaveBeenCalled(); expect(ack).not.toHaveBeenCalled();
});
it('rejects API keys regardless of scope without restricting unrelated routes', async () => {
  expect((await app(true).request('/v1/workspaces/w/recommendation-visit')).status).toBe(403);
  expect((await app(true).request('/v1/workspaces/unrelated')).status).toBe(200);
  expect(access).not.toHaveBeenCalled();
});
it('rejects malformed, future, extra-field and oversized acknowledgements', async () => {
  for (const body of ['{', JSON.stringify({ token: 'invalid' }), JSON.stringify({ token, through: '9999-01-01' }), JSON.stringify({ token: 'x'.repeat(2048) })]) {
    const response = await app().request('/v1/workspaces/w/recommendation-visit/acknowledge', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    expect([400, 413]).toContain(response.status);
  }
  expect(ack).not.toHaveBeenCalled();
});
it('rejects replayed tokens and rechecks access for each acknowledgement', async () => {
  ack.mockResolvedValue(false);
  expect((await app().request('/v1/workspaces/w/recommendation-visit/acknowledge', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) })).status).toBe(409);
  expect(access).toHaveBeenCalledWith('w', 'u');
});
