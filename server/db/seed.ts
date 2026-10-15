import { fileURLToPath } from "node:url";

import { config as loadEnv } from "dotenv";
import { seedNonProductionUsers } from "../src/lib/seed-users.ts";

loadEnv({ path: fileURLToPath(new URL("../.env", import.meta.url)), quiet: true });

if (process.env.NODE_ENV === "production") {
  throw new Error("server/db/seed.ts is disabled in production");
}

void seedNonProductionUsers({ includeFixtures: true }).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
