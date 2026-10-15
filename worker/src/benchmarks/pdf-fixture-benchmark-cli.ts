import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

import { resolveFixturePath } from "./fixture-paths.js";
import { homedir } from "node:os";
import { spawn } from "node:child_process";

import { CommandRunner } from "../tools/runner.js";
import { buildExtractionContract } from "../lib/extraction-contract.js";
import {
  extractMarkdown,
  type ExtractMetadata,
} from "./parsebench-docslurp-extract-cli.js";
import type { ParseBenchDocSlurpExtractor } from "./parsebench-extractors.js";

const DOCSLURP_EVALS_DB_PATH = path.join(homedir(), ".docslurp.evals.sqlite");
const SQLITE_MANIFEST_ENV = "DOCSLURP_FIXTURE_BENCH_MANIFEST";

type FixtureDefinition = {
  id: string;
  path: string;
  tags: string[];
  notes?: string;
};

type FixtureManifest = {
  fixtures: FixtureDefinition[];
};

type FixtureBenchmarkResult = {
  fixtureId: string;
  relativePath: string;
  tags: string[];
  notes: string | null;
  selectedExtractor: string;
  latencyMs: number;
  charCount: number;
  plausibilityScore: number;
  markdownTableCount: number;
  htmlTableCount: number;
  pageCount: number;
  headerCount: number;
  linkCount: number;
  tableCount: number;
  hasLaTeX: boolean;
  hasCode: boolean;
  hasToC: boolean;
  hasQRCodes: boolean;
};

type TagSummary = {
  tag: string;
  fixtureCount: number;
  avgLatencyMs: number;
  avgCharCount: number;
  avgPlausibilityScore: number;
  avgHeaderCount: number;
  avgLinkCount: number;
  avgTableCount: number;
  latexFixtures: number;
  codeFixtures: number;
};

type FixtureBenchmarkManifest = {
  runId: string;
  archivedAt: string;
  benchmarkName: string;
  extractor: ParseBenchDocSlurpExtractor;
  fixtureIds: string[];
  tagFilters: string[];
  manifestPath: string;
  outputPath: string;
  gitCommit: string | null;
  results: FixtureBenchmarkResult[];
  tagSummaries: TagSummary[];
};

