import { describe, expect, it } from "vitest";

import { detectVisualDataIntent, hasVisualDataIntent, VISUAL_INTENT_THRESHOLD } from "./visual-intent.js";

describe("detectVisualDataIntent", () => {
  const positives = [
    "Show me a chart of revenue by quarter",
    "Can you graph bookings for 2023 vs 2024?",
    "Plot monthly active users",
    "What is the trend in gross margin over time?",
    "What does the forecast for Q3 2026 look like?",
    "Year-over-year growth in subscriptions",
    "What was the YoY revenue growth?",
    "Draw the approval flowchart from the handbook",
    "Is there an org chart for the sales team?",
    "How does a refund request flow through finance?",
    "Revenue grew 18% in 2025 — what drove it?",
    "Give me the data points for sales by region",
    "Put the quarterly figures in a spreadsheet table and compare them",
    "Muéstrame un gráfico de las ventas",
    "Quelle est la tendance des ventes ?",
    "Wie sieht die Prognose für 2026 aus?",
  ];
  const negatives = [
    "Who signed the lease agreement?",
    "Summarize the onboarding policy",
    "What is the refund policy?",
    "When was the company founded?",
    "What was revenue in 2023?",
    "Find the table of contents",
    "Is the conference room booked?",
    "What did the CEO say about the jet trip to London?",
    "",
  ];

  it.each(positives)("fires on %s", (question) => {
    const result = detectVisualDataIntent(question);
    expect(result.score, JSON.stringify(result)).toBeGreaterThanOrEqual(VISUAL_INTENT_THRESHOLD);
    expect(result.signals.length).toBeGreaterThan(0);
  });

  it.each(negatives)("stays quiet on %s", (question) => {
    expect(hasVisualDataIntent(question), JSON.stringify(detectVisualDataIntent(question))).toBe(false);
  });

  it("reports stable signal names and a bounded score", () => {
    const result = detectVisualDataIntent("Chart the quarterly revenue trend and forecast, with YoY growth by 2025 in a table");
    expect(result.score).toBe(1);
    expect(result.signals).toEqual(["chart", "trend", "forecast", "period-over-period", "growth", "period", "table"]);
  });

  it("handles non-string input and very long text", () => {
    expect(detectVisualDataIntent(undefined as unknown as string)).toEqual({ score: 0, signals: [] });
    expect(detectVisualDataIntent(`${"lorem ".repeat(5000)} chart`).signals).toEqual([]);
  });
});
