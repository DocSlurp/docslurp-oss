import { loadSandboxProvider, resolveSandboxProviderId } from "./registry.js";

/** `node dist/sandbox/probe-cli.js`: prints `ok <provider>` or the failure detail; exit code 0/1. */
async function main(): Promise<number> {
  const id = resolveSandboxProviderId(process.env, process.platform);
  const provider = await loadSandboxProvider(id);
  const result = await provider.probe(provider.readConfig(process.env));
  if (!result.ok) {
    console.log(result.detail);
    return 1;
  }
  console.log(`ok ${provider.id}`);
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    console.log(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  },
);
