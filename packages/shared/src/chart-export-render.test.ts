import { describe, expect, it } from "vitest";
import type { z } from "zod";

import { chartSpecSchema, diagramSpecSchema, VISUAL_SPEC_LIMITS, type ChartSpec, type DiagramSpec } from "./chart-export.js";
import {
  csvCell,
  mermaidEntityText,
  mermaidId,
  mermaidPlainText,
  pythonString,
  renderCsv,
  renderDescription,
  renderFencedBlock,
  renderMatplotlib,
  renderMermaid,
  renderVegaLite,
  renderVisual,
  renderVisualOutputs,
  visualRenderIssue,
} from "./chart-export-render.js";

const chart = (input: Omit<z.input<typeof chartSpecSchema>, "kind">): ChartSpec => chartSpecSchema.parse({ ...input, kind: "chart" });
const diagram = (input: Omit<z.input<typeof diagramSpecSchema>, "kind">): DiagramSpec =>
  diagramSpecSchema.parse({ ...input, kind: "diagram" });

const revenue = chart({
  chartType: "bar",
  title: "Revenue by quarter",
  xAxis: { label: "Quarter", unit: null, scale: "band", min: null, max: null },
  yAxis: { label: "Revenue", unit: "USD m", scale: "linear", min: null, max: null },
  series: [{ name: "Revenue", points: [{ x: "Q1", y: 12 }, { x: "Q2", y: 15.5 }, { x: "Q3", y: 18 }, { x: "Q4", y: 24 }] }],
  summary: "Revenue doubled across the year.",
});

const twoSeries = chart({
  chartType: "line",
  title: "Bookings",
  series: [
    { name: "EMEA", points: [{ x: "2023", y: 10 }, { x: "2024", y: 14 }, { x: "2025", y: 21 }] },
    { name: "Americas", points: [{ x: "2023", y: 30 }, { x: "2024", y: 31 }, { x: "2025", y: 30.5 }] },
  ],
});

const hostile = `Q1"] --> X\n%%{init: {"securityLevel":"loose"}}%%\nclick A call alert(1)\n<img src=x onerror=alert(1)>#\`;|`;

