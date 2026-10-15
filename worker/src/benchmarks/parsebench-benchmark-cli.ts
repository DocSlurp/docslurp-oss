import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { homedir } from "node:os";

import {
  parseBenchDocSlurpExtractors,
  type ParseBenchDocSlurpExtractor,
} from "./parsebench-extractors.js";

const PARSEBENCH_REPO = "https://github.com/run-llama/ParseBench";
const DOCSLURP_EVALS_DB_PATH = path.join(homedir(), ".docslurp.evals.sqlite");
const SQLITE_MANIFEST_ENV = "DOCSLURP_EVAL_MANIFEST";

type EvalCategorySummary = {
  category: string;
  metrics: Record<string, number>;
  examplesTotal: number | null;
  examplesSuccessful: number | null;
  examplesFailed: number | null;
  examplesSkipped: number | null;
};

type EvalRunManifest = {
  runId: string;
  archivedAt: string;
  pipelineName: string;
  extractor: ParseBenchDocSlurpExtractor;
  groups: string[];
  partialRun: boolean;
  parseBenchDir: string;
  sourceOutputDir: string;
  gitCommit: string | null;
  historyPath: string;
  categories: EvalCategorySummary[];
};

function readArg(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function splitCsv(value: string | undefined): string[] {
  return value?.split(",").map((part) => part.trim()).filter(Boolean) ?? [];
}

function repoRoot(): string {
  return path.basename(process.cwd()) === "worker"
    ? path.resolve(process.cwd(), "..")
    : process.cwd();
}

function parseExtractor(value: string | undefined): ParseBenchDocSlurpExtractor {
  const extractor = value ?? "kreuzberg";
  if (parseBenchDocSlurpExtractors.includes(extractor as ParseBenchDocSlurpExtractor)) {
    return extractor as ParseBenchDocSlurpExtractor;
  }

  throw new Error(
    `Unknown extractor "${extractor}". Valid extractors: ${parseBenchDocSlurpExtractors.join(", ")}`,
  );
}

async function runCommand(args: {
  command: string;
  argv: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(args.command, args.argv, {
      cwd: args.cwd,
      env: args.env ?? process.env,
      stdio: "inherit",
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${args.command} exited with ${code ?? "unknown"}`));
    });
  });
}

async function runCommandCapture(args: {
  command: string;
  argv: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{ stdout: string; stderr: string; code: number }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(args.command, args.argv, {
      cwd: args.cwd,
      env: args.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        stdout,
        stderr,
        code: code ?? 1,
      });
    });
  });
}

function sanitizeUvEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const nextEnv = { ...env };
  delete nextEnv.VIRTUAL_ENV;
  return nextEnv;
}

function formatTimestampForPath(date: Date): string {
  const iso = date.toISOString();
  return iso.slice(0, 19).replaceAll(":", "-");
}

function formatTimestampForDisplay(date: Date): string {
  return date.toISOString();
}

function readJsonObject(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

function pickAggregateMetrics(report: Record<string, unknown>): Record<string, number> {
  const candidateKeys = [
    "aggregate_metrics",
    "aggregateMetrics",
    "metrics",
    "summary_metrics",
    "summaryMetrics",
  ];

  for (const key of candidateKeys) {
    const value = report[key];
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      continue;
    }

    const numericEntries = Object.entries(value).filter((entry): entry is [string, number] =>
      typeof entry[1] === "number" && Number.isFinite(entry[1]),
    );
    if (numericEntries.length > 0) {
      return Object.fromEntries(numericEntries);
    }
  }

  return {};
}

async function collectCategorySummaries(
  pipelineOutputDir: string,
  requestedGroups: string[],
): Promise<EvalCategorySummary[]> {
  const entries = await readdir(pipelineOutputDir, { withFileTypes: true });
  const categories: EvalCategorySummary[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    if (requestedGroups.length > 0 && !requestedGroups.includes(entry.name)) {
      continue;
    }

    const reportPath = path.join(
      pipelineOutputDir,
      entry.name,
      "_evaluation_report.json",
    );
    if (!existsSync(reportPath)) {
      continue;
    }

    const report = readJsonObject(await readFile(reportPath, "utf8"));
    const totals = report.totals;
    const totalObject =
      totals && typeof totals === "object" && !Array.isArray(totals)
        ? (totals as Record<string, unknown>)
        : report;

    categories.push({
      category: entry.name,
      metrics: pickAggregateMetrics(report),
      examplesTotal:
        typeof totalObject.total_examples === "number"
          ? totalObject.total_examples
          : typeof totalObject.totalExamples === "number"
            ? totalObject.totalExamples
            : null,
      examplesSuccessful:
        typeof totalObject.successful === "number" ? totalObject.successful : null,
      examplesFailed:
        typeof totalObject.failed === "number" ? totalObject.failed : null,
      examplesSkipped:
        typeof totalObject.skipped === "number" ? totalObject.skipped : null,
    });
  }

  return categories.sort((left, right) => left.category.localeCompare(right.category));
}

async function persistRunToSqlite(manifest: EvalRunManifest): Promise<void> {
  const script = `
import json
import os
import sqlite3
from pathlib import Path

db_path = Path(${JSON.stringify(DOCSLURP_EVALS_DB_PATH)}).expanduser()
db_path.parent.mkdir(parents=True, exist_ok=True)
manifest = json.loads(os.environ[${JSON.stringify(SQLITE_MANIFEST_ENV)}])

conn = sqlite3.connect(db_path)
try:
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("""
        CREATE TABLE IF NOT EXISTS eval_runs (
            run_id TEXT PRIMARY KEY,
            archived_at TEXT NOT NULL,
            pipeline_name TEXT NOT NULL,
            extractor TEXT NOT NULL,
            groups_json TEXT NOT NULL,
            partial_run INTEGER NOT NULL,
            parsebench_dir TEXT NOT NULL,
            source_output_dir TEXT NOT NULL,
            git_commit TEXT,
            history_path TEXT NOT NULL,
            manifest_json TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS eval_category_metrics (
            run_id TEXT NOT NULL,
            category TEXT NOT NULL,
            metric_name TEXT NOT NULL,
            metric_value REAL NOT NULL,
            examples_total INTEGER,
            examples_successful INTEGER,
            examples_failed INTEGER,
            examples_skipped INTEGER,
            PRIMARY KEY (run_id, category, metric_name),
            FOREIGN KEY (run_id) REFERENCES eval_runs(run_id) ON DELETE CASCADE
        )
    """)
    conn.execute("DELETE FROM eval_category_metrics WHERE run_id = ?", (manifest["runId"],))
    conn.execute(
        """
        INSERT INTO eval_runs (
            run_id,
            archived_at,
            pipeline_name,
            extractor,
            groups_json,
            partial_run,
            parsebench_dir,
            source_output_dir,
            git_commit,
            history_path,
            manifest_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id) DO UPDATE SET
            archived_at=excluded.archived_at,
            pipeline_name=excluded.pipeline_name,
            extractor=excluded.extractor,
            groups_json=excluded.groups_json,
            partial_run=excluded.partial_run,
            parsebench_dir=excluded.parsebench_dir,
            source_output_dir=excluded.source_output_dir,
            git_commit=excluded.git_commit,
            history_path=excluded.history_path,
            manifest_json=excluded.manifest_json
        """,
        (
            manifest["runId"],
            manifest["archivedAt"],
            manifest["pipelineName"],
            manifest["extractor"],
            json.dumps(manifest["groups"]),
            1 if manifest["partialRun"] else 0,
            manifest["parseBenchDir"],
            manifest["sourceOutputDir"],
            manifest["gitCommit"],
            manifest["historyPath"],
            json.dumps(manifest),
        ),
    )
    rows = []
    for category in manifest["categories"]:
        for metric_name, metric_value in category["metrics"].items():
            rows.append(
                (
                    manifest["runId"],
                    category["category"],
                    metric_name,
                    float(metric_value),
                    category["examplesTotal"],
                    category["examplesSuccessful"],
                    category["examplesFailed"],
                    category["examplesSkipped"],
                )
            )
    conn.executemany(
        """
        INSERT INTO eval_category_metrics (
            run_id,
            category,
            metric_name,
            metric_value,
            examples_total,
            examples_successful,
            examples_failed,
            examples_skipped
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        rows,
    )
    conn.commit()
finally:
    conn.close()
print(db_path)
`;

  const result = await runCommandCapture({
    command: "python3",
    argv: ["-c", script],
    cwd: repoRoot(),
    env: {
      ...process.env,
      [SQLITE_MANIFEST_ENV]: JSON.stringify(manifest),
    },
  });
  if (result.code !== 0) {
    throw new Error(
      `python3 exited with ${result.code}: ${result.stderr || result.stdout}`,
    );
  }
  console.log(
    `[parsebench-history] sqlite-recorded run=${manifest.runId} db=${result.stdout.trim() || DOCSLURP_EVALS_DB_PATH}`,
  );
}

async function archiveRun(args: {
  root: string;
  outputDir: string;
  pipelineName: string;
  extractor: ParseBenchDocSlurpExtractor;
  groups: string[];
  parseBenchDir: string;
}): Promise<void> {
  const pipelineOutputDir = path.join(args.outputDir, args.pipelineName);
  if (!existsSync(pipelineOutputDir)) {
    console.warn(
      `[parsebench-history] skipped archive: pipeline output not found at ${pipelineOutputDir}`,
    );
    return;
  }

  const archivedAt = new Date();
  const runId = formatTimestampForPath(archivedAt);
  const historyRoot = path.join(args.root, ".benchmarks", "parsebench-history");
  const pipelineHistoryRoot = path.join(historyRoot, args.pipelineName);
  const snapshotRoot = path.join(pipelineHistoryRoot, runId);
  const snapshotOutputDir = path.join(snapshotRoot, "output");
  await mkdir(snapshotOutputDir, { recursive: true });
  await cp(pipelineOutputDir, snapshotOutputDir, { recursive: true });

  const categories = await collectCategorySummaries(
    snapshotOutputDir,
    args.groups,
  );
  const manifest: EvalRunManifest = {
    runId,
    archivedAt: formatTimestampForDisplay(archivedAt),
    pipelineName: args.pipelineName,
    extractor: args.extractor,
    groups: args.groups,
    partialRun: args.groups.length > 0,
    parseBenchDir: args.parseBenchDir,
    sourceOutputDir: pipelineOutputDir,
    gitCommit: process.env.GIT_COMMIT_SHA ?? process.env.VERCEL_GIT_COMMIT_SHA ?? null,
    historyPath: snapshotRoot,
    categories,
  };

  await writeFile(
    path.join(snapshotRoot, "run-manifest.json"),
    JSON.stringify(manifest, null, 2),
    "utf8",
  );
  await writeFile(
    path.join(pipelineHistoryRoot, "latest-run.json"),
    JSON.stringify(manifest, null, 2),
    "utf8",
  );

  const indexPath = path.join(pipelineHistoryRoot, "index.json");
  const existingIndex = existsSync(indexPath)
    ? JSON.parse(await readFile(indexPath, "utf8"))
    : [];
  const indexEntries = Array.isArray(existingIndex) ? existingIndex : [];
  indexEntries.push({
    runId,
    archivedAt: manifest.archivedAt,
    extractor: manifest.extractor,
    groups: manifest.groups,
    categories: manifest.categories.map((category) => ({
      category: category.category,
      metrics: category.metrics,
    })),
  });
  await writeFile(indexPath, JSON.stringify(indexEntries, null, 2), "utf8");
  await persistRunToSqlite(manifest);

  console.log(`[parsebench-history] archived run=${runId} path=${snapshotRoot}`);
}

async function ensureParseBenchRepo(parseBenchDir: string, sync: boolean): Promise<void> {
  if (!existsSync(parseBenchDir)) {
    await mkdir(path.dirname(parseBenchDir), { recursive: true });
    await runCommand({
      command: "git",
      argv: ["clone", "--depth", "1", PARSEBENCH_REPO, parseBenchDir],
      cwd: repoRoot(),
    });
    return;
  }

  if (sync && existsSync(path.join(parseBenchDir, ".git"))) {
    const status = await runCommandCapture({
      command: "git",
      argv: ["status", "--short"],
      cwd: parseBenchDir,
    });
    if (status.code === 0 && status.stdout.trim().length > 0) {
      console.warn(
        `[parsebench-sync] skipping git pull because ${parseBenchDir} has local patches`,
      );
      return;
    }

    await runCommand({
      command: "git",
      argv: ["pull", "--ff-only"],
      cwd: parseBenchDir,
    });
  }
}

async function patchFileOnce(filePath: string, marker: string, patcher: (source: string) => string): Promise<void> {
  const source = await readFile(filePath, "utf8");
  if (source.includes(marker)) {
    return;
  }
  await writeFile(filePath, patcher(source), "utf8");
}

async function replaceInFile(
  filePath: string,
  replacer: (source: string) => string,
): Promise<void> {
  const source = await readFile(filePath, "utf8");
  const next = replacer(source);
  if (next !== source) {
    await writeFile(filePath, next, "utf8");
  }
}

async function installDocSlurpProvider(args: {
  parseBenchDir: string;
  repoRoot: string;
  extractor: ParseBenchDocSlurpExtractor;
  pipelineName: string;
}): Promise<void> {
  const providerDir = path.join(
    args.parseBenchDir,
    "src",
    "parse_bench",
    "inference",
    "providers",
    "parse",
  );
  const providerPath = path.join(providerDir, "docslurp.py");
  await writeFile(providerPath, providerSource(), "utf8");

  const providersInitPath = path.join(providerDir, "__init__.py");
  await patchFileOnce(
    providersInitPath,
    '"docslurp"',
    (source) => source.replace(
      "_PROVIDER_MODULES = [\n",
      '_PROVIDER_MODULES = [\n    "docslurp",\n',
    ),
  );

  const layoutProvidersInitPath = path.join(
    args.parseBenchDir,
    "src",
    "parse_bench",
    "inference",
    "providers",
    "layoutdet",
    "__init__.py",
  );
  await patchFileOnce(layoutProvidersInitPath, "import importlib", () => layoutProviderSource());

  const layoutAdaptersPath = path.join(
    args.parseBenchDir,
    "src",
    "parse_bench",
    "evaluation",
    "layout_adapters",
    "adapters.py",
  );
  await patchFileOnce(layoutAdaptersPath, "HAVE_LLAMA_PARSE_LAYOUT_NORMALIZATION", (source) =>
    source.replace(
      `from parse_bench.inference.providers.parse.llamaparse_v2_normalization import (
    build_pages_from_cli2_raw_payload,
    build_pages_from_sdk_response_payload,
    layout_pages_to_legacy_pages_payload,
)
`,
      `try:
    from parse_bench.inference.providers.parse.llamaparse_v2_normalization import (
        build_pages_from_cli2_raw_payload,
        build_pages_from_sdk_response_payload,
        layout_pages_to_legacy_pages_payload,
    )
    HAVE_LLAMA_PARSE_LAYOUT_NORMALIZATION = True
except ImportError:
    HAVE_LLAMA_PARSE_LAYOUT_NORMALIZATION = False

    def _missing_llamaparse_dependency(*args: object, **kwargs: object) -> None:
        raise ImportError("llama-cloud is required for LlamaParse layout normalization support")

    build_pages_from_cli2_raw_payload = _missing_llamaparse_dependency
    build_pages_from_sdk_response_payload = _missing_llamaparse_dependency
    layout_pages_to_legacy_pages_payload = _missing_llamaparse_dependency
`,
      ),
  );
  await replaceInFile(layoutAdaptersPath, (source) => {
    const block = `
@register_layout_adapter("docslurp", priority=95)
class DocSlurpLayoutAdapter(LayoutAdapter):
    """Adapter for DocSlurp ParseBench runs backed by block/line/span page payloads (native-pdf parser payload shape)."""

    def to_layout_output(
        self,
        inference_result: InferenceResult,
        *,
        page_filter: int | None = None,
    ) -> LayoutOutput:
        raw_output = inference_result.raw_output
        if not isinstance(raw_output, dict):
            raise ValueError("DocSlurp adapter requires dict raw_output")

        raw_pages = raw_output.get("layout_pages")
        if not isinstance(raw_pages, list) or not raw_pages:
            raise ValueError("DocSlurp adapter requires raw_output.layout_pages")

        markdown = str(raw_output.get("markdown") or "")
        predictions: list[LayoutPrediction] = []
        image_width = int(raw_output.get("image_width") or raw_pages[0].get("width") or 1)
        image_height = int(raw_output.get("image_height") or raw_pages[0].get("height") or 1)

        for page_index, page in enumerate(raw_pages, start=1):
            if page_filter is not None and page_index != page_filter:
                continue
            if not isinstance(page, dict):
                continue
            for block_index, block in enumerate(page.get("blocks", [])):
                if not isinstance(block, dict):
                    continue
                bbox = block.get("bbox")
                if not isinstance(bbox, list) or len(bbox) != 4:
                    continue
                bbox_xyxy = [float(value) for value in bbox]
                y_top = bbox_xyxy[1] / max(float(image_height), 1.0)
                y_bottom = bbox_xyxy[3] / max(float(image_height), 1.0)
                width_ratio = (bbox_xyxy[2] - bbox_xyxy[0]) / max(float(image_width), 1.0)
                height_ratio = (bbox_xyxy[3] - bbox_xyxy[1]) / max(float(image_height), 1.0)
                block_type = block.get("type")

                if block_type == 1:
                    predictions.append(
                        LayoutPrediction(
                            bbox=bbox_xyxy,
                            score=0.8,
                            label="Picture",
                            page=page_index,
                            content=None,
                            provider_metadata={"order_index": block_index},
                        )
                    )
                    continue

                text_parts: list[str] = []
                max_font_size = 0.0
                for line in block.get("lines", []):
                    if not isinstance(line, dict):
                        continue
                    for span in line.get("spans", []):
                        if not isinstance(span, dict):
                            continue
                        text = str(span.get("text") or "").strip()
                        if text:
                            text_parts.append(text)
                        size = span.get("size")
                        if isinstance(size, (int, float)):
                            max_font_size = max(max_font_size, float(size))

                text = " ".join(part for part in text_parts if part).strip()
                if not text:
                    continue

                label = "Text"
                word_count = len(text.split())
                heading_like = bool(
                    re.match(r"^(abstract|appendix|references)\\b", text, re.IGNORECASE)
                    or re.match(r"^\\d+(?:\\.\\d+)*\\s+[A-Z]", text)
                    or re.match(r"^[A-Z][A-Za-z0-9&/()' -]{2,40}$", text)
                )
                looks_like_banner_header = (
                    y_top <= 0.06
                    and max_font_size <= 10.5
                    and width_ratio >= 0.45
                    and word_count >= 4
                )

                if (y_top <= 0.08 and word_count <= 8) or looks_like_banner_header:
                    label = "Page-header"
                elif y_bottom >= 0.96 and word_count <= 12 and max_font_size <= 10.5:
                    label = "Page-footer"
                elif (
                    word_count <= 8
                    and (
                        heading_like
                        or max_font_size >= 11.5
                        or (text.isupper() and word_count <= 10)
                    )
                    and height_ratio <= 0.08
                ) or (
                    max_font_size >= 15
                    and word_count <= 6
                    and height_ratio <= 0.1
                ):
                    label = "Section-header"

                predictions.append(
                    LayoutPrediction(
                        bbox=bbox_xyxy,
                        score=0.7,
                        label=label,
                        page=page_index,
                        content=LayoutTextContent(text=text),
                        provider_metadata={
                            "order_index": block_index,
                            "font_size": str(round(max_font_size, 2)),
                        },
                    )
                )

        return LayoutOutput(
            example_id=inference_result.request.example_id,
            pipeline_name=inference_result.pipeline_name,
            model=LayoutDetectionModel.UNSTRUCTURED_LAYOUT,
            image_width=max(image_width, 1),
            image_height=max(image_height, 1),
            predictions=predictions,
            markdown=markdown,
        )


@register_layout_adapter("chunkr", priority=90)
`;

    if (source.includes('@register_layout_adapter("docslurp", priority=95)')) {
      return source.replace(
        /@register_layout_adapter\("docslurp", priority=95\)[\s\S]*?@register_layout_adapter\("chunkr", priority=90\)/,
        block.trimEnd(),
      );
    }

    return source.replace(
      '@register_layout_adapter("chunkr", priority=90)\n',
      `${block}\n`,
    );
  });

  const llmNormalizationInitPath = path.join(
    args.parseBenchDir,
    "src",
    "parse_bench",
    "evaluation",
    "metrics",
    "parse",
    "llm_normalization",
    "__init__.py",
  );
  await patchFileOnce(llmNormalizationInitPath, "JUDGE_NORMALIZER_IMPORT_ERROR", (source) =>
    source.replace(
      `from parse_bench.evaluation.metrics.parse.llm_normalization.strategy_judge import (
    JudgeNormalizer,
)
`,
      `JUDGE_NORMALIZER_IMPORT_ERROR: ImportError | None = None

try:
    from parse_bench.evaluation.metrics.parse.llm_normalization.strategy_judge import (
        JudgeNormalizer,
    )
except ImportError as exc:
    JUDGE_NORMALIZER_IMPORT_ERROR = exc
    JudgeNormalizer = None  # type: ignore[assignment]
`,
    ).replace(
      `    if mode == NormalizationMode.JUDGE:
        return JudgeNormalizer()
`,
      `    if mode == NormalizationMode.JUDGE:
        if JudgeNormalizer is None:
            raise ImportError(
                "Judge-mode LLM normalization requires optional ParseBench dependencies"
            ) from JUDGE_NORMALIZER_IMPORT_ERROR
        return JudgeNormalizer()
`,
    ),
  );

  const qaLlmServicePath = path.join(
    args.parseBenchDir,
    "src",
    "parse_bench",
    "evaluation",
    "qa",
    "llm_service.py",
  );
  await patchFileOnce(qaLlmServicePath, "GOOGLE_GENAI_IMPORT_ERROR", (source) =>
    source.replace(
      `from google import genai
from google.genai import types
`,
      `GOOGLE_GENAI_IMPORT_ERROR: ImportError | None = None

try:
    from google import genai
    from google.genai import types
except ImportError as exc:
    GOOGLE_GENAI_IMPORT_ERROR = exc
    genai = None  # type: ignore[assignment]
    types = None  # type: ignore[assignment]
`,
    ).replace(
      `        elif provider == "google":
            if api_key is None:
`,
      `        elif provider == "google":
            if genai is None or types is None:
                raise ImportError(
                    "google-genai package is required for Google provider. Install it with: pip install google-genai"
                ) from GOOGLE_GENAI_IMPORT_ERROR
            if api_key is None:
`,
    ),
  );

  const parsePipelinesPath = path.join(
    args.parseBenchDir,
    "src",
    "parse_bench",
    "inference",
    "pipelines",
    "parse.py",
  );
  const marker = `pipeline_name="${args.pipelineName}"`;
  await patchFileOnce(parsePipelinesPath, marker, (source) => {
    const injection = `
    # =========================================================================
    # DocSlurp local pipelines
    # =========================================================================

    register_fn(
        PipelineSpec(
            pipeline_name="${args.pipelineName}",
            provider_name="docslurp",
            product_type=ProductType.PARSE,
            config={
                "extractor": "${args.extractor}",
                "repo_root": "${args.repoRoot.replaceAll("\\", "\\\\")}",
                "worker_dir": "${path.join(args.repoRoot, "worker").replaceAll("\\", "\\\\")}",
            },
        )
    )

`;
    return source.replace(
      '    # =========================================================================\n    # LlamaParse Production Pipelines (V2 SDK)\n',
      `${injection}    # =========================================================================\n    # LlamaParse Production Pipelines (V2 SDK)\n`,
    );
  });
}

function layoutProviderSource(): string {
  return `"""Layout detection providers for inference endpoints."""

import importlib
import logging

logger = logging.getLogger(__name__)

_PROVIDER_MODULES = [
    "chandra",
    "docling",
    "dots_ocr",
    "layout_v3",
    "paddle",
    "qwen3vl",
    "surya",
    "yolo",
]

for _mod in _PROVIDER_MODULES:
    try:
        importlib.import_module(f"parse_bench.inference.providers.layoutdet.{_mod}")
    except ImportError:
        logger.debug("Skipping layout detection provider %s (missing dependency)", _mod)

__all__ = _PROVIDER_MODULES
`;
}

function providerSource(): string {
  return `"""DocSlurp provider shim for local ParseBench runs."""

import json
import os
import subprocess
import tempfile
from datetime import datetime
from pathlib import Path
from typing import Any

from parse_bench.inference.providers.base import Provider, ProviderPermanentError
from parse_bench.inference.providers.registry import register_provider
from parse_bench.schemas.parse_output import PageIR, ParseOutput
from parse_bench.schemas.pipeline import PipelineSpec
from parse_bench.schemas.pipeline_io import InferenceRequest, InferenceResult, RawInferenceResult
from parse_bench.schemas.product import ProductType


@register_provider("docslurp")
class DocSlurpProvider(Provider):
    """Runs DocSlurp's local worker extractors and returns ParseBench parse output."""

    def run_inference(self, pipeline: PipelineSpec, request: InferenceRequest) -> RawInferenceResult:
        if request.product_type != ProductType.PARSE:
            raise ProviderPermanentError(f"DocSlurpProvider only supports PARSE, got {request.product_type}")

        source_path = Path(request.source_file_path)
        if not source_path.exists():
            raise ProviderPermanentError(f"Source file not found: {source_path}")

        repo_root = Path(self.base_config.get("repo_root") or os.environ.get("DOCSLURP_REPO_ROOT") or ".").resolve()
        worker_dir = Path(self.base_config.get("worker_dir") or repo_root / "worker").resolve()
        extractor = str(self.base_config.get("extractor") or "hybrid")
        started_at = datetime.now()

        with tempfile.TemporaryDirectory(prefix="docslurp-parsebench-") as tmp_dir:
            output_path = Path(tmp_dir) / "out.md"
            meta_path = Path(f"{output_path}.meta.json")
            command = [
                "pnpm",
                "--dir",
                str(worker_dir),
                "exec",
                "tsx",
                "src/benchmarks/parsebench-docslurp-extract-cli.ts",
                "--input",
                str(source_path),
                "--output",
                str(output_path),
                "--extractor",
                extractor,
            ]
            proc = subprocess.run(
                command,
                cwd=str(repo_root),
                env=os.environ.copy(),
                text=True,
                capture_output=True,
                check=False,
            )
            if proc.returncode != 0:
                raise ProviderPermanentError(
                    f"DocSlurp extractor failed with exit code {proc.returncode}: {proc.stderr or proc.stdout}"
                )

            markdown = output_path.read_text(encoding="utf-8")
            meta: dict[str, Any] = {}
            if meta_path.exists():
                try:
                    meta = json.loads(meta_path.read_text(encoding="utf-8"))
                except Exception:
                    meta = {}

        completed_at = datetime.now()
        latency_ms = int((completed_at - started_at).total_seconds() * 1000)
        raw_output: dict[str, Any] = {
            "markdown": markdown,
            "extractor": extractor,
            "command": command,
            "stdout": proc.stdout,
            "stderr": proc.stderr,
            "layout_pages": meta.get("layoutPages") or [],
            "image_width": meta.get("imageWidth") or 1,
            "image_height": meta.get("imageHeight") or 1,
            "docslurp_meta": meta,
        }
        try:
            raw_output["docslurp_stats"] = json.loads(proc.stdout.strip().splitlines()[-1])
        except Exception:
            pass

        return RawInferenceResult(
            request=request,
            pipeline=pipeline,
            pipeline_name=pipeline.pipeline_name,
            product_type=request.product_type,
            raw_output=raw_output,
            started_at=started_at,
            completed_at=completed_at,
            latency_in_ms=latency_ms,
        )

    def normalize(self, raw_result: RawInferenceResult) -> InferenceResult:
        markdown = str(raw_result.raw_output.get("markdown") or "")
        output = ParseOutput(
            task_type="parse",
            example_id=raw_result.request.example_id,
            pipeline_name=raw_result.pipeline_name,
            pages=[PageIR(page_index=0, markdown=markdown)],
            markdown=markdown,
        )

        return InferenceResult(
            request=raw_result.request,
            pipeline_name=raw_result.pipeline_name,
            product_type=raw_result.product_type,
            raw_output=raw_result.raw_output,
            output=output,
            started_at=raw_result.started_at,
            completed_at=raw_result.completed_at,
            latency_in_ms=raw_result.latency_in_ms,
        )
`;
}

async function main(): Promise<void> {
  const root = repoRoot();
  const extractor = parseExtractor(readArg("--extractor") ?? "hybrid");
  const pipelineName = readArg("--pipeline-name") ?? `docslurp_${extractor.replaceAll("-", "_")}`;
  const parseBenchDir = path.resolve(
    readArg("--parsebench-dir") ?? path.join(root, ".benchmarks", "ParseBench"),
  );
  const outputDir = path.resolve(readArg("--output-dir") ?? path.join(root, ".benchmarks", "parsebench-output"));
  const groups = splitCsv(readArg("--groups"));
  const maxConcurrent = readArg("--max-concurrent") ?? "1";
  const shouldSync = !hasFlag("--no-sync");
  const shouldInstall = !hasFlag("--skip-install");
  const shouldInstallRunners = hasFlag("--with-runners");
  const shouldForce = hasFlag("--force") || (!hasFlag("--allow-cache") && !hasFlag("--skip-inference"));

  await ensureParseBenchRepo(parseBenchDir, shouldSync);
  await installDocSlurpProvider({ parseBenchDir, repoRoot: root, extractor, pipelineName });

  if (shouldInstall) {
    await runCommand({
      command: "uv",
      argv: shouldInstallRunners ? ["sync", "--extra", "runners"] : ["sync"],
      cwd: parseBenchDir,
      env: sanitizeUvEnv(),
    });
  }

  if (hasFlag("--setup-only")) {
    console.log(`ParseBench is ready at ${parseBenchDir}`);
    console.log(`Registered pipeline: ${pipelineName}`);
    return;
  }

  const commonArgs = [
    "run",
    "parse-bench",
    "run",
    pipelineName,
    "--output_dir",
    outputDir,
    "--max_concurrent",
    maxConcurrent,
  ];

  if (hasFlag("--test")) commonArgs.push("--test");
  if (shouldForce) commonArgs.push("--force");
  if (hasFlag("--skip-inference")) commonArgs.push("--skip_inference");
  if (hasFlag("--no-open-report")) commonArgs.push("--open_report", "False");

  const runGroups = groups.length ? groups : [undefined];
  for (const group of runGroups) {
    const argv = [...commonArgs];
    if (group) argv.push("--group", group);
    await runCommand({
      command: "uv",
      argv,
      cwd: parseBenchDir,
      env: {
        ...sanitizeUvEnv(),
        DOCSLURP_REPO_ROOT: root,
        LLAMACLOUD_BENCH_LLM_NORMALIZATION: process.env.LLAMACLOUD_BENCH_LLM_NORMALIZATION ?? "off",
      },
    });
  }

  await archiveRun({
    root,
    outputDir,
    pipelineName,
    extractor,
    groups,
    parseBenchDir,
  });
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
