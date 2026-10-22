import type { FileRef } from "@docslurp/shared";
import { confluenceCredentialsSchema, confluenceConfigSchema } from "@docslurp/shared";
import type { ConnectorAdapter } from "./base.js";
import { ConnectorError } from "./base.js";
import { assertSafeExternalUrl, safeExternalFetch } from "../../lib/network-security.js";

/**
 * Confluence connector adapter.
 * Uses the Confluence REST API v2 with Basic Auth (email + API token).
 */
export class ConfluenceConnectorAdapter implements ConnectorAdapter {
  readonly type = "confluence";

  private authHeader(credentials: { email: string; apiToken: string }): string {
    const encoded = Buffer.from(`${credentials.email}:${credentials.apiToken}`).toString("base64");
    return `Basic ${encoded}`;
  }

  async listFiles(
    rawConfig: Record<string, unknown>,
    rawCreds: Record<string, unknown>
  ): Promise<FileRef[]> {
    const config = confluenceConfigSchema.parse(rawConfig);
    const creds = confluenceCredentialsSchema.parse(rawCreds);
    const baseUrl = await assertSafeExternalUrl(creds.baseUrl);

    const files: FileRef[] = [];
    let start = 0;
    const limit = 50;

    let typeFilter = "";
    if (config.contentType !== "all") {
      typeFilter = `&type=${config.contentType}`;
    }

    do {
      const url = `${baseUrl.replace(/\/+$/, "")}/rest/api/content?spaceKey=${encodeURIComponent(config.spaceKey)}&expand=version${typeFilter}&start=${start}&limit=${limit}`;
      const response = await safeExternalFetch(url, {
        headers: {
          Authorization: this.authHeader(creds),
          "Content-Type": "application/json",
        },
      });

      if (!response.ok) {
        const body = await response.text();
        if (response.status === 401) {
          throw new ConnectorError(`Confluence auth failed: ${body}`, "auth_failed");
        }
        throw new ConnectorError(`Confluence list failed: ${body}`, "network_error", true);
      }

      const data = await response.json() as {
        results: Array<{
          id: string;
          type: string;
          title: string;
          version?: { when?: string };
          _links?: { webui?: string };
        }>;
        size: number;
        limit: number;
      };

      for (const page of data.results) {
        // Filter by label if configured
        if (config.labelFilter.length > 0) {
          // Label filtering would require an additional API call per page;
          // skip for now to keep the adapter simple.
        }

        files.push({
          id: page.id,
          name: page.title,
          path: `${config.spaceKey}/${page.id}`,
          mimeType: "application/x-confluence-page",
          modifiedAt: page.version?.when,
        });
      }

      if (data.results.length < limit) break;
      start += limit;
    } while (true);

    return files;
  }

  async downloadFile(
    rawConfig: Record<string, unknown>,
    rawCreds: Record<string, unknown>,
    fileRef: FileRef
  ): Promise<Buffer> {
    const creds = confluenceCredentialsSchema.parse(rawCreds);
    const baseUrl = await assertSafeExternalUrl(creds.baseUrl);

    // Export content as storage format (HTML-like)
    const url = `${baseUrl.replace(/\/+$/, "")}/rest/api/content/${fileRef.id}?expand=body.storage`;
    const response = await safeExternalFetch(url, {
      headers: {
        Authorization: this.authHeader(creds),
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      const body = await response.text();
      throw new ConnectorError(`Confluence download failed: ${body}`, "network_error", true);
    }

    const data = await response.json() as {
      title: string;
      body: { storage: { value: string } };
    };

    // Return as HTML; the worker's HTML extraction stage will process it
    const html = `<!DOCTYPE html><html><head><title>${data.title}</title></head><body>${data.body.storage.value}</body></html>`;
    return Buffer.from(html, "utf-8");
  }

  async validateCredentials(rawCreds: Record<string, unknown>): Promise<boolean> {
    const result = confluenceCredentialsSchema.safeParse(rawCreds);
    if (!result.success) return false;
    try {
      const baseUrl = await assertSafeExternalUrl(result.data.baseUrl);
      const response = await safeExternalFetch(`${baseUrl.replace(/\/+$/, "")}/rest/api/user/current`, {
        headers: {
          Authorization: this.authHeader(result.data),
          "Content-Type": "application/json",
        },
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}
