export const routingEvalSchemaVersion = "document-routing-eval@v1" as const;

export type EvaluatedPageRoute =
  | "straightforward-text"
  | "table-heavy"
  | "form"
  | "chart-or-figure"
  | "image-heavy"
  | "handwriting-or-degraded"
  | "formula-heavy"
  | "code-heavy"
  | "chemical-notation-heavy";

export type EvaluatedExtractorHint =
  | "cheap-text"
  | "layout-aware"
  | "vision-rescue"
  | "syntax-preserving";

export type RoutingEvalManifest = {
  schemaVersion: typeof routingEvalSchemaVersion;
  description: string;
  gates: {
    minimumQualityScore: number;
    minimumFixturePassRate: number;
    maximumP95LatencyMs: number;
    maximumHostedAiCalls: number;
    maximumEstimatedCostUsd: number;
  };
  fixtures: RoutingEvalFixture[];
};

export type RoutingEvalFixture = {
  id: string;
  path: string;
  tags: string[];
  expected: {
    suggestedPlaybook?: string | null;
    visionPolicy?: "skip" | "selective" | "aggressive";
    pages: Array<{
      pageNumber: number;
      route: EvaluatedPageRoute;
      extractorHint: EvaluatedExtractorHint;
      ocrAuthorized: boolean;
    }>;
  };
};

export type RoutingEvalObservation = {
  fixtureId: string;
  latencyMs: number;
  suggestedPlaybook: string | null;
  visionPolicy: "skip" | "selective" | "aggressive";
  pages: Array<{
    pageNumber: number;
    route: EvaluatedPageRoute;
    extractorHint: EvaluatedExtractorHint;
    ocrAuthorized: boolean;
  }>;
};

export type RoutingEvalCheck = {
  metric: string;
  passed: boolean;
  expected: unknown;
  actual: unknown;
};

export type RoutingEvalFixtureResult = {
  fixtureId: string;
  tags: string[];
  passed: boolean;
  qualityScore: number;
  latencyMs: number;
  checks: RoutingEvalCheck[];
  observation: RoutingEvalObservation;
};

export type RoutingEvalReport = {
  schemaVersion: typeof routingEvalSchemaVersion;
  generatedAt: string;
  executor: "liteparse-local-structured";
  hostedAiCalls: 0;
  estimatedCostUsd: 0;
  fixtureCount: number;
  fixturePassRate: number;
  qualityScore: number;
  p95LatencyMs: number;
  passed: boolean;
  gateChecks: RoutingEvalCheck[];
  results: RoutingEvalFixtureResult[];
};

const routeValues = new Set<EvaluatedPageRoute>([
  "straightforward-text",
  "table-heavy",
  "form",
  "chart-or-figure",
  "image-heavy",
  "handwriting-or-degraded",
  "formula-heavy",
  "code-heavy",
  "chemical-notation-heavy",
]);

const extractorHintValues = new Set<EvaluatedExtractorHint>([
  "cheap-text",
  "layout-aware",
  "vision-rescue",
  "syntax-preserving",
]);

export function parseRoutingEvalManifest(value: unknown): RoutingEvalManifest {
  if (!value || typeof value !== "object") {
    throw new Error("routing eval manifest must be an object");
  }
  const candidate = value as Partial<RoutingEvalManifest>;
  if (
    candidate.schemaVersion !== routingEvalSchemaVersion ||
    typeof candidate.description !== "string" ||
    !candidate.gates ||
    !Array.isArray(candidate.fixtures) ||
    candidate.fixtures.length === 0
  ) {
    throw new Error("routing eval manifest is missing required v1 fields");
  }

  const gates = candidate.gates as Partial<RoutingEvalManifest["gates"]>;
  const gateValues = [
    gates.minimumQualityScore,
    gates.minimumFixturePassRate,
    gates.maximumP95LatencyMs,
    gates.maximumHostedAiCalls,
    gates.maximumEstimatedCostUsd,
  ];
  if (gateValues.some((gate) => typeof gate !== "number" || !Number.isFinite(gate))) {
    throw new Error("routing eval gates must be finite numbers");
  }
  if (
    gates.minimumQualityScore! < 0 ||
    gates.minimumQualityScore! > 1 ||
    gates.minimumFixturePassRate! < 0 ||
    gates.minimumFixturePassRate! > 1 ||
    gates.maximumP95LatencyMs! < 0 ||
    gates.maximumHostedAiCalls! < 0 ||
    gates.maximumEstimatedCostUsd! < 0
  ) {
    throw new Error("routing eval gates are outside their valid ranges");
  }

  const fixtureIds = new Set<string>();
  for (const fixture of candidate.fixtures) {
    if (
      !fixture ||
      typeof fixture.id !== "string" ||
      typeof fixture.path !== "string" ||
      fixture.path.startsWith("/") ||
      fixture.path.split(/[\\/]/).includes("..") ||
      !Array.isArray(fixture.tags) ||
      !fixture.expected ||
      !Array.isArray(fixture.expected.pages) ||
      fixture.expected.pages.length === 0
    ) {
      throw new Error("routing eval fixture is invalid");
    }
    if (fixtureIds.has(fixture.id)) {
      throw new Error(`routing eval fixture id is duplicated: ${fixture.id}`);
    }
    fixtureIds.add(fixture.id);

    const pageNumbers = new Set<number>();
    for (const page of fixture.expected.pages) {
      if (
        !Number.isInteger(page.pageNumber) ||
        page.pageNumber < 1 ||
        !routeValues.has(page.route) ||
        !extractorHintValues.has(page.extractorHint) ||
        typeof page.ocrAuthorized !== "boolean"
      ) {
        throw new Error(`routing eval fixture ${fixture.id} has an invalid page expectation`);
      }
      if (pageNumbers.has(page.pageNumber)) {
        throw new Error(`routing eval fixture ${fixture.id} repeats page ${page.pageNumber}`);
      }
      pageNumbers.add(page.pageNumber);
    }
  }

  return candidate as RoutingEvalManifest;
}

