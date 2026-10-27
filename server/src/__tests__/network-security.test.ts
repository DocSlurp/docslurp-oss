import { EventEmitter } from "node:events";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  lookup: vi.fn(),
  tlsConnect: vi.fn(),
  agentOptions: [] as Array<{ connect: Function }>,
  agentClose: vi.fn(),
  // Delegates to the (stubbable) global so the response-shaping tests below can
  // drive it, while still recording that undici's own fetch was used.
  undiciFetch: vi.fn((...args: Parameters<typeof fetch>) => globalThis.fetch(...args)),
}));

vi.mock("node:dns/promises", () => ({
  lookup: mocks.lookup,
}));

vi.mock("node:tls", () => ({
  default: {
    connect: mocks.tlsConnect,
  },
}));

vi.mock("undici", () => ({
  fetch: mocks.undiciFetch,
  Agent: class Agent {
    constructor(options: { connect: Function }) {
      mocks.agentOptions.push(options);
    }

    close() {
      mocks.agentClose();
      return Promise.resolve();
    }
  },
}));

const { assertSafeExternalUrl, safeExternalFetch } = await import("../lib/network-security.js");

describe("network-security", () => {
  beforeEach(() => {
    mocks.lookup.mockReset();
    mocks.tlsConnect.mockReset();
    mocks.agentOptions.length = 0;
    mocks.agentClose.mockReset();
    mocks.undiciFetch.mockClear();
    vi.unstubAllGlobals();
  });

  it("sends through undici's fetch with the pinned Agent, not Node's global fetch", async () => {
    // Node 24's global fetch bundles undici 7, whose handlers the undici 8 Agent
    // rejects ("invalid onRequestStart method"); pairing them broke all egress.
    mocks.lookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("ok")));
    await (await safeExternalFetch("https://example.com/file")).text();
    expect(mocks.undiciFetch).toHaveBeenCalledTimes(1);
    expect(mocks.undiciFetch.mock.calls[0]![1]).toMatchObject({ redirect: "error", dispatcher: expect.any(Object) });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("allows https hosts that resolve only to public addresses", async () => {
    mocks.lookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);

    await expect(assertSafeExternalUrl("https://example.com/path")).resolves.toBe("https://example.com/path");
  });

  it("blocks hosts that resolve to private addresses", async () => {
    mocks.lookup.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);

    await expect(assertSafeExternalUrl("https://metadata.example/path")).rejects.toThrow(
      "private or loopback",
    );
  });

  it.each([
    "::ffff:7f00:1", "::ffff:a9fe:a9fe", "::ffff:ac10:1", "::ffff:c0a8:1",
    "fec0::1", "100::1", "::7f00:1", "198.18.0.1", "224.0.0.1", "240.0.0.1", "2001:db8::1", "64:ff9b::7f00:1",
  ])("blocks non-public DNS answers including mapped address %s", async (address) => {
    mocks.lookup.mockResolvedValue([{ address, family: address.includes(":") ? 6 : 4 }]);
    await expect(assertSafeExternalUrl("https://external.example/file")).rejects.toThrow("private or loopback");
  });

  it.each(["2606:4700::1111", "::ffff:5db8:d822"])("allows globally routed IPv6 or mapped public address %s", async (address) => {
    mocks.lookup.mockResolvedValue([{ address, family: 6 }]);
    await expect(assertSafeExternalUrl("https://external.example/file")).resolves.toBe("https://external.example/file");
  });

  it("blocks bracketed IPv6 literals without DNS lookup", async () => {
    await expect(assertSafeExternalUrl("https://[::ffff:127.0.0.1]/file")).rejects.toThrow(/private or loopback/i);
    expect(mocks.lookup).not.toHaveBeenCalled();
  });

  it("never follows a redirect, even if a caller requests it", async () => {
    mocks.lookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const fetchMock = vi.fn(async () => new Response("ok"));
    vi.stubGlobal("fetch", fetchMock);
    await safeExternalFetch("https://example.com/file", { redirect: "follow" });
    expect(fetchMock).toHaveBeenCalledWith("https://example.com/file", expect.objectContaining({ redirect: "error", signal: expect.any(AbortSignal) }));
  });

  it("closes the dispatcher when an oversized response is canceled", async () => {
    mocks.lookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1])); } }))));
    const response = await safeExternalFetch("https://example.com/file");
    await response.body!.cancel();
    expect(mocks.agentClose).toHaveBeenCalledOnce();
  });

  it("closes the dispatcher when the upstream body fails", async () => {
    mocks.lookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({ start(controller) { controller.error(new Error("upstream failed")); } }))));
    const response = await safeExternalFetch("https://example.com/file");
    await expect(response.text()).rejects.toThrow("upstream failed");
    expect(mocks.agentClose).toHaveBeenCalledOnce();
  });

  it("re-resolves and blocks private addresses at connection time", async () => {
    mocks.lookup
      .mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }])
      .mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }]);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("ok")));

    await safeExternalFetch("https://example.com/file");

    const connect = mocks.agentOptions[0]?.connect;
    expect(connect).toBeTypeOf("function");

    const callbackErrors: Error[] = [];
    await new Promise<void>((resolve) => {
      connect(
        { hostname: "example.com", protocol: "https:", port: "443" },
        (error: Error | null) => {
          if (error) {
            callbackErrors.push(error);
          }
          resolve();
        },
      );
    });

    expect(callbackErrors[0]?.message).toMatch(/private or loopback/i);
    expect(mocks.tlsConnect).not.toHaveBeenCalled();
  });

  it("connects to a resolved public IP while preserving the original TLS server name", async () => {
    mocks.lookup
      .mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }])
      .mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }]);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("ok")));
    const socket = new EventEmitter();
    mocks.tlsConnect.mockReturnValue(socket);

    await safeExternalFetch("https://example.com/file");

    const connect = mocks.agentOptions[0]?.connect;
    let callbackSocket: unknown;
    const connected = new Promise<void>((resolve) => {
      connect(
        { hostname: "example.com", protocol: "https:", port: "443" },
        (_error: Error | null, resolvedSocket: unknown) => {
          callbackSocket = resolvedSocket;
          resolve();
        },
      );
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    socket.emit("secureConnect");
    await connected;

    expect(mocks.tlsConnect).toHaveBeenCalledWith(expect.objectContaining({
      host: "93.184.216.34",
      port: 443,
      servername: "example.com",
    }));
    expect(callbackSocket).toBe(socket);
  });

  it("dials 443 when undici passes an empty default port", async () => {
    mocks.lookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("ok")));
    const socket = new EventEmitter();
    mocks.tlsConnect.mockReturnValue(socket);

    await safeExternalFetch("https://example.com/file");
    const connect = mocks.agentOptions[0]!.connect;
    const connected = new Promise<void>((resolve) => {
      connect({ hostname: "example.com", protocol: "https:", port: "" }, () => resolve());
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    socket.emit("secureConnect");
    await connected;

    expect(mocks.tlsConnect).toHaveBeenCalledWith(expect.objectContaining({ host: "93.184.216.34", port: 443 }));
  });

  it("falls back to the next vetted address when the first one fails to connect", async () => {
    mocks.lookup.mockResolvedValue([
      { address: "2606:4700::1111", family: 6 },
      { address: "93.184.216.34", family: 4 },
    ]);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("ok")));
    const unreachable = Object.assign(new EventEmitter(), { destroy: vi.fn() });
    const reachable = new EventEmitter();
    mocks.tlsConnect.mockReturnValueOnce(unreachable).mockReturnValueOnce(reachable);

    await safeExternalFetch("https://example.com/file");
    const connect = mocks.agentOptions[0]!.connect;
    let result: { error: Error | null; socket: unknown } | undefined;
    const connected = new Promise<void>((resolve) => {
      connect({ hostname: "example.com", protocol: "https:", port: "" }, (error: Error | null, socket: unknown) => {
        result = { error, socket };
        resolve();
      });
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    unreachable.emit("error", Object.assign(new Error("connect ENETUNREACH"), { code: "ENETUNREACH" }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    reachable.emit("secureConnect");
    await connected;

    expect(unreachable.destroy).toHaveBeenCalled();
    expect(mocks.tlsConnect).toHaveBeenLastCalledWith(expect.objectContaining({ host: "93.184.216.34", port: 443 }));
    expect(result).toEqual({ error: null, socket: reachable });
  });
});
