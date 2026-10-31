import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { fromEnv } from "../config.js";
import { runVisionBenchmarks } from "./vision-benchmark.js";
import {
  assertProviderSupported,
  localVisionModelProfiles,
  resolveLocalVisionModelProfile,
  verifyProfileFromHuggingFace,
  type LocalVisionModelProfile,
  type LocalVisionProvider,
} from "./local-vision-models.js";

type CliCommand = "list" | "verify" | "run";

/**
 * `openai-compatible` targets an already-running OpenAI-compatible server
 * (for example vLLM reached through an SSH tunnel) with any served model. It
 * skips the pinned-profile lookup, Hugging Face hash verification and runtime
 * install, because the operator owns that server; `--base-url` must still be
 * loopback, as enforced by the vision route schema.
 */
type CliProvider = LocalVisionProvider | "openai-compatible";

interface CliArgs {
  command: CliCommand;
  model: string;
  provider: CliProvider;
  servedModel: string | null;
  prompt: string | null;
  install: boolean;
  json: boolean;
  outputPath: string | null;
  fixtureIds: string[] | undefined;
  maxPages: number | undefined;
  baseUrl: string | null;
  timeoutMs: number;
  includeBaselines: boolean;
  lmsGpu: string | null;
  contextLength: number;
}

const defaultArgs: CliArgs = {
  command: "list",
  model: "all",
  provider: "ollama",
  servedModel: null,
  prompt: null,
  install: false,
  json: false,
  outputPath: null,
  fixtureIds: undefined,
  maxPages: undefined,
  baseUrl: null,
  timeoutMs: 120_000,
  includeBaselines: false,
  lmsGpu: "auto",
  contextLength: 8192,
};

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.command === "list") {
    printProfiles(args.json);
    return;
  }

  if (args.command === "verify") {
    await verifyProfiles(args);
    return;
  }

  await runLocalEval(args);
}

