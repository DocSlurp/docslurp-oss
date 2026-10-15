import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks=vi.hoisted(()=>({ search:vi.fn(), workspace:vi.fn(), scope:vi.fn() }));
vi.mock('../middleware/api-key-auth.js',()=>({apiKeyAuth:async(c:any,next:any)=>{if(!c.req.header('Authorization'))return c.json({error:'Unauthorized'},401);c.set('apiKey',{userId:'u'});await next();}}));
vi.mock('../lib/api-key-authorization.js',()=>({apiKeyHasAnyScope:mocks.scope,loadApiKeyScopedWorkspace:mocks.workspace}));
vi.mock('../services/search.js',()=>({hybridSearch:mocks.search}));
vi.mock('../lib/request-actor.js',()=>({resolveActorWorkspaceId:async(_actor:unknown,id:string)=>id}));
import { searchCompatRoutes } from '../routes/search-compat';
const app=new Hono().route('/compat',searchCompatRoutes);
const request=(path:string,body:unknown,key=true)=>app.request('/compat'+path,{method:'POST',headers:{'Content-Type':'application/json',...(key?{Authorization:'Bearer key'}:{})},body:JSON.stringify(body)});
describe('search compatibility routes',()=>{
  beforeEach(()=>{vi.clearAllMocks();mocks.scope.mockReturnValue(true);mocks.workspace.mockResolvedValue({id:'ws'});mocks.search.mockResolvedValue({results:[{text:'hello',score:1,citation:{documentId:'doc',filename:'Guide',chunkIndex:0}}],sessionId:'session',availability:null,usageEvents:[]});});
  it('uses scoped retrieval and preserves usage metadata',async()=>{
    const res=await request('/meilisearch/indexes/ws/search',{q:'hello',limit:5});expect(res.status).toBe(200);
    const data=await res.json();expect(data.hits[0].text).toBe('hello');expect(data.docslurp.sessionId).toBe('session');expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(mocks.search.mock.calls[0][2].filters.workspaceId).toBe('ws');expect(mocks.search.mock.calls[0][2].useHyDE).toBe(false);
  });
  it('requires auth and rejects inaccessible workspaces and scopes before search',async()=>{
    expect((await request('/pagefind/ws/search',{term:'x'},false)).status).toBe(401);
    mocks.scope.mockReturnValue(false);expect((await request('/pagefind/ws/search',{term:'x'})).status).toBe(403);
    mocks.scope.mockReturnValue(true);mocks.workspace.mockResolvedValue(null);expect((await request('/pagefind/ws/search',{term:'x'})).status).toBe(404);expect(mocks.search).not.toHaveBeenCalled();
  });
  it('rejects unsupported options and malformed inputs',async()=>{
    expect((await request('/meilisearch/indexes/ws/search',{q:'x',filter:'tenant=other'})).status).toBe(400);
    expect((await request('/typesense/collections/ws/documents/search',{q:'x',page:8,per_page:20})).status).toBe(400);expect(mocks.search).not.toHaveBeenCalled();
  });
  it('authorizes the entire batch before retrieval and preserves order',async()=>{
    mocks.workspace.mockImplementation(async(id)=>id==='denied'?null:{id});
    const body={searches:[{collection:'ws',q:'x'},{collection:'denied',q:'y'}]};
    expect((await request('/typesense/multi_search',body)).status).toBe(404);expect(mocks.search).not.toHaveBeenCalled();
    body.searches[1].collection='ws';const res=await request('/typesense/multi_search',body);expect(res.status).toBe(200);expect((await res.json()).results).toHaveLength(2);
  });
  it('accepts native Typesense keys and GET query parameters',async()=>{
    const res=await app.request('/compat/typesense/collections/ws/documents/search?q=hello&query_by=text&per_page=5',{headers:{'X-TYPESENSE-API-KEY':'key'}});expect(res.status).toBe(200);expect((await res.json()).hits[0].document.text).toBe('hello');
  });
  it('rejects absent query fields, malformed JSON and oversized batches before retrieval', async () => {
    expect((await request('/pagefind/ws/search', {})).status).toBe(400);
    expect((await request('/typesense/collections/ws/documents/search', {})).status).toBe(400);
    expect((await request('/typesense/multi_search', {searches:Array.from({length:11},()=>({collection:'ws',q:'x'}))})).status).toBe(400);
    const malformed=await app.request('/compat/pagefind/ws/search',{method:'POST',headers:{Authorization:'Bearer key','Content-Type':'application/json'},body:'{'});
    expect(malformed.status).toBe(400);
    expect(mocks.search).not.toHaveBeenCalled();
  });
  it('does not incur retrieval usage for empty initial UI searches', async () => {
    const res=await request('/typesense/collections/ws/documents/search',{q:'  '});
    expect(res.status).toBe(200);expect((await res.json()).found).toBe(0);
    expect(mocks.search).not.toHaveBeenCalled();
  });
});
