import type { FileRef } from "@docslurp/shared";
import { notionCredentialsSchema, notionConfigSchema } from "@docslurp/shared";
import type { ConnectorAdapter } from "./base.js";
import { ConnectorError } from "./base.js";

/**
 * Notion connector adapter.
 * Uses the Notion REST API v1 to list pages/databases and export them as markdown.
 */
export class NotionConnectorAdapter implements ConnectorAdapter {
  readonly type = "notion";

  private async notionFetch(
    path: string,
    integrationToken: string,
    options: RequestInit = {}
  ): Promise<Response> {
    const response = await fetch(`https://api.notion.com/v1${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${integrationToken}`,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
        ...(options.headers ?? {}),
      },
    });
    return response;
  }

  async listFiles(
    rawConfig: Record<string, unknown>,
    rawCreds: Record<string, unknown>
  ): Promise<FileRef[]> {
    const config = notionConfigSchema.parse(rawConfig);
    const creds = notionCredentialsSchema.parse(rawCreds);

    const files: FileRef[] = [];

    if (config.includeDatabases && config.databaseId) {
      // Query a specific database
      let cursor: string | undefined;
      do {
        const response = await this.notionFetch(
          `/databases/${encodeURIComponent(config.databaseId)}/query`,
          creds.integrationToken,
          {
            method: "POST",
            body: JSON.stringify({ start_cursor: cursor }),
          }
        );

        if (!response.ok) {
          const body = await response.text();
          if (response.status === 401) {
            throw new ConnectorError(`Notion auth failed: ${body}`, "auth_failed");
          }
          throw new ConnectorError(`Notion database query failed: ${body}`, "network_error", true);
        }

        const data = await response.json() as {
          results: Array<{ id: string; object: string; last_edited_time?: string; properties?: Record<string, unknown> }>;
          has_more: boolean;
          next_cursor?: string;
        };

        for (const page of data.results) {
          files.push({
            id: page.id,
            name: `notion-db-page-${page.id}`,
            path: page.id,
            mimeType: "application/x-notion-page",
            modifiedAt: page.last_edited_time,
          });
        }

        cursor = data.has_more ? data.next_cursor : undefined;
      } while (cursor);
    } else if (config.includePages) {
      // Search all accessible pages
      let cursor: string | undefined;
      do {
        const body: Record<string, unknown> = {
          filter: { value: "page", property: "object" },
        };
        if (cursor) body["start_cursor"] = cursor;

        const response = await this.notionFetch(
          "/search",
          creds.integrationToken,
          { method: "POST", body: JSON.stringify(body) }
        );

        if (!response.ok) {
          const text = await response.text();
          throw new ConnectorError(`Notion search failed: ${text}`, "network_error", true);
        }

        const data = await response.json() as {
          results: Array<{ id: string; object: string; last_edited_time?: string; url?: string }>;
          has_more: boolean;
          next_cursor?: string;
        };

        for (const page of data.results) {
          files.push({
            id: page.id,
            name: `notion-page-${page.id}`,
            path: page.id,
            mimeType: "application/x-notion-page",
            modifiedAt: page.last_edited_time,
          });
        }

        cursor = data.has_more ? data.next_cursor : undefined;
      } while (cursor);
    }

    return files;
  }

  async downloadFile(
    _config: Record<string, unknown>,
    rawCreds: Record<string, unknown>,
    fileRef: FileRef
  ): Promise<Buffer> {
    const creds = notionCredentialsSchema.parse(rawCreds);

    // Fetch page blocks and serialize to markdown-like text
    const response = await this.notionFetch(
      `/blocks/${encodeURIComponent(fileRef.id)}/children?page_size=100`,
      creds.integrationToken
    );

    if (!response.ok) {
      const body = await response.text();
      throw new ConnectorError(`Notion block fetch failed: ${body}`, "network_error", true);
    }

    const data = await response.json() as {
      results: Array<{ type: string; [key: string]: unknown }>;
    };

    const lines = data.results.map((block) => {
      // Basic block-to-text conversion; full implementation would handle nested blocks
      const type = block.type as string;
      const content = (block[type] as { rich_text?: Array<{ plain_text: string }> }) ?? {};
      const text = content.rich_text?.map((rt) => rt.plain_text).join("") ?? "";

      switch (type) {
        case "heading_1": return `# ${text}`;
        case "heading_2": return `## ${text}`;
        case "heading_3": return `### ${text}`;
        case "bulleted_list_item": return `- ${text}`;
        case "numbered_list_item": return `1. ${text}`;
        case "code": return `\`\`\`\n${text}\n\`\`\``;
        default: return text;
      }
    });

    return Buffer.from(lines.join("\n\n"), "utf-8");
  }

  async validateCredentials(rawCreds: Record<string, unknown>): Promise<boolean> {
    const result = notionCredentialsSchema.safeParse(rawCreds);
    if (!result.success) return false;
    try {
      const response = await this.notionFetch("/users/me", result.data.integrationToken);
      return response.ok;
    } catch {
      return false;
    }
  }
}