function parseArgs(argv: string[]): CliArgs {
  const args = { ...defaultArgs };
  const normalizedArgv = argv[0] === "--" ? argv.slice(1) : argv;
  const [command] = normalizedArgv;
  let start = 0;

  if (command === "list" || command === "verify" || command === "run") {
    args.command = command;
    start = 1;
  }

  for (let i = start; i < normalizedArgv.length; i += 1) {
    const arg = normalizedArgv[i];
    if (arg === "--") {
      continue;
    }
    const readValue = () => {
      const value = normalizedArgv[i + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${arg} requires a value`);
      }
      i += 1;
      return value;
    };

    if (arg === "--model") args.model = readValue();
    else if (arg === "--provider") args.provider = readProvider(readValue());
    else if (arg === "--served-model") args.servedModel = readValue();
    else if (arg === "--prompt") args.prompt = readValue();
    else if (arg === "--install") args.install = true;
    else if (arg === "--json") args.json = true;
    else if (arg === "--output") args.outputPath = readValue();
    else if (arg === "--fixtures") args.fixtureIds = readCsv(readValue());
    else if (arg === "--max-pages") args.maxPages = readPositiveInt(readValue(), "--max-pages");
    else if (arg === "--base-url") args.baseUrl = readValue();
    else if (arg === "--timeout-ms") args.timeoutMs = readPositiveInt(readValue(), "--timeout-ms");
    else if (arg === "--include-baselines") args.includeBaselines = true;
    else if (arg === "--lms-gpu") args.lmsGpu = readValue();
    else if (arg === "--context-length") args.contextLength = readPositiveInt(readValue(), "--context-length");
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function printHelp(): void {
  console.log(`Usage: pnpm --filter @docslurp/worker eval:local-vision -- <command> [options]

Commands:
  list                         Show verified local model profiles.
  verify --model <id|all>      Check live Hugging Face metadata against pinned hashes.
  run --model <id>             Verify, wire a local runtime, then run DocSlurp vision evals.

Options:
  --provider <ollama|lms|openai-compatible>
                               Serving backend. Default: ollama. openai-compatible
                               uses a running server at --base-url (loopback, e.g.
                               an SSH tunnel to vLLM) and skips profile checks.
  --served-model <name>        Model name for --provider openai-compatible.
  --prompt <template>          Vision prompt template (<OCR>, markdown, layout, ...).
                               Default: the profile prompt, or markdown for
                               openai-compatible.
  --install                    Download/import the model through the selected backend.
  --base-url <url>             Override OpenAI-compatible base URL.
  --fixtures <csv>             Restrict benchmark fixture IDs.
  --max-pages <n>              Max rendered pages per fixture.
  --output <path>              Write JSON report to a file.
  --include-baselines          Also run existing Florence/OpenRouter benchmark candidates.
  --lms-gpu <auto|max|off|n>   GPU offload passed to lms load. Default: auto.
  --context-length <n>         Context length for lms load. Default: 8192.
  --timeout-ms <n>             Command timeout. Default: 120000.
  --json                       Emit machine-readable JSON for list/verify.
`);
}

function printProfiles(json: boolean): void {
  if (json) {
    console.log(JSON.stringify({ models: localVisionModelProfiles }, null, 2));
    return;
  }

  for (const profile of localVisionModelProfiles) {
    console.log(`${profile.id}  ${profile.label}`);
    console.log(`  repo: ${profile.repo}`);
    console.log(`  providers: ${profile.supportedProviders.join(", ")}`);
    console.log(`  format: ${profile.format}; status: ${profile.status}; license: ${profile.license}`);
    console.log(`  hardware: ${profile.hardwareNotes.join(" ")}`);
  }
}

async function verifyProfiles(args: CliArgs): Promise<void> {
  const profiles =
    args.model === "all"
      ? localVisionModelProfiles
      : [resolveLocalVisionModelProfile(args.model)];
  const results = [];

  for (const profile of profiles) {
    const result = await verifyProfileFromHuggingFace(profile);
    results.push(result);

    if (!args.json) {
      console.log(`${result.ok ? "PASS" : "FAIL"} ${profile.id} (${profile.repo})`);
      for (const file of result.files) {
        console.log(`  ${file.verified ? "ok" : "bad"} ${file.path} ${file.sha256 || "missing-sha"}`);
      }
      for (const warning of result.warnings) {
        console.log(`  warning: ${warning}`);
      }
      for (const error of result.errors) {
        console.log(`  error: ${error}`);
      }
    }
  }

  if (args.json) {
    console.log(JSON.stringify({ results }, null, 2));
  }

  if (results.some((result) => !result.ok)) {
    process.exitCode = 1;
  }
}

async function runLocalEval(args: CliArgs): Promise<void> {
  if (args.provider === "openai-compatible") {
    await runOpenAiCompatibleEval(args);
    return;
  }

  if (args.model === "all") {
    throw new Error("run requires --model <id>; use verify --model all for bulk safety checks");
  }

  const profile = resolveLocalVisionModelProfile(args.model);
  assertProviderSupported(profile, args.provider);

  const safety = await verifyProfileFromHuggingFace(profile);
  if (!safety.ok) {
    throw new Error(`Refusing to run ${profile.id}; safety check failed: ${safety.errors.join("; ")}`);
  }

  const runtime = await prepareProvider(profile, args);
  const cfg = fromEnv();
  const report = await runVisionBenchmarks({
    cfg,
    fixtureIds: args.fixtureIds,
    maxPagesPerFixture: args.maxPages,
    includeBaselines: args.includeBaselines,
    primaryVision: {
      target: "local",
      modelUri: `llm://vllm/${runtime.model}?baseUrl=${encodeURIComponent(runtime.baseUrl)}`,
      prompt: args.prompt ?? profile.defaultPrompt,
    },
  });

  await writePayload(args, {
    safety,
    provider: args.provider,
    model: profile.id,
    baseUrl: runtime.baseUrl,
    report,
  });
}

async function runOpenAiCompatibleEval(args: CliArgs): Promise<void> {
  const baseUrl = args.baseUrl?.replace(/\/+$/, "");
  const servedModel = args.servedModel ?? (args.model === "all" ? null : args.model);
  if (!baseUrl || !servedModel) {
    throw new Error("--provider openai-compatible requires --base-url and --served-model");
  }
  if (!(await openAiCompatibleServerReady(baseUrl))) {
    throw new Error(`No OpenAI-compatible server is answering at ${baseUrl}`);
  }
  const report = await runVisionBenchmarks({
    cfg: fromEnv(),
    fixtureIds: args.fixtureIds,
    maxPagesPerFixture: args.maxPages,
    includeBaselines: args.includeBaselines,
    primaryVision: {
      target: "local",
      modelUri: `llm://vllm/${servedModel}?baseUrl=${encodeURIComponent(baseUrl)}`,
      prompt: args.prompt ?? "markdown",
    },
  });
  await writePayload(args, {
    safety: null,
    provider: args.provider,
    model: servedModel,
    baseUrl,
    report,
  });
}

