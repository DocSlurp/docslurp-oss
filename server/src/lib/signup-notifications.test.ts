import { afterEach, describe, expect, it, vi } from "vitest";
import { createTelegramDelivery, notifySignup } from "./signup-notifications.js";

const { query, authOptions } = vi.hoisted(() => ({
  query: vi.fn(),
  authOptions: { value: undefined as any }
}));
vi.mock("../env.js", () => ({}));
vi.mock("pg", () => ({ Pool: class { query = query; } }));
vi.mock("better-auth", () => ({
  betterAuth: (options: unknown) => { authOptions.value = options; return {}; }
}));

const configure = () => ({ token: "test-token", chatId: "test-chat" });

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  query.mockReset();
});

describe("Telegram signup delivery", () => {
  it.each(["development", "test", "preview", "staging", undefined])("does not notify Telegram outside production (%s)", async (nodeEnv) => {
    vi.stubEnv("NODE_ENV", nodeEnv);
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-token");
    vi.stubEnv("TELEGRAM_CHAT_ID", "test-chat");
    const transport = vi.fn();
    vi.stubGlobal("fetch", transport);
    await notifySignup({ kind: "account", email: "local@example.test" });
    expect(transport).not.toHaveBeenCalled();
  });

  it("skips missing configuration without making a request", async () => {
    const transport = vi.fn();
    expect(await createTelegramDelivery({ configure: () => ({}), transport })("signup"))
      .toEqual({ delivered: false, reason: "unconfigured" });
    expect(transport).not.toHaveBeenCalled();
  });

  it.each([
    [200, { ok: true }, { delivered: true }],
    [200, { ok: false }, { delivered: false, reason: "rejected" }],
    [403, { ok: false }, { delivered: false, reason: "rejected" }]
  ])("validates HTTP %s and Telegram response %j", async (status, body, expected) => {
    const transport = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }));
    expect(await createTelegramDelivery({ configure, transport })("Name: <&>"))
      .toEqual(expected);
    const [url, options] = transport.mock.calls[0];
    expect(url).toBe("https://api.telegram.org/bottest-token/sendMessage");
    expect(JSON.parse(options.body)).toEqual({
      chat_id: "test-chat", text: "Name: <&>", disable_web_page_preview: true
    });
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it("contains transport errors and logs no token or user data", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "secret-token");
    vi.stubEnv("TELEGRAM_CHAT_ID", "test-chat");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("secret-token")));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(notifySignup({ kind: "account", email: "private@example.com" }))
      .resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledExactlyOnceWith("[signup] Telegram notification unavailable");
  });

  it("contains invalid JSON responses", async () => {
    const transport = vi.fn().mockResolvedValue(new Response("not json"));
    expect(await createTelegramDelivery({ configure, transport })("signup"))
      .toEqual({ delivered: false, reason: "unavailable" });
  });

  it("caps message length at Telegram's limit", async () => {
    const transport = vi.fn().mockResolvedValue(new Response('{"ok":true}'));
    await createTelegramDelivery({ configure, transport })("x".repeat(5000));
    expect(JSON.parse(transport.mock.calls[0][1].body).text).toHaveLength(4096);
  });

  it("notifies after user creation rather than login or account linking", async () => {
    vi.stubEnv("ADMIN_EMAILS", "");
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-token");
    vi.stubEnv("TELEGRAM_CHAT_ID", "test-chat");
    const transport = vi.fn().mockResolvedValue(new Response('{"ok":true}'));
    vi.stubGlobal("fetch", transport);
    query.mockResolvedValue({ rows: [{ ready: true, name: "New User" }] });
    await import("./better-auth.js");
    vi.stubEnv("NODE_ENV", "production");
    await authOptions.value.databaseHooks.user.create.after({
      id: "user-1", email: "new@example.com", name: "New User"
    });
    expect(query).toHaveBeenCalledWith(expect.stringContaining("as ready"), ["user-1"]);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(JSON.parse(transport.mock.calls[0][1].body).text)
      .toContain("new@example.com");
    query.mockClear();
    vi.stubEnv("ADMIN_EMAILS", "admin@example.com");
    await authOptions.value.databaseHooks.session.create.before({ userId: "user-1" });
    expect(query.mock.calls.map(([sql]) => sql)).toEqual([
      expect.stringContaining('select name from "user"'),
      expect.stringContaining("as ready"),
      expect.stringContaining("promoted_orgs"),
      // Account-kind rules (staff/test labelling) run on every sign-in.
      expect.stringContaining("account_kind_source"),
    ]);
    expect(transport).toHaveBeenCalledTimes(1);
  });
});
