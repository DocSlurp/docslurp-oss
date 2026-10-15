#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const destination = join(root, ".env.selfhost");
const template = join(root, ".env.selfhost.example");

if (existsSync(destination)) {
  console.error(".env.selfhost already exists; keeping its credentials unchanged.");
  process.exit(1);
}

const postgresPassword = randomBytes(24).toString("hex");
const values = {
  POSTGRES_PASSWORD: postgresPassword,
  DATABASE_URL: `postgres://docslurp:${postgresPassword}@postgres:5432/docslurp`,
  AWS_ACCESS_KEY_ID: `ds${randomBytes(12).toString("hex")}`,
  AWS_SECRET_ACCESS_KEY: randomBytes(32).toString("hex"),
  BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
  OAUTH_TOKEN_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
  CREDENTIALS_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
  SECRETS_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
  METRICS_SECRET: randomBytes(32).toString("hex"),
};

const content = readFileSync(template, "utf8").replace(
  /^([A-Z][A-Z0-9_]*)=REPLACE_ME$/gm,
  (line, key) => values[key] === undefined ? line : `${key}=${values[key]}`,
).replace(/^DATABASE_URL=.*$/m, `DATABASE_URL=${values.DATABASE_URL}`);

if (/^[A-Z][A-Z0-9_]*=.*REPLACE_ME$/m.test(content)) {
  throw new Error("Unresolved placeholder in .env.selfhost.example");
}

writeFileSync(destination, content, { flag: "wx", mode: 0o600 });
console.log("Created .env.selfhost with independent random credentials. Edit SELFHOST_URL before exposing the app.");
