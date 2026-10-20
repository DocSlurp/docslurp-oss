import type { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";

import { createMigratedDatabase } from "./migrated-db.js";

/**
 * A migrated in-memory Postgres (see migrated-db.ts) behind a local socket, so
 * code that talks to Postgres over the wire (postgres.js, app services) can run
 * against it. The socket serves one connection at a time: clients should use
 * `max: 1`. App DB tests import this file by relative path, because PGlite is a
 * worker dev dependency.
 */
/**
 * Serves `db` on a random local port. Test files run in parallel, so a port
 * can already be taken (EADDRINUSE); another one is tried. `maxConnections`
 * lets several clients connect at once; PGlite still runs one query at a time.
 */
export async function serveOnRandomPort(
  db: PGlite,
  options: { maxConnections?: number } = {},
): Promise<{ server: PGLiteSocketServer; port: number }> {
  for (let attempt = 0; ; attempt++) {
    const port = 40_000 + Math.floor(Math.random() * 20_000);
    const server = new PGLiteSocketServer({ db, port, host: "127.0.0.1", ...(options.maxConnections ? { maxConnections: options.maxConnections } : {}) });
    try {
      await server.start();
      return { server, port };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE" || attempt >= 10) throw error;
    }
  }
}

export async function startMigratedPostgres(): Promise<{ db: PGlite; url: string; stop: () => Promise<void> }> {
  const db = await createMigratedDatabase();
  const { server, port } = await serveOnRandomPort(db);
  return {
    db,
    url: `postgres://postgres@127.0.0.1:${port}/postgres`,
    stop: async () => {
      await server.stop();
      await db.close();
    },
  };
}
