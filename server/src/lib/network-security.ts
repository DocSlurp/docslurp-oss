import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import type { TLSSocket } from "node:tls";
import tls from "node:tls";

// Use undici's own fetch with its Agent. Node's global fetch bundles a different
// undici major (v7 on Node 24), whose handler shape the v8 Agent rejects with
// "invalid onRequestStart method", so every vetted request failed in production.
import { Agent, fetch as undiciFetch, type RequestInit as UndiciRequestInit } from "undici";

type SafeLookupAddress = {
  address: string;
  family: 4 | 6;
};

type ConnectorOptions = {
  hostname: string;
  host?: string;
  protocol: string;
  port?: string;
  servername?: string;
  localAddress?: string | null;
};

type ConnectorCallback = (...args: [null, TLSSocket] | [Error, null]) => void;
type ConnectorDone = (error: Error | null, socket: TLSSocket | null) => void;

/**
 * A URL was refused by the outbound-request policy (scheme, credentials, port,
 * or a non-public address). The message is safe to show to the caller: it
 * names the rule, never the resolved addresses.
 */
export class UnsafeExternalUrlError extends Error {
  override name = "UnsafeExternalUrlError";
}

// BlockList normalizes IPv6, including hexadecimal IPv4-mapped addresses.
const nonPublicAddresses = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10],
  ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) nonPublicAddresses.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of [
  ["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10],
  ["ff00::", 8], ["2001:db8::", 32], ["2001::", 32],
  ["2002::", 16], ["64:ff9b::", 96], ["64:ff9b:1::", 48],
] as const) nonPublicAddresses.addSubnet(address, prefix, "ipv6");

const publicIpv6Addresses = new BlockList();
publicIpv6Addresses.addSubnet("2000::", 3, "ipv6");
publicIpv6Addresses.addSubnet("::ffff:0:0", 96, "ipv6");

function isPrivateIp(address: string): boolean {
  const family = isIP(address);
  return family === 0 ||
    (family === 6 && !publicIpv6Addresses.check(address, "ipv6")) ||
    nonPublicAddresses.check(address, family === 4 ? "ipv4" : "ipv6");
}

function assertSafeExternalUrlShape(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new UnsafeExternalUrlError("Invalid URL");
  }

  if (parsed.protocol !== "https:") {
    throw new UnsafeExternalUrlError("Only https URLs are allowed");
  }
  if (parsed.username || parsed.password) {
    throw new UnsafeExternalUrlError("URLs with embedded credentials are not allowed");
  }
  if (parsed.port && parsed.port !== "443") {
    throw new UnsafeExternalUrlError("Custom URL ports are not allowed");
  }

  return parsed;
}

async function resolveSafeExternalHostname(hostname: string): Promise<SafeLookupAddress[]> {
  if (isIP(hostname)) {
    if (isPrivateIp(hostname)) {
      throw new UnsafeExternalUrlError("Private or loopback IP addresses are not allowed");
    }
    return [{
      address: hostname,
      family: isIP(hostname) as 4 | 6,
    }];
  }

  const addresses = await lookup(hostname, { all: true, verbatim: true }).catch(() => {
    throw new UnsafeExternalUrlError("Unable to resolve URL host");
  });
  if (addresses.length === 0) {
    throw new UnsafeExternalUrlError("Unable to resolve URL host");
  }
  if (addresses.some((entry) => isPrivateIp(entry.address))) {
    throw new UnsafeExternalUrlError("URL resolves to a private or loopback address");
  }

  return addresses.map((entry) => ({
    address: entry.address,
    family: entry.family as 4 | 6,
  }));
}

async function resolveSafeExternalUrl(rawUrl: string): Promise<URL> {
  const parsed = assertSafeExternalUrlShape(rawUrl);
  await resolveSafeExternalHostname(parsed.hostname.replace(/^\[|\]$/g, ""));
  return parsed;
}

function onceConnectorCallback(callback: ConnectorCallback): ConnectorDone {
  let settled = false;
  return (error, socket) => {
    if (settled) {
      return;
    }
    settled = true;
    if (error) {
      callback(error, null);
      return;
    }
    callback(null, socket as TLSSocket);
  };
}

function createDnsPinnedDispatcher(hostname: string): Agent {
  return new Agent({
    connect(options: ConnectorOptions, callback: ConnectorCallback) {
      const done = onceConnectorCallback(callback);
      void (async () => {
        const addresses = await resolveSafeExternalHostname(hostname);
        if (addresses.length === 0) {
          throw new Error("Unable to resolve URL host");
        }
        // undici passes `port: ""` when the URL uses the scheme's default port.
        // `Number("")` is 0, so a nullish fallback would dial port 0 and hang
        // until the caller's timeout; treat any empty/invalid port as 443.
        const port = Number(options.port) || 443;

        // Try each vetted address in resolver order so a host whose first answer
        // is unreachable here (commonly IPv6 without an IPv6 route) still works.
        let lastError: Error | null = null;
        for (const selected of addresses) {
          try {
            const socket = await new Promise<TLSSocket>((resolve, reject) => {
              const attempt = tls.connect({
                ...options,
                host: selected.address,
                port,
                servername: hostname,
              });
              attempt.once("secureConnect", () => resolve(attempt));
              attempt.once("error", (error) => {
                attempt.destroy?.();
                reject(error);
              });
            });
            done(null, socket);
            return;
          } catch (error) {
            lastError = error instanceof Error ? error : new Error(String(error));
          }
        }
        throw lastError ?? new Error("Unable to connect to URL host");
      })().catch((error) => {
        done(error instanceof Error ? error : new Error(String(error)), null);
      });
    },
  });
}

function responseWithDispatcherCleanup(response: Response, dispatcher: Agent): Response {
  let closed = false;
  const close = () => {
    if (!closed) { closed = true; void dispatcher.close(); }
  };
  if (!response.body) {
    close();
    return response;
  }

  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          controller.close();
          close();
        } else controller.enqueue(next.value);
      } catch (error) {
        controller.error(error);
        close();
      }
    },
    async cancel(reason) {
      try { await reader.cancel(reason); }
      finally { close(); }
    },
  });

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export async function assertSafeExternalUrl(rawUrl: string): Promise<string> {
  const parsed = await resolveSafeExternalUrl(rawUrl);
  return parsed.toString();
}

export async function safeExternalFetch(rawUrl: string, init: RequestInit = {}): Promise<Response> {
  const parsed = await resolveSafeExternalUrl(rawUrl);
  const dispatcher = createDnsPinnedDispatcher(parsed.hostname.replace(/^\[|\]$/g, ""));

  try {
    const response = await undiciFetch(parsed.toString(), {
      ...init,
      redirect: "error",
      signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
      dispatcher,
    } as UndiciRequestInit);
    return responseWithDispatcherCleanup(response as unknown as Response, dispatcher);
  } catch (error) {
    void dispatcher.close();
    throw error;
  }
}
