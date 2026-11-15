import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
export async function admission(client, mode, holder) {
  if (!['pause', 'drain', 'resume'].includes(mode) || !/^[a-zA-Z0-9_-]{8,128}$/.test(holder || '')) throw new Error('Invalid ingestion fence request');
  await client.query("SET statement_timeout = '30s'");
  if (mode === 'pause') {
    const result = await client.query('UPDATE docslurp_deploy.ingest_admission SET holder=$1 WHERE singleton AND (holder IS NULL OR holder=$1) RETURNING holder', [holder]);
    if (result.rowCount !== 1) throw new Error('Ingestion fence owned by another deployment');
  } else {
    await client.query('BEGIN');
    try {
      const { rows } = await client.query('SELECT holder FROM docslurp_deploy.ingest_admission WHERE singleton FOR UPDATE');
      if (rows.length !== 1 || rows[0].holder !== holder) throw new Error('Ingestion fence ownership lost');
      const { rows: [state] } = await client.query("SELECT count(*)::integer AS open FROM public.project_runs WHERE status IS NULL OR status NOT IN ('completed','failed','cancelled')");
      if (!state || !Number.isSafeInteger(state.open)) throw new Error('Invalid run drain result');
      if (state.open !== 0) { const error = new Error('Ingestion runs have not drained'); error.code = 'RUNS_OPEN'; throw error; }
      if (mode === 'resume') await client.query('UPDATE docslurp_deploy.ingest_admission SET holder=NULL WHERE singleton');
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
  }
}
export async function waitForDrain(client, holder, { timeoutMs = 240000, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const deadline = now() + timeoutMs;
  for (;;) {
    try { await admission(client, 'drain', holder); return; }
    catch (error) {
      if (error.code !== 'RUNS_OPEN') throw error;
      const remaining = deadline - now();
      if (remaining <= 0) throw new Error('Ingestion drain timed out; admission remains closed');
      await sleep(Math.min(2000, remaining));
    }
  }
}
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const require = createRequire(import.meta.url);
  const { Client } = require('pg');
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  try {
    await client.connect();
    if (process.argv[2] === 'drain') await waitForDrain(client, process.argv[3]);
    else await admission(client, process.argv[2], process.argv[3]);
  }
  catch { console.error('Ingestion fence refused; admission remains closed if acquired'); process.exitCode = 1; }
  finally { await client.end(); }
}
