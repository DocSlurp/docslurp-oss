import { graphFallbackScope, projectTemplates } from "@docslurp/shared";
import type { Sql } from "postgres";

import { refreshProjectCommunities, type CommunityRefreshResult, type CommunitySummaryContext } from "./communities.js";
import { replaceDocumentGraph, type ReplaceDocumentGraphInput } from "./graph-store.js";
import type { GraphChunk } from "./extract.js";

/** Store surface graph enrichment writes through (pipeline CheckpointStore.graph). */
export interface KnowledgeGraphStore {
  /** Current relational chunks; reused embedding artifacts can contain old document IDs. */
  loadDocumentGraphChunks(projectId: string, documentId: string): Promise<GraphChunk[]>;
  replaceDocumentGraph(input: ReplaceDocumentGraphInput): Promise<{ nodes: number; edges: number }>;
  refreshProjectCommunities(args: {
    projectId: string;
    userId: string;
    runId: string | null;
    context: CommunitySummaryContext;
  }): Promise<CommunityRefreshResult>;
  /** Documents already extracted with this config; a re-run (e.g. retrying failed Documents) skips them. */
  documentsWithGraph(projectId: string, configHash: string, documentIds: readonly string[]): Promise<Set<string>>;
  /** The project's own definition, used as scope when no domain is set. */
  projectGraphScope(projectId: string): Promise<string>;
}

/** The project knowledge graph in Postgres (kg_* tables, graph/graph-store.ts and graph/communities.ts). */
export class PostgresKnowledgeGraph implements KnowledgeGraphStore {
  constructor(private readonly sql: Sql<Record<string, unknown>>) {}

  /** Read graph evidence from current document rows, never reused artifact identities. */
  async loadDocumentGraphChunks(projectId: string, documentId: string): Promise<GraphChunk[]> {
    const rows = await this.sql<{ id: string; text: string; page_number: number | null }[]>`
      select c.id, c.text, c.page_number
      from document_chunks c join documents d on d.id = c.document_id
      where c.document_id = ${documentId} and d.project_id = ${projectId}
      order by c.chunk_index
    `;
    return rows.map((row) => ({ id: row.id, text: row.text, pageNumber: row.page_number }));
  }

  async replaceDocumentGraph(input: ReplaceDocumentGraphInput): Promise<{ nodes: number; edges: number }> {
    return await replaceDocumentGraph(this.sql, input);
  }

  /** Documents whose graph was already extracted with this config (a re-run skips them). */
  async documentsWithGraph(projectId: string, configHash: string, documentIds: readonly string[]): Promise<Set<string>> {
    if (documentIds.length === 0) return new Set();
    const rows = await this.sql<{ document_id: string }[]>`
      select document_id from kg_document_state
      where project_id = ${projectId} and config_hash = ${configHash}
        and document_id = any(${this.sql.array([...documentIds])})
    `;
    return new Set(rows.map((row) => row.document_id));
  }

  async refreshProjectCommunities(args: {
    projectId: string;
    userId: string;
    runId: string | null;
    context: CommunitySummaryContext;
  }): Promise<CommunityRefreshResult> {
    return await refreshProjectCommunities({ sql: this.sql, ...args });
  }

  async projectGraphScope(projectId: string): Promise<string> {
    const [project] = await this.sql<{ name: string; template_key: string | null }[]>`
      select name, template_key from projects where id = ${projectId}
    `;
    if (!project) return "Project";
    return graphFallbackScope({
      name: project.name,
      templateDescription: projectTemplates.find((template) => template.key === project.template_key)?.description,
    });
  }
}
