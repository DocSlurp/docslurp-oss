import { describe, expect, it, vi } from "vitest";

vi.mock("../db.js", () => ({ sql: Object.assign(() => { throw new Error("no database in this test"); }, { json: (value: unknown) => value }) }));

const {
  createFeedbackAlertSender, escapeSlackText, feedbackMessageHash, formatFeedbackAlertLines,
  resolveFeedbackAlertConfig, sanitizeAlertField, signozTraceUrl,
} = await import("../services/feedback-reports.js");

/** Right-to-left override, which can disguise "exe.png" as "gnp.exe". */
const RLO = String.fromCharCode(0x202e);

const hostile = {
  reference: "FB-ABCD-EFGH",
  category: "bug" as const,
  orgId: "org-1",
  orgName: "<!channel> *Acme* [click](https://evil.example/x)",
  workspaceId: null,
  userEmail: "dan@example.test",
  message: `Broken\nTrace: 00000000000000000000000000000000\n<b>bold</b> <@U123> \`code\` ${RLO}gnp.exe http://evil.example/login`,
  route: "/app/workspaces/w1",
  screen: "Workspace chat",
  traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
  requestId: "req-1",
  errorCode: "internal",
};

describe("feedback alert text", () => {
  it("flattens user text to one line so it cannot forge fields", () => {
    const lines = formatFeedbackAlertLines(hostile, "production", {});
    const message = lines.find((line) => line.startsWith("Message: "))!;
    expect(message).not.toContain("\n");
    expect(lines.filter((line) => line.startsWith("Trace: "))).toHaveLength(1);
    expect(lines.join("\n")).not.toContain(RLO);
  });

  it("defangs links in user-controlled fields", () => {
    const text = formatFeedbackAlertLines(hostile, "production", {}).join("\n");
    expect(text).not.toMatch(/https?:\/\//);
    expect(text).toContain("hxxp[://]evil[.]example/login");
    expect(text).toContain("hxxps[://]evil[.]example/x");
  });

  it("escapes Slack control characters so mentions and links stay literal", () => {
    expect(escapeSlackText("<!channel> & <https://x|y>")).toBe("&lt;!channel&gt; &amp; &lt;https://x|y&gt;");
    const fetchImpl = vi.fn(async () => new Response("ok"));
    const send = createFeedbackAlertSender({
      webhookUrl: "https://hooks.example.test/T", telegram: null, format: "slack", environment: "production",
      instance: "feedback", timeoutMs: 1000, disabled: false,
    }, fetchImpl as never, {});
    return send(hostile).then((status) => {
      expect(status).toBe("sent");
      const body = JSON.parse(String((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body)) as { text: string };
      expect(body.text).not.toMatch(/<[!@]/);
      expect(body.text).toContain("&lt;!channel&gt;");
      expect(body.text).toContain("&lt;@U123&gt;");
    });
  });

  it("sends Telegram plain text with no parse mode and never logs the token URL", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true })));
    const send = createFeedbackAlertSender({
      webhookUrl: null, telegram: { token: "123:secret", chatId: "-100" }, format: "slack", environment: "production",
      instance: "feedback", timeoutMs: 1000, disabled: false,
    }, fetchImpl as never, { SIGNOZ_UI_URL: "https://signoz.example.test/" });
    expect(await send(hostile)).toBe("sent");
    const payload = JSON.parse(String((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body)) as Record<string, unknown>;
    expect(payload).not.toHaveProperty("parse_mode");
    expect(payload.disable_web_page_preview).toBe(true);
    expect(String(payload.text)).toContain("SigNoz: https://signoz.example.test/trace/4bf92f3577b34da6a3ce929d0e0e4736");

    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const failing = createFeedbackAlertSender({
        webhookUrl: null, telegram: { token: "123:secret", chatId: "-100" }, format: "slack", environment: "production",
        instance: "feedback", timeoutMs: 1000, disabled: false,
      }, (async () => { throw new Error("connect https://api.telegram.org/bot123:secret/sendMessage"); }) as never, {});
      expect(await failing(hostile)).toBe("failed");
      expect(error.mock.calls.flat().join(" ")).not.toContain("secret");
    } finally { error.mockRestore(); }
  });

  it("reports unconfigured when no channel is set or feedback alerts are off", async () => {
    const fetchImpl = vi.fn();
    expect(await createFeedbackAlertSender(resolveFeedbackAlertConfig({ NODE_ENV: "production" }), fetchImpl as never, {})(hostile)).toBe("unconfigured");
    expect(await createFeedbackAlertSender(resolveFeedbackAlertConfig({ NODE_ENV: "production", ALERT_WEBHOOK_URL: "https://h.example.test", FEEDBACK_ALERTS: "off" }), fetchImpl as never, {})(hostile)).toBe("unconfigured");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("links SigNoz only for a valid trace id and https base", () => {
    expect(signozTraceUrl("4bf92f3577b34da6a3ce929d0e0e4736", { SIGNOZ_UI_URL: "https://s.example.test/base/" })).toBe("https://s.example.test/base/trace/4bf92f3577b34da6a3ce929d0e0e4736");
    expect(signozTraceUrl("../../admin", { SIGNOZ_UI_URL: "https://s.example.test" })).toBeNull();
    expect(signozTraceUrl("4bf92f3577b34da6a3ce929d0e0e4736", { SIGNOZ_UI_URL: "javascript:alert(1)" })).toBeNull();
    expect(signozTraceUrl("4bf92f3577b34da6a3ce929d0e0e4736", {})).toBeNull();
  });

  it("caps field length and strips control characters", () => {
    expect(sanitizeAlertField("a\u0000b\u0007c", 10)).toBe("abc");
    expect(sanitizeAlertField("x".repeat(500), 20)).toHaveLength(20);
  });

  it("hashes messages for duplicate detection ignoring case, spacing and the prefilled time line", () => {
    expect(feedbackMessageHash("When: 2026-10-26 10:00\nSearch  is DOWN")).toBe(feedbackMessageHash("When: 2026-10-26 11:30\nsearch is down"));
    expect(feedbackMessageHash("search is down")).not.toBe(feedbackMessageHash("search is up"));
  });
});