function readArg(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

function splitCsv(value: string | undefined): string[] {
  return value?.split(",").map((part) => part.trim()).filter(Boolean) ?? [];
}

function repoRoot(): string {
  return path.basename(process.cwd()) === "worker"
    ? path.resolve(process.cwd(), "..")
    : process.cwd();
}

function formatTimestampForPath(date: Date): string {
  return date.toISOString().slice(0, 19).replaceAll(":", "-");
}

function formatTimestampForDisplay(date: Date): string {
  return date.toISOString();
}

function parseExtractor(value: string | undefined): ParseBenchDocSlurpExtractor {
  switch (value ?? "hybrid") {
    case "hybrid":
    case "docling":
    case "kreuzberg":
    case "native-pdf-text":
    case "native-pdf-markdown":
    case "pdftotext":
    case "unpdf":
      return (value ?? "hybrid") as ParseBenchDocSlurpExtractor;
    default:
      throw new Error(`Unsupported extractor "${value}"`);
  }
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

function buildTagSummaries(results: FixtureBenchmarkResult[]): TagSummary[] {
  const buckets = new Map<string, FixtureBenchmarkResult[]>();
  for (const result of results) {
    for (const tag of result.tags) {
      const bucket = buckets.get(tag) ?? [];
      bucket.push(result);
      buckets.set(tag, bucket);
    }
  }

  return [...buckets.entries()]
    .map(([tag, bucket]) => {
      const divisor = bucket.length || 1;
      return {
        tag,
        fixtureCount: bucket.length,
        avgLatencyMs: bucket.reduce((sum, item) => sum + item.latencyMs, 0) / divisor,
        avgCharCount: bucket.reduce((sum, item) => sum + item.charCount, 0) / divisor,
        avgPlausibilityScore:
          bucket.reduce((sum, item) => sum + item.plausibilityScore, 0) /
          divisor,
        avgHeaderCount: bucket.reduce((sum, item) => sum + item.headerCount, 0) / divisor,
        avgLinkCount: bucket.reduce((sum, item) => sum + item.linkCount, 0) / divisor,
        avgTableCount: bucket.reduce((sum, item) => sum + item.tableCount, 0) / divisor,
        latexFixtures: bucket.filter((item) => item.hasLaTeX).length,
        codeFixtures: bucket.filter((item) => item.hasCode).length,
      };
    })
    .sort((left, right) => left.tag.localeCompare(right.tag));
}

async function persistRunToSqlite(manifest: FixtureBenchmarkManifest): Promise<void> {
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
        CREATE TABLE IF NOT EXISTS fixture_benchmark_runs (
            run_id TEXT PRIMARY KEY,
            archived_at TEXT NOT NULL,
            benchmark_name TEXT NOT NULL,
            extractor TEXT NOT NULL,
            fixture_ids_json TEXT NOT NULL,
            tag_filters_json TEXT NOT NULL,
            manifest_path TEXT NOT NULL,
            output_path TEXT NOT NULL,
            git_commit TEXT,
            manifest_json TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS fixture_benchmark_results (
            run_id TEXT NOT NULL,
            fixture_id TEXT NOT NULL,
            relative_path TEXT NOT NULL,
            tags_json TEXT NOT NULL,
            selected_extractor TEXT NOT NULL,
            latency_ms REAL NOT NULL,
            char_count INTEGER NOT NULL,
            plausibility_score REAL NOT NULL,
            markdown_table_count INTEGER NOT NULL,
            html_table_count INTEGER NOT NULL,
            page_count INTEGER NOT NULL,
            header_count INTEGER NOT NULL,
            link_count INTEGER NOT NULL,
            table_count INTEGER NOT NULL,
            has_latex INTEGER NOT NULL,
            has_code INTEGER NOT NULL,
            has_toc INTEGER NOT NULL,
            has_qr_codes INTEGER NOT NULL,
            PRIMARY KEY (run_id, fixture_id),
            FOREIGN KEY (run_id) REFERENCES fixture_benchmark_runs(run_id) ON DELETE CASCADE
        )
    """)
    conn.execute("DELETE FROM fixture_benchmark_results WHERE run_id = ?", (manifest["runId"],))
    conn.execute(
        """
        INSERT INTO fixture_benchmark_runs (
            run_id,
            archived_at,
            benchmark_name,
            extractor,
            fixture_ids_json,
            tag_filters_json,
            manifest_path,
            output_path,
            git_commit,
            manifest_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id) DO UPDATE SET
            archived_at=excluded.archived_at,
            benchmark_name=excluded.benchmark_name,
            extractor=excluded.extractor,
            fixture_ids_json=excluded.fixture_ids_json,
            tag_filters_json=excluded.tag_filters_json,
            manifest_path=excluded.manifest_path,
            output_path=excluded.output_path,
            git_commit=excluded.git_commit,
            manifest_json=excluded.manifest_json
        """,
        (
            manifest["runId"],
            manifest["archivedAt"],
            manifest["benchmarkName"],
            manifest["extractor"],
            json.dumps(manifest["fixtureIds"]),
            json.dumps(manifest["tagFilters"]),
            manifest["manifestPath"],
            manifest["outputPath"],
            manifest["gitCommit"],
            json.dumps(manifest),
        ),
    )
    rows = []
    for result in manifest["results"]:
        rows.append(
            (
                manifest["runId"],
                result["fixtureId"],
                result["relativePath"],
                json.dumps(result["tags"]),
                result["selectedExtractor"],
                float(result["latencyMs"]),
                int(result["charCount"]),
                float(result["plausibilityScore"]),
                int(result["markdownTableCount"]),
                int(result["htmlTableCount"]),
                int(result["pageCount"]),
                int(result["headerCount"]),
                int(result["linkCount"]),
                int(result["tableCount"]),
                1 if result["hasLaTeX"] else 0,
                1 if result["hasCode"] else 0,
                1 if result["hasToC"] else 0,
                1 if result["hasQRCodes"] else 0,
            )
        )
    conn.executemany(
        """
        INSERT INTO fixture_benchmark_results (
            run_id,
            fixture_id,
            relative_path,
            tags_json,
            selected_extractor,
            latency_ms,
            char_count,
            plausibility_score,
            markdown_table_count,
            html_table_count,
            page_count,
            header_count,
            link_count,
            table_count,
            has_latex,
            has_code,
            has_toc,
            has_qr_codes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    throw new Error(`python3 exited with ${result.code}: ${result.stderr || result.stdout}`);
  }
  console.log(
    `[fixture-benchmark] sqlite-recorded run=${manifest.runId} db=${result.stdout.trim() || DOCSLURP_EVALS_DB_PATH}`,
  );
}

async function main(): Promise<void> {
  const root = repoRoot();
  const extractor = parseExtractor(readArg("--extractor"));
  const manifestPath = path.resolve(
    root,
    readArg("--manifest") ?? "worker/testdata/pdf-fixtures/edge-fixtures.json",
  );
  const fixtureIds = splitCsv(readArg("--fixtures"));
  const tagFilters = splitCsv(readArg("--tags"));
  const archiveRoot = path.resolve(
    root,
    readArg("--archive-dir") ?? ".benchmarks/pdf-fixture-history/docslurp_hybrid",
  );

  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as FixtureManifest;
  const fixtures = manifest.fixtures.filter((fixture) => {
    if (fixtureIds.length > 0 && !fixtureIds.includes(fixture.id)) {
      return false;
    }
    if (tagFilters.length > 0 && !tagFilters.some((tag) => fixture.tags.includes(tag))) {
      return false;
    }
    return true;
  });

  if (fixtures.length === 0) {
    throw new Error("No fixtures matched the requested filters");
  }

  const runner = new CommandRunner();
  const results: FixtureBenchmarkResult[] = [];
  try {
    for (const fixture of fixtures) {
      const inputPath = resolveFixturePath(path.dirname(manifestPath), fixture.path, root);
      if (!inputPath) {
        console.warn(
          `[fixture-benchmark] skipping ${fixture.id}: ${fixture.path} is not present; run \`pnpm fixtures:fetch\` for third-party fixtures`,
        );
        continue;
      }
      const outputPath = path.join(
        root,
        ".benchmarks",
        "pdf-fixture-output",
        `${fixture.id}.md`,
      );
      await mkdir(path.dirname(outputPath), { recursive: true });
      const result = await extractMarkdown({
        inputPath,
        outputPath,
        extractor,
        runner,
        documentClass: fixture.tags[0] ?? "unclassified",
        tags: fixture.tags,
      });
      const metadata: ExtractMetadata = result.metadata;
      const pageCount = Math.max(metadata.pageCount, 1);
      const contract = buildExtractionContract({
        documentId: fixture.id,
        markdown: result.markdown,
        extractor: metadata.selectedExtractor,
        strategy: "fixture-benchmark",
        extractionTimeMs: metadata.latencyMs,
        pageCount,
      });

      results.push({
        fixtureId: fixture.id,
        relativePath: fixture.path,
        tags: fixture.tags,
        notes: fixture.notes ?? null,
        selectedExtractor: metadata.selectedExtractor,
        latencyMs: metadata.latencyMs,
        charCount: metadata.charCount,
        plausibilityScore: metadata.plausibilityScore,
        markdownTableCount: metadata.markdownTableCount,
        htmlTableCount: metadata.htmlTableCount,
        pageCount,
        headerCount: contract.headers.length,
        linkCount: contract.links.length,
        tableCount: contract.tables.length,
        hasLaTeX: contract.hasLaTeX,
        hasCode: contract.hasCode,
        hasToC: contract.hasToC,
        hasQRCodes: contract.hasQRCodes,
      });
    }
  } finally {
    await runner.close();
  }

  if (results.length === 0) {
    throw new Error("No selected fixtures are present; run `pnpm fixtures:fetch` for the third-party set");
  }
  const tagSummaries = buildTagSummaries(results);
  const archivedAt = new Date();
  const runId = formatTimestampForPath(archivedAt);
  const outputPath = path.join(archiveRoot, runId);
  await mkdir(outputPath, { recursive: true });

  const report = {
    extractor,
    fixtureCount: results.length,
    fixtures: results,
    tagSummaries,
  };
  await writeFile(
    path.join(outputPath, "report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );

  const manifestRecord: FixtureBenchmarkManifest = {
    runId,
    archivedAt: formatTimestampForDisplay(archivedAt),
    benchmarkName: "pdf-fixture-benchmark",
    extractor,
    fixtureIds: fixtures.map((fixture) => fixture.id),
    tagFilters,
    manifestPath,
    outputPath,
    gitCommit: process.env.GIT_COMMIT_SHA ?? process.env.VERCEL_GIT_COMMIT_SHA ?? null,
    results,
    tagSummaries,
  };

  await writeFile(
    path.join(outputPath, "run-manifest.json"),
    `${JSON.stringify(manifestRecord, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    path.join(archiveRoot, "latest-run.json"),
    `${JSON.stringify(manifestRecord, null, 2)}\n`,
    "utf8",
  );

  const indexPath = path.join(archiveRoot, "index.json");
  const existingIndex = existsSync(indexPath)
    ? JSON.parse(await readFile(indexPath, "utf8"))
    : [];
  const indexEntries = Array.isArray(existingIndex) ? existingIndex : [];
  indexEntries.push({
    runId,
    archivedAt: manifestRecord.archivedAt,
    extractor,
    fixtureCount: results.length,
    tagSummaries,
  });
  await writeFile(indexPath, `${JSON.stringify(indexEntries, null, 2)}\n`, "utf8");
  await persistRunToSqlite(manifestRecord);

  console.log(
    JSON.stringify({
      runId,
      extractor,
      fixtureCount: results.length,
      archivePath: outputPath,
      tags: tagSummaries.map((summary) => ({
        tag: summary.tag,
        fixtureCount: summary.fixtureCount,
        avgPlausibilityScore: summary.avgPlausibilityScore,
      })),
    }, null, 2),
  );
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