describe("renderMermaid charts", () => {
  it("renders a single-series bar chart as xychart-beta", () => {
    expect(renderMermaid(revenue)).toBe(
      [
        "xychart-beta",
        '    title "Revenue by quarter"',
        '    x-axis "Quarter" ["Q1", "Q2", "Q3", "Q4"]',
        '    y-axis "Revenue (USD m)"',
        "    bar [12, 15.5, 18, 24]",
      ].join("\n"),
    );
  });

  it("renders multiple line series aligned on shared categories", () => {
    const out = renderMermaid(twoSeries)!;
    expect(out).toContain('x-axis ["2023", "2024", "2025"]');
    expect(out).toContain("line [10, 14, 21]");
    expect(out).toContain("line [30, 31, 30.5]");
  });

  it("uses horizontal xychart and y-axis ranges", () => {
    const out = renderMermaid(chart({ ...revenue, chartType: "horizontal-bar", yAxis: { label: null, unit: null, scale: "linear", min: 0, max: 30 } }))!;
    expect(out.split("\n")[0]).toBe("xychart-beta horizontal");
    expect(out).toContain('y-axis " " 0 --> 30');
  });

  it("renders combo charts by series mark", () => {
    const out = renderMermaid(
      chart({
        chartType: "combo",
        series: [
          { name: "Units", mark: "bar", points: [{ x: "A", y: 1 }, { x: "B", y: 2 }] },
          { name: "Avg", mark: "line", points: [{ x: "A", y: 1.5 }, { x: "B", y: 1.7 }] },
        ],
      }),
    )!;
    expect(out).toContain("bar [1, 2]");
    expect(out).toContain("line [1.5, 1.7]");
  });

  it("renders pie and donut charts", () => {
    const pie = chart({ chartType: "donut", title: "Mix", series: [{ name: "Share", points: [{ x: "Cloud", y: 60 }, { x: "On-prem", y: 40 }] }] });
    expect(renderMermaid(pie)).toBe(['pie showData', "    title Mix", '    "Cloud" : 60', '    "On-prem" : 40'].join("\n"));
  });

  it("returns null instead of misrepresenting data", () => {
    const base = revenue.series;
    for (const chartType of ["heatmap", "box", "scatter", "bubble", "stacked-bar", "stacked-area", "radar", "waterfall", "other"] as const) {
      expect(renderMermaid(chart({ chartType, series: base })), chartType).toBeNull();
    }
    // gaps cannot be drawn
    expect(renderMermaid(chart({ chartType: "bar", series: [{ name: "a", points: [{ x: "A", y: null }] }] }))).toBeNull();
    // misaligned series would need invented values
    expect(
      renderMermaid(chart({ chartType: "line", series: [{ name: "a", points: [{ x: "A", y: 1 }] }, { name: "b", points: [{ x: "B", y: 2 }] }] })),
    ).toBeNull();
    // secondary axis
    expect(renderMermaid(chart({ chartType: "combo", series: [{ name: "a", axis: "y2", points: [{ x: "A", y: 1 }] }] }))).toBeNull();
    // negative pie slices and multi-series pies
    expect(renderMermaid(chart({ chartType: "pie", series: [{ name: "a", points: [{ x: "A", y: -1 }] }] }))).toBeNull();
    expect(renderMermaid(chart({ chartType: "pie", series: [...base, ...base] }))).toBeNull();
  });

  it("cannot inject directives, click callbacks, HTML or new statements through labels", () => {
    const out = renderMermaid(
      chart({
        chartType: "bar",
        title: hostile,
        xAxis: { label: hostile, unit: null, scale: "band", min: null, max: null },
        series: [{ name: hostile, points: [{ x: hostile, y: 1 }] }],
      }),
    )!;
    expect(out.split("\n")).toHaveLength(4);
    expect(out).not.toMatch(/%%|[<>#;`|]/);
    expect(out).not.toMatch(/\n\s*click/);
    // every quoted string is balanced: 3 quoted labels -> 6 quotes
    expect(out.match(/"/g)).toHaveLength(6);
  });
});

describe("renderMermaid diagrams", () => {
  const flow = diagram({
    diagramType: "flowchart",
    direction: "LR",
    nodes: [
      { id: "start", label: "Order received", shape: "stadium" },
      { id: "check", label: "In stock?", shape: "diamond" },
      { id: "ship", label: "Ship", shape: "box", group: "wh" },
      { id: "db", label: "Inventory", shape: "cylinder", group: "wh" },
    ],
    edges: [
      { from: "start", to: "check" },
      { from: "check", to: "ship", label: "yes", style: "thick" },
      { from: "ship", to: "db", style: "dashed", directed: false },
      { from: "check", to: "backorder", label: "no" },
    ],
    groups: [{ id: "wh", label: "Warehouse" }],
  });

  it("renders a flowchart with shapes, edge styles, subgraphs and implicit nodes", () => {
    expect(renderMermaid(flow)).toBe(
      [
        "flowchart LR",
        '    n_start(["Order received"])',
        '    n_check{"In stock?"}',
        '    n_backorder["backorder"]',
        '    subgraph g_wh["Warehouse"]',
        '        n_ship["Ship"]',
        '        n_db[("Inventory")]',
        "    end",
        "    n_start --> n_check",
        '    n_check ==>|"yes"| n_ship',
        "    n_ship -.- n_db",
        '    n_check -->|"no"| n_backorder',
      ].join("\n"),
    );
  });

  it("renders org charts top-down", () => {
    const out = renderMermaid(
      diagram({ diagramType: "org-chart", direction: "LR", nodes: [{ id: "ceo", label: "CEO" }, { id: "cfo", label: "CFO" }], edges: [{ from: "ceo", to: "cfo" }] }),
    )!;
    expect(out.split("\n")[0]).toBe("flowchart TB");
  });

  it("renders sequence, state, ER and mindmap diagrams", () => {
    const nodes = [
      { id: "client", label: "Client", shape: "actor" as const },
      { id: "api", label: "API" },
    ];
    const edges = [
      { from: "client", to: "api", label: "POST /orders" },
      { from: "api", to: "client", label: "201 Created", style: "dashed" as const },
    ];
    expect(renderMermaid(diagram({ diagramType: "sequence", nodes, edges }))).toBe(
      [
        "sequenceDiagram",
        "    actor p_client as Client",
        "    participant p_api as API",
        "    p_client->>p_api: POST /orders",
        "    p_api-->>p_client: 201 Created",
      ].join("\n"),
    );
    const state = renderMermaid(diagram({ diagramType: "state", nodes, edges }))!;
    expect(state).toContain('state "Client" as s_client');
    expect(state).toContain("s_client --> s_api : POST /orders");
    const er = renderMermaid(diagram({ diagramType: "er", nodes, edges }))!;
    expect(er).toContain('e_client }o--o{ e_api : "POST /orders"');
    expect(er).toContain('e_api }o..o{ e_client : "201 Created"');
    const mind = renderMermaid(
      diagram({
        diagramType: "mindmap",
        nodes: [{ id: "root", label: "Launch" }, { id: "a", label: "Pricing (tiers)" }, { id: "b", label: "Docs" }],
        edges: [{ from: "root", to: "a" }, { from: "root", to: "b" }],
      }),
    );
    expect(mind).toBe(["mindmap", "  m_root[Launch]", "    m_a[Pricing tiers]", "    m_b[Docs]"].join("\n"));
  });

  it("sanitizes ids and keeps them unique", () => {
    expect(mermaidId("a b-c")).toBe("n_a_b_c");
    expect(mermaidId("end", "")).toBe("_end");
    expect(mermaidId("<script>")).toBe("n__script_");
    const out = renderMermaid(
      diagram({ diagramType: "flowchart", nodes: [{ id: "a-b", label: "1" }, { id: "a b", label: "2" }, { id: "click", label: "3" }], edges: [] }),
    )!;
    expect(out).toContain('n_a_b["1"]');
    expect(out).toContain('n_a_b_2["2"]');
    expect(out).toContain('n_click["3"]');
    expect(out).not.toMatch(/^\s*click/m);
  });

  it("neutralizes hostile labels in every diagram type", () => {
    for (const diagramType of ["flowchart", "sequence", "state", "er", "mindmap", "org-chart"] as const) {
      const out = renderMermaid(
        diagram({
          diagramType,
          nodes: [{ id: "x\nclick", label: hostile, group: "g" }, { id: "y", label: hostile }],
          edges: [{ from: "x\nclick", to: "y", label: hostile }],
          groups: [{ id: "g", label: hostile }],
        }),
      )!;
      // Arrow syntax legitimately contains `>` and `|"label"|`; label text must not.
      const labelsOnly = out.replace(/ (?:-->|==>|-\.->|-\.-|---|===)(?:\|")?/g, " ").replace(/"\| /g, '" ').replace(/-?->>/g, "");
      expect(labelsOnly, diagramType).not.toMatch(/%%|[<>`|]/);
      expect(out, diagramType).not.toMatch(/^\s*(?:click|%%)/m);
      expect(out, diagramType).not.toContain("onerror=alert(1)>");
      for (const line of out.split("\n").slice(1)) {
        expect((line.match(/"/g) ?? []).length % 2, `${diagramType}: ${line}`).toBe(0);
      }
    }
  });

  it("encodes Mermaid metacharacters as entities and strips them in plain text", () => {
    expect(mermaidEntityText('a "b" [c] #1; 50%')).toBe("a #34;b#34; #91;c#93; #35;1#59; 50#37;");
    expect(mermaidEntityText("<b>&")).toBe("‹b›＆");
    expect(mermaidPlainText('say "hi" %%{init}%% [x]')).toBe("say 'hi' % init % x");
  });

  it("returns null for empty diagrams", () => {
    expect(renderMermaid(diagram({ diagramType: "flowchart", nodes: [], edges: [] }))).toBeNull();
  });
});

describe("renderVegaLite", () => {
  it("produces a v5 spec with inline data and folded series", () => {
    const spec = JSON.parse(renderVegaLite(twoSeries)!);
    expect(spec.$schema).toBe("https://vega.github.io/schema/vega-lite/v5.json");
    expect(spec.title).toBe("Bookings");
    expect(spec.data.values).toHaveLength(6);
    expect(spec.data.values[0]).toEqual({ series: "EMEA", x: "2023", y: 10 });
    expect(spec.mark).toEqual({ type: "line", point: true });
    expect(spec.encoding.color.field).toBe("series");
    expect(spec.encoding.x).toMatchObject({ field: "x", type: "ordinal" });
  });

  it("maps chart types to marks", () => {
    const series = revenue.series;
    const mark = (chartType: ChartSpec["chartType"]) => JSON.parse(renderVegaLite(chart({ ...revenue, chartType, series }))!);
    expect(mark("bar").mark).toBe("bar");
    expect(mark("bar").encoding.y.title).toBe("Revenue (USD m)");
    expect(mark("stacked-bar").encoding.y.stack).toBe("zero");
    expect(mark("horizontal-bar").encoding.y.field).toBe("x");
    expect(mark("pie").mark).toBe("arc");
    expect(mark("donut").mark).toEqual({ type: "arc", innerRadius: 50 });
    expect(mark("heatmap").mark).toBe("rect");
    expect(renderVegaLite(chart({ ...revenue, chartType: "box" }))).toBeNull();
    expect(renderVegaLite(chart({ ...revenue, chartType: "radar" }))).toBeNull();
  });

  it("uses quantitative x for scatter and size for bubbles, log scales and domains", () => {
    const spec = JSON.parse(
      renderVegaLite(
        chart({
          chartType: "bubble",
          xAxis: { label: "Spend", unit: null, scale: "linear", min: null, max: null },
          yAxis: { label: null, unit: null, scale: "log", min: 1, max: 1000 },
          series: [{ name: "s", points: [{ x: 1, y: 10, z: 3 }, { x: 2, y: 100, z: 5 }] }],
        }),
      )!,
    );
    expect(spec.encoding.x.type).toBe("quantitative");
    expect(spec.encoding.size.field).toBe("z");
    expect(spec.encoding.y.scale).toEqual({ type: "log", domain: [1, 1000] });
  });

  it("layers combo charts with an independent secondary axis", () => {
    const spec = JSON.parse(
      renderVegaLite(
        chart({
          chartType: "combo",
          y2Axis: { label: "Margin", unit: "%", scale: "linear", min: null, max: null },
          series: [
            { name: "Revenue", mark: "bar", points: [{ x: "Q1", y: 1 }] },
            { name: "Margin", mark: "line", axis: "y2", points: [{ x: "Q1", y: 30 }] },
          ],
        }),
      )!,
    );
    expect(spec.layer).toHaveLength(2);
    expect(spec.layer[1].encoding.y.title).toBe("Margin (%)");
    expect(spec.resolve).toEqual({ scale: { y: "independent" } });
  });

  it("keeps hostile labels as JSON data and returns null for diagrams", () => {
    const text = renderVegaLite(chart({ chartType: "bar", title: hostile, series: [{ name: hostile, points: [{ x: hostile, y: 1 }] }] }))!;
    const spec = JSON.parse(text);
    expect(spec.title).not.toContain("\n");
    expect(spec.data.values[0].x).toContain('Q1"]');
    expect(renderVegaLite(diagram({ diagramType: "flowchart", nodes: [{ id: "a", label: "A" }], edges: [] }))).toBeNull();
  });
});

describe("renderMatplotlib", () => {
  it("emits a self-contained snippet with data literals", () => {
    const code = renderMatplotlib(revenue)!;
    const imports = code.split("\n").filter((line) => /^\s*(?:import|from)\b/.test(line));
    expect(imports).toEqual(["import matplotlib.pyplot as plt"]);
    expect(code).toContain("categories = ['Q1', 'Q2', 'Q3', 'Q4']");
    expect(code).toContain("('Revenue', [12, 15.5, 18, 24]),");
    expect(code).toContain("ax.set_ylabel('Revenue (USD m)')");
    expect(code).toContain("ax.set_title('Revenue by quarter')");
    expect(code).toContain("plt.show()");
  });

  it("writes gaps as nan and covers the supported chart types", () => {
    const gap = renderMatplotlib(chart({ chartType: "line", series: [{ name: "a", points: [{ x: "A", y: null }, { x: "B", y: 2 }] }] }))!;
    expect(gap).toContain("('a', [nan, 2])");
    for (const chartType of ["bar", "grouped-bar", "stacked-bar", "horizontal-bar", "line", "area", "stacked-area", "scatter", "bubble", "pie", "donut", "heatmap", "waterfall", "histogram", "combo"] as const) {
      expect(renderMatplotlib(chart({ ...revenue, chartType })), chartType).toContain("plt.show()");
    }
    expect(renderMatplotlib(chart({ ...revenue, chartType: "box" }))).toBeNull();
    expect(renderMatplotlib(diagram({ diagramType: "flowchart", nodes: [{ id: "a", label: "A" }], edges: [] }))).toBeNull();
  });

  it("escapes labels as Python string literals that cannot break out", () => {
    expect(pythonString("it's \\ fine")).toBe("'it\\'s \\\\ fine'");
    expect(pythonString("a\nb\u2028é😀")).toBe("'a\\x0ab\\u2028\\xe9\\U0001f600'");
    const evil = "x'); import os; os.system('rm -rf /'); ('";
    const code = renderMatplotlib(chart({ chartType: "bar", title: evil, series: [{ name: evil, points: [{ x: evil, y: 1 }] }] }))!;
    // Every occurrence of the payload sits inside a literal: its quote is always escaped.
    expect(code).not.toMatch(/[^\\]'\); import os/);
    expect(code.split("\n").filter((line) => /^\s*import\b/.test(line))).toEqual(["import matplotlib.pyplot as plt"]);
    // `$` would trigger mathtext
    expect(renderMatplotlib(chart({ chartType: "bar", title: "$5M to $9M", series: revenue.series }))).toContain("'\\\\$5M to \\\\$9M'");
  });
});

describe("renderCsv", () => {
  it("writes wide RFC 4180 CSV with CRLF", () => {
    expect(renderCsv(twoSeries)).toBe("x,EMEA,Americas\r\n2023,10,30\r\n2024,14,31\r\n2025,21,30.5\r\n");
    expect(renderCsv(revenue)).toBe("Quarter,Revenue (USD m)\r\nQ1,12\r\nQ2,15.5\r\nQ3,18\r\nQ4,24\r\n");
  });

  it("switches to long format for z values and repeated x", () => {
    const csv = renderCsv(chart({ chartType: "bubble", series: [{ name: "s", points: [{ x: 1, y: 2, z: 3 }, { x: 1, y: 4, z: 5 }] }] }));
    expect(csv).toBe("series,x,y,z\r\ns,1,2,3\r\ns,1,4,5\r\n");
  });

  it("quotes and guards against formula injection", () => {
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
    expect(csvCell("=HYPERLINK(\"http://x\")")).toBe("\"'=HYPERLINK(\"\"http://x\"\")\"");
    for (const lead of ["=", "+", "-", "@", "\t", "\r"]) expect(csvCell(`${lead}cmd`).replace(/^"/, "")).toMatch(/^'/);
    expect(csvCell(-5)).toBe("-5");
    expect(csvCell(null)).toBe("");
    const csv = renderCsv(chart({ chartType: "bar", series: [{ name: "=1+1", points: [{ x: "@SUM(A1)", y: -3 }] }] }))!;
    expect(csv).toBe("x,'=1+1\r\n'@SUM(A1),-3\r\n");
  });

  it("exports diagrams as an edge list", () => {
    const csv = renderCsv(diagram({ diagramType: "flowchart", nodes: [{ id: "a", label: "Start" }, { id: "b", label: "Done, finally" }], edges: [{ from: "a", to: "b", label: "ok" }] }));
    expect(csv).toBe('from,to,label\r\nStart,"Done, finally",ok\r\n');
  });
});

describe("renderDescription", () => {
  it("describes charts deterministically with summary, axes and per-series stats", () => {
    expect(renderDescription(revenue)).toBe(
      "Revenue doubled across the year.\n\nBar chart titled “Revenue by quarter”. X axis “Quarter”; y axis “Revenue (USD m)”. 1 series, 4 data points. " +
        "“Revenue”: min 12 USD m (Q1), max 24 USD m (Q4), latest 24 USD m (Q4), rising from 12 to 24 (+100%).",
    );
    const two = renderDescription(twoSeries);
    expect(two).toContain("“EMEA”: min 10 (2023), max 21 (2025), latest 21 (2025), rising");
    expect(two).toContain("“Americas”: min 30 (2023), max 31 (2024), latest 30.5 (2025), roughly flat");
  });

  it("describes pie shares and diagrams", () => {
    const pie = chart({ chartType: "pie", series: [{ name: "Share", points: [{ x: "Cloud", y: 3 }, { x: "Edge", y: 1 }] }] });
    expect(renderDescription(pie)).toContain("Largest shares: “Cloud” 75%, “Edge” 25%.");
    const flow = diagram({
      diagramType: "flowchart",
      title: "Order flow",
      nodes: [{ id: "a", label: "Order" }, { id: "b", label: "In stock?", shape: "diamond" }, { id: "c", label: "Ship" }],
      edges: [{ from: "a", to: "b" }, { from: "b", to: "c" }],
    });
    expect(renderDescription(flow)).toBe(
      "Flowchart titled “Order flow” with 3 nodes and 2 connections. Starts at “Order”. Ends at “Ship”. Decisions: “In stock?”.",
    );
  });

  it("collapses newlines in labels", () => {
    expect(renderDescription(chart({ chartType: "bar", title: "a\n\nb", series: revenue.series }))).toContain("titled “a b”");
  });
});

describe("renderFencedBlock", () => {
  it("fences code formats with the right info string", () => {
    expect(renderFencedBlock("mermaid", "pie\n")).toBe("```mermaid\npie\n```");
    expect(renderFencedBlock("vega-lite", "{}")).toBe("```vega-lite\n{}\n```");
    expect(renderFencedBlock("matplotlib", "x = 1")).toBe("```python\nx = 1\n```");
    expect(renderFencedBlock("csv", "a,b\r\n")).toBe("```csv\na,b\n```");
    expect(renderFencedBlock("description", "Prose.")).toBe("Prose.");
  });

  it("uses a fence longer than any backtick run in the text", () => {
    expect(renderFencedBlock("csv", "a,```````\r\n")).toBe("````````csv\na,```````\n````````");
  });
});

describe("renderVisual / renderVisualOutputs", () => {
  it("dispatches and reports skipped formats", () => {
    expect(renderVisual(revenue, "mermaid")).toContain("xychart-beta");
    const flow = diagram({ diagramType: "flowchart", nodes: [{ id: "a", label: "A" }, { id: "b", label: "B" }], edges: [{ from: "a", to: "b" }] });
    const result = renderVisualOutputs(flow, ["description", "mermaid", "vega-lite", "matplotlib", "csv", "mermaid"]);
    expect(Object.keys(result.outputs).sort()).toEqual(["csv", "description", "mermaid"]);
    expect(result.skipped).toEqual([
      { format: "vega-lite", reason: "unsupported:flowchart" },
      { format: "matplotlib", reason: "unsupported:flowchart" },
    ]);
  });

  it("re-applies limits to specs that skipped schema parsing", () => {
    const huge = {
      kind: "chart",
      chartType: "bar",
      title: "x".repeat(10_000),
      xAxis: { label: null, unit: null, scale: "band", min: null, max: null },
      yAxis: { label: null, unit: null, scale: "linear", min: null, max: null },
      y2Axis: null,
      source: null,
      summary: "",
      series: Array.from({ length: 100 }, (_, i) => ({
        name: `s${i}`,
        mark: null,
        axis: "y",
        points: Array.from({ length: 5000 }, (_, j) => ({ x: j, y: j })),
      })),
    } as unknown as ChartSpec;
    const vega = JSON.parse(renderVegaLite(huge)!);
    expect(vega.title.length).toBe(VISUAL_SPEC_LIMITS.maxLabelChars);
    expect(vega.data.values.length).toBe(VISUAL_SPEC_LIMITS.maxSeries * VISUAL_SPEC_LIMITS.maxPointsPerSeries);
    const csv = renderCsv(huge)!;
    expect(csv.split("\r\n").length - 2).toBe(VISUAL_SPEC_LIMITS.maxPointsPerSeries);
  });
});

describe("renderer edge cases (council L1)", () => {
  it("skips pie formats with a negative share and says so in the description", () => {
    const pie = chart({ chartType: "pie", series: [{ name: "Mix", points: [{ x: "a", y: 5 }, { x: "b", y: -2 }] }] });
    for (const format of ["mermaid", "vega-lite", "matplotlib"] as const) {
      expect(visualRenderIssue(pie, format)).toBe("negative-share");
      expect(renderVisual(pie, format)).toBeNull();
    }
    expect(renderVisual(pie, "csv")).toContain("b,-2");
    const text = renderVisual(pie, "description")!;
    expect(text).toContain("Includes negative values");
    expect(text).not.toMatch(/100%/);
  });

  it("refuses a log axis with zero or negative values", () => {
    const logged = chart({ chartType: "line", yAxis: { label: "Users", scale: "log" }, series: [{ name: "u", points: [{ x: "Jan", y: 0 }, { x: "Feb", y: 100 }] }] });
    expect(renderVisual(logged, "vega-lite")).toBeNull();
    expect(renderVisual(logged, "matplotlib")).toBeNull();
    expect(renderVisualOutputs(logged, ["vega-lite", "csv"]).skipped).toEqual([{ format: "vega-lite", reason: "log-scale-nonpositive" }]);
  });

  it("skips aligned formats when a category repeats within a series, but keeps every point in CSV", () => {
    const dup = chart({ chartType: "bar", series: [{ name: "s", points: [{ x: "a", y: 1 }, { x: "a", y: 3 }] }] });
    expect(visualRenderIssue(dup, "mermaid")).toBe("duplicate-x");
    expect(renderVisual(dup, "matplotlib")).toBeNull();
    expect(renderVisual(dup, "csv")).toMatch(/a,1[\s\S]*a,3/);
    const scatter = chart({ chartType: "scatter", xAxis: { scale: "linear" }, series: [{ name: "s", points: [{ x: 1, y: 1 }, { x: 1, y: 3 }] }] });
    expect(visualRenderIssue(scatter, "vega-lite")).toBeNull();
  });

  it("writes huge and tiny numbers with an exponent, and gives them no Mermaid form", () => {
    const huge = chart({ chartType: "bar", series: [{ name: "s", points: [{ x: "a", y: 1e308 }, { x: "b", y: 1e-30 }] }] });
    const csv = renderVisual(huge, "csv")!;
    expect(csv).toContain("1e+308");
    expect(csv).toContain("1e-30");
    expect(csv.length).toBeLessThan(200);
    expect(renderVisual(huge, "matplotlib")).toContain("1e+308");
    expect(visualRenderIssue(huge, "mermaid")).toBe("number-out-of-range");
    expect(renderVisual(huge, "mermaid")).toBeNull();
  });
});
