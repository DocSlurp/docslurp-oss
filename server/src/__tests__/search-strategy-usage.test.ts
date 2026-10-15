import { beforeEach, describe, expect, it, vi } from "vitest";

import type { UsageInput, UsageRecorder } from "../lib/ai-usage.js";

const generateOpenRouterText = vi.fn();
const sqlMock = Object.assign(vi.fn(), {
  array: vi.fn((value: unknown) => value),
  begin: vi.fn(),
});

vi.mock("../db.js", () => ({ sql: sqlMock }));
vi.mock("../lib/ai.js", () => ({
  SEARCH_OPENROUTER_MODEL: "openrouter-test",
  generateOpenRouterText,
}));

const { hydeExpand } = await import("../search/hyde.js");
const { stepbackPrompt } = await import("../search/stepback.js");
const { rewriteQuery } = await import("../search/query-rewrite.js");
const { deriveSelfQueryFilters } = await import("../search/self-query.js");
const { compressChunks } = await import("../search/contextual-compression.js");
const { createSearchSessionJournal } = await import("../search/session.js");

function fakeRecorder(): UsageRecorder & { inputs: UsageInput[] } {
  const inputs: UsageInput[] = [];
  return { inputs, record: (input) => void inputs.push(input) };
}

function reply(text: string, inputTokens: number, outputTokens: number) {
  return { text, usage: { inputTokens, outputTokens } };
}

describe("search strategy usage", () => {
  beforeEach(() => {
    generateOpenRouterText.mockReset();
    sqlMock.mockReset();
    sqlMock.begin.mockReset();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  it("each strategy reports its actual usage to the recorder it is given", async () => {
    const recorder = fakeRecorder();
    generateOpenRouterText
      .mockResolvedValueOnce(reply("hypothetical passage", 10, 5))
      .mockResolvedValueOnce(reply("general query", 8, 2))
      .mockResolvedValueOnce(reply("clearer query", 7, 3));

    await hydeExpand("q", "key", recorder, "standard");
    await stepbackPrompt("q", "key", recorder, "standard");
    await rewriteQuery("q", "key", recorder, "standard");

    expect(recorder.inputs).toEqual([
      expect.objectContaining({ metric: "hyde", inputTokens: 10, outputTokens: 5 }),
      expect.objectContaining({ metric: "stepback", inputTokens: 8, outputTokens: 2 }),
      expect.objectContaining({ metric: "query-rewrite", inputTokens: 7, outputTokens: 3 }),
    ]);
  });

  it("self-query keeps its usage when the model returns unparseable JSON", async () => {
    const recorder = fakeRecorder();
    generateOpenRouterText.mockResolvedValueOnce(reply("not json", 11, 4));

    const plan = await deriveSelfQueryFilters({
      query: "what changed on page 3",
      openRouterApiKey: "key",
      privacyMode: "standard",
      usage: recorder,
    });

    expect(plan.filters.pageRange).toEqual({ from: 3, to: 3 });
    expect(recorder.inputs).toEqual([
      expect.objectContaining({ metric: "self-query", inputTokens: 11, outputTokens: 4 }),
    ]);
  });

  it("compression records one event per chunk call, matching its log lines", async () => {
    const recorder = fakeRecorder();
    generateOpenRouterText
      .mockResolvedValueOnce(reply("x", 5, 1))
      .mockResolvedValueOnce(reply("y", 6, 2));

    await compressChunks(
      "q",
      [
        { id: "a", text: "alpha", score: 1 },
        { id: "b", text: "beta", score: 0.5 },
      ],
      "key",
      recorder,
      "standard",
    );

    expect(recorder.inputs.map((input) => [input.metric, input.inputTokens])).toEqual([
      ["contextual-compression", 5],
      ["contextual-compression", 6],
    ]);
  });

  it("strategy usage recorded on a Search Session persists with session, workspace and org scope", async () => {
    const log = vi.mocked(console.log);
    const journal = createSearchSessionJournal({
      rootSessionId: "session-1",
      scope: { workspaceId: "ws-1", orgId: "org-1" },
    });
    generateOpenRouterText
      .mockResolvedValueOnce(reply("hypothetical passage", 10, 5))
      .mockResolvedValueOnce(reply("not json", 3, 1));

    await hydeExpand("q", "key", journal, "standard");
    await deriveSelfQueryFilters({ query: "q", openRouterApiKey: "key", privacyMode: "standard", usage: journal });
    // A child search's events were logged by the child; adopting must not re-log.
    journal.adoptUsage([
      {
        provider: "openrouter",
        model: "openrouter-test",
        metric: "stepback",
        amount: 2,
        unit: "token",
        costCents: 0,
        inputTokens: 1,
        outputTokens: 1,
        metadata: {},
      },
    ]);
    expect(
      log.mock.calls.filter(([line]) => String(line).startsWith("[ai-usage]")),
    ).toHaveLength(2);

    const usageRows: unknown[][] = [];
    sqlMock.begin.mockImplementation(async (run) =>
      run(
        Object.assign(
          vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
            const text = strings.join(" ");
            if (text.includes("insert into search_sessions")) return [{ id: values[0] }];
            if (text.includes("insert into usage_events")) usageRows.push(values);
            return [];
          }),
          { array: sqlMock.array },
        ),
      ),
    );

    await journal.persist({
      userId: "user-1",
      query: "q",
      results: [],
      chunks: [],
      metadata: { originalQuery: "q", options: {}, workspaceId: "ws-1" },
    });

    expect(usageRows.map((row) => row[5])).toEqual(["hyde", "self-query", "stepback"]);
    for (const row of usageRows) {
      expect(row[2]).toBeNull(); // run_id
      expect(JSON.parse(String(row[11]))).toMatchObject({
        sessionId: "session-1",
        workspaceId: "ws-1",
        orgId: "org-1",
      });
    }
  });
});
