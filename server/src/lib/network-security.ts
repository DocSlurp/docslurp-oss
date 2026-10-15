import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import type { TLSSocket } from "node:tls";
import tls from "node:tls";

import { Agent } from "undici";

type FetchInitWithDispatcher = RequestInit & {
  dispatcher?: Agent;
};

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
    throw new Error("Invalid URL");
  }

  if (parsed.protocol !== "https:") {
    throw new Error("Only https URLs are allowed");
  }
  if (parsed.username || parsed.password) {
    throw new Error("URLs with embedded credentials are not allowed");
  }
  if (parsed.port && parsed.port !== "443") {
    throw new Error("Custom URL ports are not allowed");
  }

  return parsed;
}

async function resolveSafeExternalHostname(hostname: string): Promise<SafeLookupAddress[]> {
  if (isIP(hostname)) {
    if (isPrivateIp(hostname)) {
      throw new Error("Private or loopback IP addresses are not allowed");
    }
    return [{
      address: hostname,
      family: isIP(hostname) as 4 | 6,
    }];
  }

  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (addresses.length === 0) {
    throw new Error("Unable to resolve URL host");
  }
  if (addresses.some((entry) => isPrivateIp(entry.address))) {
    throw new Error("URL resolves to a private or loopback address");
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
        const selected = addresses[0];
        if (!selected) {
          throw new Error("Unable to resolve URL host");
        }

        const socket = tls.connect({
          ...options,
          host: selected.address,
          port: Number(options.port ?? 443),
          servername: hostname,
        });

        socket.once("secureConnect", () => done(null, socket));
        socket.once("error", (error) => done(error, null));
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
    const response = await fetch(parsed.toString(), {
      ...init,
      redirect: "error",
      signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
      dispatcher,
    } as FetchInitWithDispatcher);
    return responseWithDispatcherCleanup(response, dispatcher);
  } catch (error) {
    void dispatcher.close();
    throw error;
  }
}
