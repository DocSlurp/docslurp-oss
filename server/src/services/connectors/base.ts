import type { FileRef } from "@docslurp/shared";

/**
 * Base interface all connector adapters must implement.
 * Implementations should be stateless — credentials/config are passed per call.
 */
export interface ConnectorAdapter {
  readonly type: string;

  /**
   * List files available in the external source.
   * Returns a flat list of FileRef objects; adapters handle pagination internally.
   */
  listFiles(config: Record<string, unknown>, credentials: Record<string, unknown>): Promise<FileRef[]>;

  /**
   * Download a single file by its FileRef.
   * Returns the raw bytes of the file.
   */
  downloadFile(
    config: Record<string, unknown>,
    credentials: Record<string, unknown>,
    fileRef: FileRef
  ): Promise<Buffer>;

  /**
   * Validate that credentials are still valid.
   * Returns true if the connector can authenticate; false or throws on failure.
   */
  validateCredentials(credentials: Record<string, unknown>): Promise<boolean>;
}

export class ConnectorError extends Error {
  constructor(
    message: string,
    public readonly code: "auth_failed" | "rate_limited" | "not_found" | "network_error" | "config_error",
    public readonly retryable: boolean = false
  ) {
    super(message);
    this.name = "ConnectorError";
  }
}