export function scoreRoutingEvalFixture(
  fixture: RoutingEvalFixture,
  observation: RoutingEvalObservation,
): RoutingEvalFixtureResult {
  const checks: RoutingEvalCheck[] = [];
  const addCheck = (metric: string, expected: unknown, actual: unknown) => {
    checks.push({ metric, expected, actual, passed: Object.is(expected, actual) });
  };

  addCheck("document.fixtureId", fixture.id, observation.fixtureId);

  if (fixture.expected.suggestedPlaybook !== undefined) {
    addCheck(
      "document.suggestedPlaybook",
      fixture.expected.suggestedPlaybook,
      observation.suggestedPlaybook,
    );
  }
  if (fixture.expected.visionPolicy !== undefined) {
    addCheck("document.visionPolicy", fixture.expected.visionPolicy, observation.visionPolicy);
  }

  for (const expectedPage of fixture.expected.pages) {
    const actualPage = observation.pages.find(
      (page) => page.pageNumber === expectedPage.pageNumber,
    );
    addCheck(
      `page.${expectedPage.pageNumber}.present`,
      true,
      Boolean(actualPage),
    );
    if (!actualPage) continue;
    addCheck(`page.${expectedPage.pageNumber}.route`, expectedPage.route, actualPage.route);
    addCheck(
      `page.${expectedPage.pageNumber}.extractorHint`,
      expectedPage.extractorHint,
      actualPage.extractorHint,
    );
    addCheck(
      `page.${expectedPage.pageNumber}.ocrAuthorized`,
      expectedPage.ocrAuthorized,
      actualPage.ocrAuthorized,
    );
  }

  addCheck("document.pageCount", fixture.expected.pages.length, observation.pages.length);
  const passedChecks = checks.filter((check) => check.passed).length;
  const qualityScore = passedChecks / Math.max(1, checks.length);
  return {
    fixtureId: fixture.id,
    tags: fixture.tags,
    passed: qualityScore === 1,
    qualityScore,
    latencyMs: observation.latencyMs,
    checks,
    observation,
  };
}

export function buildRoutingEvalReport(args: {
  manifest: RoutingEvalManifest;
  results: RoutingEvalFixtureResult[];
  generatedAt?: string;
}): RoutingEvalReport {
  const fixtureCount = args.results.length;
  const fixturePassRate =
    args.results.filter((result) => result.passed).length / Math.max(1, fixtureCount);
  const qualityScore =
    args.results.reduce((sum, result) => sum + result.qualityScore, 0) /
    Math.max(1, fixtureCount);
  const p95LatencyMs = percentile(
    args.results.map((result) => result.latencyMs),
    0.95,
  );
  const gateChecks: RoutingEvalCheck[] = [
    {
      metric: "qualityScore",
      expected: `>=${args.manifest.gates.minimumQualityScore}`,
      actual: qualityScore,
      passed: qualityScore >= args.manifest.gates.minimumQualityScore,
    },
    {
      metric: "fixturePassRate",
      expected: `>=${args.manifest.gates.minimumFixturePassRate}`,
      actual: fixturePassRate,
      passed: fixturePassRate >= args.manifest.gates.minimumFixturePassRate,
    },
    {
      metric: "p95LatencyMs",
      expected: `<=${args.manifest.gates.maximumP95LatencyMs}`,
      actual: p95LatencyMs,
      passed: p95LatencyMs <= args.manifest.gates.maximumP95LatencyMs,
    },
    {
      metric: "hostedAiCalls",
      expected: `<=${args.manifest.gates.maximumHostedAiCalls}`,
      actual: 0,
      passed: 0 <= args.manifest.gates.maximumHostedAiCalls,
    },
    {
      metric: "estimatedCostUsd",
      expected: `<=${args.manifest.gates.maximumEstimatedCostUsd}`,
      actual: 0,
      passed: 0 <= args.manifest.gates.maximumEstimatedCostUsd,
    },
  ];

  return {
    schemaVersion: routingEvalSchemaVersion,
    generatedAt: args.generatedAt ?? new Date().toISOString(),
    executor: "liteparse-local-structured",
    hostedAiCalls: 0,
    estimatedCostUsd: 0,
    fixtureCount,
    fixturePassRate,
    qualityScore,
    p95LatencyMs,
    passed: gateChecks.every((check) => check.passed),
    gateChecks,
    results: args.results,
  };
}

function percentile(values: number[], quantile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1);
  return sorted[index] ?? 0;
}
