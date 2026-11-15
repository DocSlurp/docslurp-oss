import test from 'node:test';
import assert from 'node:assert/strict';
import { admission, waitForDrain } from './ingest-admission.mjs';
function client({holder='deploy-12345',open=0,rowCount=1}={}) { const calls=[];return {calls,query:async(sql,args)=>{calls.push([sql,args]); if(sql.startsWith('SELECT holder')) return {rows:[{holder}]};if(sql.includes('count(*)'))return {rows:[{open}]};return {rowCount};}}; }
test('pause refuses competing deployment',async()=>{await assert.rejects(admission(client({rowCount:0}),'pause','deploy-12345'));});
test('resume never opens when runs remain or ownership changed',async()=>{for(const state of [{open:1},{open:null},{holder:'other-deploy'}]){const c=client(state);await assert.rejects(admission(c,'resume','deploy-12345'));assert.ok(!c.calls.some(([s])=>s.includes('SET holder=NULL')));assert.equal(c.calls.at(-1)[0],'ROLLBACK');}});
test('drain is read-only under ownership lock; resume checks drain before reopening',async()=>{for(const mode of ['drain','resume']){const c=client();await admission(c,mode,'deploy-12345');assert.equal(c.calls.at(-1)[0],'COMMIT');assert.equal(c.calls.some(([s])=>s.includes('SET holder=NULL')),mode==='resume');}});
test('invalid requests and query failures fail closed',async()=>{await assert.rejects(admission(client(),'resume','bad'));await assert.rejects(admission({query:async()=>{throw Error('offline');}},'pause','deploy-12345'));});

test('database triggers fence all tenants, sessions and run readmission while allowing existing work to finish', async()=>{
 const { readFileSync } = await import('node:fs');
 const { PGlite } = await import('@electric-sql/pglite');
 const db = new PGlite();
 try {
  await db.exec("CREATE TABLE project_runs(id text, status text); CREATE TABLE documents(id text); CREATE TABLE upload_sessions(id text);");
  await db.exec(readFileSync(new URL('./migrations/0173_ingest_admission.sql',import.meta.url),'utf8'));
  await db.exec("INSERT INTO project_runs VALUES ('existing','queued');");
  await db.exec("CREATE ROLE admission_untrusted; GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO admission_untrusted; SET ROLE admission_untrusted");
  await assert.rejects(db.exec("UPDATE docslurp_deploy.ingest_admission SET holder=NULL"), /permission denied/);
  await db.exec('RESET ROLE');
  await admission(db,'pause','deploy-12345');
  await db.exec(readFileSync(new URL('./migrations/0173_ingest_admission.sql',import.meta.url),'utf8'));
  assert.equal((await db.query('SELECT holder FROM docslurp_deploy.ingest_admission')).rows[0].holder, 'deploy-12345');
  await db.exec('SET ROLE admission_untrusted');
  for(const sql of ["INSERT INTO documents VALUES ('tenant-b')", "INSERT INTO upload_sessions VALUES ('tenant-a')", "INSERT INTO project_runs VALUES ('new','queued')"] ) await assert.rejects(db.exec(sql),/Ingestion temporarily paused/);
  await db.exec('RESET ROLE');
  await assert.rejects(admission(db,'drain','deploy-12345'),/not drained/);
  await db.exec("UPDATE project_runs SET status='completed' WHERE id='existing'");
  await assert.rejects(db.exec("UPDATE project_runs SET status='queued' WHERE id='existing'"),/Ingestion temporarily paused/);
  await admission(db,'drain','deploy-12345');
  await admission(db,'resume','deploy-12345');
  await db.exec("INSERT INTO documents VALUES ('after'); INSERT INTO upload_sessions VALUES ('after'); INSERT INTO project_runs VALUES ('after','queued')");
 } finally {await db.close();}
});

test('drain timeout never resumes and database errors never retry', async()=>{
 let time=0; const c=client({open:1});
 await assert.rejects(waitForDrain(c,'deploy-12345',{timeoutMs:5,now:()=>time,sleep:async ms=>{time+=ms;}}),/timed out/);
 assert.ok(!c.calls.some(([sql])=>sql.includes('SET holder=NULL')));
 let calls=0; await assert.rejects(waitForDrain({query:async()=>{calls++;throw Error('database unavailable');}},'deploy-12345',{sleep:async()=>assert.fail('must not retry errors')}),/unavailable/);assert.equal(calls,1);
});