async function writePayload(args: CliArgs, payload: Record<string, unknown>): Promise<void> {
  if (args.outputPath) {
    await mkdir(path.dirname(args.outputPath), { recursive: true });
    await writeFile(args.outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    console.log(args.outputPath);
    return;
  }

  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

async function prepareProvider(
  profile: LocalVisionModelProfile,
  args: CliArgs,
): Promise<{ baseUrl: string; model: string }> {
  if (args.provider === "ollama") {
    if (!profile.ollamaRef) {
      throw new Error(`${profile.id} does not define an Ollama ref`);
    }
    await ensureBinary("ollama", args.timeoutMs);
    await ensureOllamaServer(args.timeoutMs);
    if (args.install) {
      await runCommand("ollama", ["pull", profile.ollamaRef], { timeoutMs: args.timeoutMs });
    }
    return {
      baseUrl: args.baseUrl ?? "http://localhost:11434/v1",
      model: profile.ollamaRef,
    };
  }

  if (!profile.lmsModelKey) {
    throw new Error(`${profile.id} does not define an LM Studio model key`);
  }
  await ensureBinary("lms", args.timeoutMs);
  await ensureLmsServer(args.timeoutMs);
  if (args.install) {
    await runCommand("lms", ["get", profile.lmsModelKey], { timeoutMs: args.timeoutMs });
  }
  await runCommand(
    "lms",
    [
      "load",
      profile.lmsModelKey,
      "--identifier",
      profile.serverModelId,
      "--context-length",
      String(args.contextLength),
      ...(args.lmsGpu ? ["--gpu", args.lmsGpu] : []),
    ],
    { timeoutMs: args.timeoutMs },
  );
  return {
    baseUrl: args.baseUrl ?? "http://localhost:1234/v1",
    model: profile.serverModelId,
  };
}

async function ensureBinary(binary: string, timeoutMs: number): Promise<void> {
  await runCommand(binary, ["--help"], { timeoutMs });
}

async function ensureOllamaServer(timeoutMs: number): Promise<void> {
  if (await openAiCompatibleServerReady("http://localhost:11434/v1")) {
    return;
  }

  const child = spawn("ollama", ["serve"], {
    stdio: "ignore",
    detached: true,
  });
  child.unref();
  await waitForServer("http://localhost:11434/v1", timeoutMs);
}

async function ensureLmsServer(timeoutMs: number): Promise<void> {
  const status = await runCommand("lms", ["server", "status", "--json", "--quiet"], {
    timeoutMs,
    allowFailure: true,
  });

  if (status.exitCode === 0 && status.stdout.includes('"running": true')) {
    return;
  }

  await runCommand("lms", ["server", "start"], { timeoutMs });
  await waitForServer("http://localhost:1234/v1", timeoutMs);
}

async function waitForServer(baseUrl: string, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await openAiCompatibleServerReady(baseUrl)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for local server at ${baseUrl}`);
}

async function openAiCompatibleServerReady(baseUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/models`);
    return response.ok;
  } catch {
    return false;
  }
}

async function runCommand(
  binary: string,
  args: string[],
  options: { timeoutMs: number; allowFailure?: boolean },
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
    }, options.timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      if (exitCode !== 0 && !options.allowFailure) {
        reject(new Error(`${binary} ${args.join(" ")} failed with ${exitCode}: ${stderr || stdout}`));
        return;
      }
      resolve({ exitCode, stdout, stderr });
    });
  });
}

function readProvider(value: string): CliProvider {
  if (value === "ollama" || value === "lms" || value === "openai-compatible") {
    return value;
  }
  throw new Error(`Unsupported provider '${value}'. Expected ollama, lms or openai-compatible.`);
}

function readCsv(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function readPositiveInt(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
