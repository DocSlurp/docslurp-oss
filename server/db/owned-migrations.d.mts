import type { Client } from "pg";

export declare function applyOwnedMigrations(client: Client, options: {
  migrationsFolder: string;
  env?: Record<string, string | undefined>;
}): Promise<void>;
