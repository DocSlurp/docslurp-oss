export type { ConnectorAdapter } from "./base.js";
export { ConnectorError } from "./base.js";
export { S3ConnectorAdapter } from "./s3.js";
export { GoogleDriveConnectorAdapter } from "./google-drive.js";
export { NotionConnectorAdapter } from "./notion.js";
export { ConfluenceConnectorAdapter } from "./confluence.js";

import type { ConnectorType } from "@docslurp/shared";

import type { ConnectorAdapter } from "./base.js";
import { S3ConnectorAdapter } from "./s3.js";
import { GoogleDriveConnectorAdapter } from "./google-drive.js";
import { NotionConnectorAdapter } from "./notion.js";
import { ConfluenceConnectorAdapter } from "./confluence.js";

// Keyed by ConnectorType so the shared type enum and the adapters cannot drift:
// a type without an adapter (or an adapter without a type) fails typecheck.
const registry: Record<ConnectorType, ConnectorAdapter> = {
  s3: new S3ConnectorAdapter(),
  "google-drive": new GoogleDriveConnectorAdapter(),
  notion: new NotionConnectorAdapter(),
  confluence: new ConfluenceConnectorAdapter(),
};

export function getConnectorAdapter(type: string): ConnectorAdapter {
  const adapter = Object.hasOwn(registry, type) ? registry[type as ConnectorType] : undefined;
  if (!adapter) {
    throw new Error(`No connector adapter registered for type: ${type}. Supported: ${Object.keys(registry).join(", ")}`);
  }
  return adapter;
}
