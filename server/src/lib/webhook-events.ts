export interface WebhookEventDefinition {
  type: string;
  description: string;
  examplePayload: Record<string, unknown>;
}

export const webhookEventCatalog: WebhookEventDefinition[] = [
  {
    type: "document.replaced",
    description: "Emitted when a newer version of a canonical source finishes processing and replaces older versions in search.",
    examplePayload: {
      event: "document.replaced",
      runId: "run_123",
      workspaceId: "ws_123",
      documentId: "doc_new",
      canonicalId: "/products",
      previousVersionId: "doc_old",
      replacedDocumentIds: ["doc_old"],
      deliveredAt: "2026-03-07T15:00:00.000Z"
    }
  },
  {
    type: "run.completed",
    description: "Emitted when a workspace run finishes. failedDocuments counts Documents that failed and were skipped; retry the Run to reprocess them.",
    examplePayload: {
      event: "run.completed",
      runId: "run_123",
      workspaceId: "ws_123",
      status: "completed",
      processedDocuments: 14,
      failedDocuments: 0,
      pagesProcessed: 942,
      costCents: 187,
      deliveredAt: "2026-03-07T15:00:00.000Z"
    }
  },
  {
    type: "run.failed",
    description: "Emitted when a run fails and can no longer make progress.",
    examplePayload: {
      event: "run.failed",
      runId: "run_123",
      workspaceId: "ws_123",
      status: "failed",
      stage: "extract-markdown",
      error: "pdftotext exited non-zero",
      deliveredAt: "2026-03-07T15:00:00.000Z"
    }
  },
  {
    type: "document.extracted",
    description: "Emitted when a document produces extraction artifacts and plausibility signals.",
    examplePayload: {
      event: "document.extracted",
      runId: "run_123",
      documentId: "doc_123",
      filename: "contract.pdf",
      strategy: "pandoc-consensus",
      plausibilityScore: 0.91,
      deliveredAt: "2026-03-07T15:00:00.000Z"
    }
  },
  {
    type: "document.plausibility_warning",
    description: "Emitted when extraction plausibility falls below the warning threshold.",
    examplePayload: {
      event: "document.plausibility_warning",
      runId: "run_123",
      documentId: "doc_123",
      filename: "scan.pdf",
      strategy: "vision-fallback",
      plausibilityScore: 0.24,
      deliveredAt: "2026-03-07T15:00:00.000Z"
    }
  },
  {
    type: "stage.failed",
    description: "Emitted when a specific pipeline stage fails for a run.",
    examplePayload: {
      event: "stage.failed",
      runId: "run_123",
      stage: "embed",
      status: "failed",
      reason: "embedding model unavailable",
      deliveredAt: "2026-03-07T15:00:00.000Z"
    }
  }
];

export function findWebhookEvent(type: string): WebhookEventDefinition | undefined {
  return webhookEventCatalog.find((event) => event.type === type);
}
