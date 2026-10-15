import { mkdir, mkdtemp, readdir, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

type ExtractorId =
  | "pdftotext"
  | "native-pdf"
  | "kreuzberg"
  | "docling"
  | "unstructured-fast"
  | "unstructured-hi-res";

type BenchmarkResult = {
  extractor: ExtractorId;
  available: boolean;
  status: "passed" | "failed" | "timeout" | "missing";
  durationMs: number;
  outputPath: string | null;
  outputBytes: number;
  textChars: number;
  words: number;
  lines: number;
  stderrTail: string;
};

const sourceDir = path.dirname(fileURLToPath(import.meta.url));
const workerRoot = path.resolve(sourceDir, "../..");
const repoRoot = path.resolve(workerRoot, "..");
const scriptsDir = path.join(workerRoot, "scripts");
const defaultInput = path.join(
  repoRoot,
  ".tmp/curated-corpus-e2e/pdf-smoke/compact-transformer-methods.pdf",
);

function parseArgs(argv: string[]) {
  const args = {
    input: process.env.DOCSLURP_EXTRACTOR_BENCH_INPUT ?? defaultInput,
    timeoutMs: Number(process.env.DOCSLURP_EXTRACTOR_BENCH_TIMEOUT_MS ?? 60_000),
    outputDir: "",
    json: false,
    extractors: null as ExtractorId[] | null,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") {
      continue;
    }
    const readValue = () => {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${arg} requires a value`);
      }
      i += 1;
      return value;
    };

    if (arg === "--input") args.input = readValue();
    else if (arg === "--timeout-ms") args.timeoutMs = Number(readValue());
    else if (arg === "--output-dir") args.outputDir = readValue();
    else if (arg === "--json") args.json = true;
    else if (arg === "--extractors") {
      args.extractors = readValue()
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean) as ExtractorId[];
    } else if (arg === "--help") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0) {
    throw new Error("--timeout-ms must be a positive number");
  }
  return args;
}

function printHelp() {
  console.log(`Usage: pnpm --filter @docslurp/worker benchmark:extractors -- [options]

Options:
  --input <pdf>              PDF to benchmark. Defaults to the generated pdf-smoke fixture.
  --timeout-ms <n>           Per-extractor timeout. Default 60000.
  --output-dir <dir>         Keep outputs in this directory instead of a temp directory.
  --extractors <csv>         Restrict extractors, e.g. kreuzberg,native-pdf,docling.
  --json                     Emit JSON only.
`);
}

function extractorIds(): ExtractorId[] {
  return [
    "pdftotext",
    "native-pdf",
    "kreuzberg",
    "docling",
    "unstructured-fast",
    "unstructured-hi-res",
  ];
}

function commandFor(extractor: ExtractorId, input: string, outputDir: string) {
  switch (extractor) {
    case "pdftotext":
      return {
        binary: "pdftotext",
        args: [input, path.join(outputDir, "pdftotext.txt")],
        outputPath: path.join(outputDir, "pdftotext.txt"),
      };
    case "native-pdf":
      return {
        binary: "node",
        args: [
          "--import",
          "tsx",
          path.join(workerRoot, "src/native-pdf/extract-cli.ts"),
          "--input",
          input,
          "--output",
          path.join(outputDir, "native-pdf.md"),
        ],
        outputPath: path.join(outputDir, "native-pdf.md"),
      };
    case "kreuzberg":
      return {
        binary: "node",
        args: [
          path.join(scriptsDir, "kreuzberg_extract.mjs"),
          "--input",
          input,
          "--output",
          path.join(outputDir, "kreuzberg.md"),
        ],
        outputPath: path.join(outputDir, "kreuzberg.md"),
      };
    case "docling":
      return {
        binary: "docling",
        args: ["--from", "pdf", "--to", "md", "--output", path.join(outputDir, "docling"), input],
        outputPath: path.join(outputDir, "docling"),
      };
    case "unstructured-fast":
      return {
        binary: "python3",
        args: [
          path.join(scriptsDir, "unstructured_partition.py"),
          "--input",
          input,
          "--output",
          path.join(outputDir, "unstructured-fast.json"),
          "--strategy",
          "fast",
        ],
        outputPath: path.join(outputDir, "unstructured-fast.json"),
      };
    case "unstructured-hi-res":
      return {
        binary: "python3",
        args: [
          path.join(scriptsDir, "unstructured_partition.py"),
          "--input",
          input,
          "--output",
          path.join(outputDir, "unstructured-hi-res.json"),
          "--strategy",
          "hi_res",
        ],
        outputPath: path.join(outputDir, "unstructured-hi-res.json"),
      };
  }
}

async function runCommand(
  extractor: ExtractorId,
  input: string,
  outputDir: string,
  timeoutMs: number,
): Promise<BenchmarkResult> {
  const command = commandFor(extractor, input, outputDir);
  const startedAt = performance.now();

  return await new Promise<BenchmarkResult>((resolve) => {
    const child = spawn(command.binary, command.args, {
      cwd: workerRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    let stdout = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", async () => {
      clearTimeout(timer);
      resolve(await buildResult(extractor, false, "missing", startedAt, command.outputPath, stderr || stdout));
    });
    child.on("close", async (code) => {
      clearTimeout(timer);
      if (timedOut) {
        resolve(await buildResult(extractor, true, "timeout", startedAt, command.outputPath, stderr || stdout));
        return;
      }
      resolve(
        await buildResult(
          extractor,
          true,
          code === 0 ? "passed" : "failed",
          startedAt,
          command.outputPath,
          stderr || stdout,
        ),
      );
    });
  });
}

async function buildResult(
  extractor: ExtractorId,
  available: boolean,
  status: BenchmarkResult["status"],
  startedAt: number,
  outputPath: string,
  stderr: string,
): Promise<BenchmarkResult> {
  const resolvedOutputPath = await findOutputFile(outputPath);
  const text = resolvedOutputPath ? await readFile(resolvedOutputPath, "utf8").catch(() => "") : "";
  const outputBytes = resolvedOutputPath ? (await stat(resolvedOutputPath)).size : 0;
  return {
    extractor,
    available,
    status,
    durationMs: Math.round(performance.now() - startedAt),
    outputPath: resolvedOutputPath,
    outputBytes,
    textChars: text.length,
    words: text.match(/\S+/g)?.length ?? 0,
    lines: text ? text.split("\n").length : 0,
    stderrTail: stderr.trim().split("\n").slice(-8).join("\n"),
  };
}

async function findOutputFile(outputPath: string): Promise<string | null> {
  if (existsSync(outputPath) && (await stat(outputPath)).isFile()) {
    return outputPath;
  }
  if (!existsSync(outputPath)) {
    return null;
  }
  const files = await walk(outputPath);
  return files.find((file) => /\.(md|txt|json)$/i.test(file)) ?? files[0] ?? null;
}

async function walk(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(fullPath)));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files;
}

function printTable(results: BenchmarkResult[], outputDir: string) {
  console.log(`Extractor benchmark output: ${outputDir}`);
  console.log("extractor\tstatus\tms\tbytes\tchars\twords\tlines\toutput");
  for (const result of results) {
    console.log([
      result.extractor,
      result.status,
      result.durationMs,
      result.outputBytes,
      result.textChars,
      result.words,
      result.lines,
      result.outputPath ?? "",
    ].join("\t"));
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const input = path.resolve(args.input);
  if (!existsSync(input)) {
    throw new Error(`input PDF does not exist: ${input}`);
  }
  const outputDir = args.outputDir
    ? path.resolve(args.outputDir)
    : await mkdtemp(path.join(tmpdir(), "docslurp-extractor-benchmark-"));
  await mkdir(outputDir, { recursive: true });
  const selected = args.extractors ?? extractorIds();
  const results: BenchmarkResult[] = [];
  for (const extractor of selected) {
    results.push(await runCommand(extractor, input, outputDir, args.timeoutMs));
  }
  const payload = {
    input,
    timeoutMs: args.timeoutMs,
    outputDir,
    results,
  };
  if (args.json) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    printTable(results, outputDir);
    console.log(JSON.stringify(payload, null, 2));
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
