// Runs the server/db migration checks. With DATABASE_URL set they run against that
// (local) Postgres; otherwise against an in-memory PGlite built from
// server/db/migrations by the worker's testing helper, so CI needs no database service.
const remote = process.env.DATABASE_URL;
let stop;
if (!remote) {
  const { startMigratedPostgres } = await import('@docslurp/worker/testing');
  const database = await startMigratedPostgres();
  process.env.DATABASE_URL = database.url;
  stop = database.stop;
}
try {
  for (const name of ['starter-credit', 'fractional-usage-costs', 'run-control-admission']) await import(`./${name}.mjs`);
} finally {
  await stop?.();
}
