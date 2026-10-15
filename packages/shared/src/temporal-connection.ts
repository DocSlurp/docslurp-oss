function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }

  return String(error);
}

export interface TemporalConnectionDetails {
  address: string;
  namespace: string;
  taskQueue?: string;
}

export interface TemporalConnectRetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

export function isLocalTemporalAddress(address: string): boolean {
  const normalized = address.trim().toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized.startsWith("localhost:") ||
    normalized.startsWith("127.0.0.1:") ||
    normalized.startsWith("[::1]:")
  );
}

export function isTemporalConnectionRefused(error: unknown): boolean {
  const message = getErrorMessage(error).toLowerCase();
  return (
    message.includes("connection refused") ||
    message.includes("econnrefused") ||
    message.includes("tcp connect error")
  );
}

export function isTemporalConnectionUnavailable(error: unknown): boolean {
  const message = getErrorMessage(error).toLowerCase();
  return (
    isTemporalConnectionRefused(error) ||
    message.includes("failed to connect before the deadline") ||
    message.includes("deadline exceeded") ||
    message.includes("timed out") ||
    message.includes("could not connect to temporal")
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function retryTemporalConnect<T>(
  connect: () => Promise<T>,
  options: TemporalConnectRetryOptions = {}
): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? 5);
  const baseDelayMs = Math.max(0, options.baseDelayMs ?? 250);
  const maxDelayMs = Math.max(baseDelayMs, options.maxDelayMs ?? 2_000);

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await connect();
    } catch (error) {
      if (!isTemporalConnectionUnavailable(error) || attempt === attempts) {
        throw error;
      }

      const backoffMs = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      await delay(backoffMs);
    }
  }

  throw new Error("Temporal connection retry loop exited unexpectedly");
}

export function formatTemporalConnectionError(
  details: TemporalConnectionDetails,
  roleLabel: string,
  error: unknown
): string {
  const lines = [
    `${roleLabel} could not connect to Temporal at ${details.address}.`,
    `namespace=${details.namespace}`,
  ];

  if (details.taskQueue) {
    lines.push(`taskQueue=${details.taskQueue}`);
  }

  if (isLocalTemporalAddress(details.address)) {
    lines.push(
      "Local development expects the Docker Temporal service to be running.",
      "Start it with `pnpm db:up` or `docker compose up -d temporal temporal-ui`, then retry."
    );
  } else {
    lines.push(
      "Verify `TEMPORAL_ADDRESS` plus any matching `TEMPORAL_TLS_*` settings for the target cluster."
    );
  }

  lines.push(`originalError=${getErrorMessage(error)}`);
  return lines.join("\n");
}
