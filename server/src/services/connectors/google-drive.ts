import type { FileRef } from "@docslurp/shared";
import { googleDriveCredentialsSchema, googleDriveConfigSchema } from "@docslurp/shared";
import type { ConnectorAdapter } from "./base.js";
import { ConnectorError } from "./base.js";

/**
 * Google Drive connector adapter.
 * Uses the Google Drive REST API v3 via fetch.
 */
export class GoogleDriveConnectorAdapter implements ConnectorAdapter {
  readonly type = "google-drive";

  private async getAccessToken(credentials: {
    clientId: string;
    clientSecret: string;
    refreshToken: string;
  }): Promise<string> {
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: credentials.clientId,
        client_secret: credentials.clientSecret,
        refresh_token: credentials.refreshToken,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new ConnectorError(`Google Drive auth failed: ${body}`, "auth_failed");
    }

    const data = await response.json() as { access_token: string };
    return data.access_token;
  }

  async listFiles(
    rawConfig: Record<string, unknown>,
    rawCreds: Record<string, unknown>
  ): Promise<FileRef[]> {
    const config = googleDriveConfigSchema.parse(rawConfig);
    const creds = googleDriveCredentialsSchema.parse(rawCreds);
    const accessToken = await this.getAccessToken(creds);

    const files: FileRef[] = [];
    let pageToken: string | undefined;

    do {
      const params = new URLSearchParams({
        pageSize: "100",
        fields: "nextPageToken,files(id,name,mimeType,size,modifiedTime,md5Checksum)",
        q: config.folderId
          ? `'${config.folderId}' in parents and trashed = false`
          : "trashed = false",
        ...(pageToken ? { pageToken } : {}),
        ...(config.includeSharedDrives
          ? { includeItemsFromAllDrives: "true", supportsAllDrives: "true" }
          : {}),
      });

      const response = await fetch(
        `https://www.googleapis.com/drive/v3/files?${params.toString()}`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );

      if (!response.ok) {
        const body = await response.text();
        throw new ConnectorError(`Google Drive list failed: ${body}`, "network_error", true);
      }

      const data = await response.json() as {
        nextPageToken?: string;
        files: Array<{
          id: string;
          name: string;
          mimeType: string;
          size?: string;
          modifiedTime?: string;
          md5Checksum?: string;
        }>;
      };

      for (const file of data.files) {
        // Skip Google-native formats that can't be directly downloaded
        if (file.mimeType.startsWith("application/vnd.google-apps.folder")) continue;

        const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
        if (config.fileExtensions.length > 0 && !config.fileExtensions.includes(ext)) continue;

        files.push({
          id: file.id,
          name: file.name,
          path: file.id, // Google Drive uses IDs not paths
          mimeType: file.mimeType,
          size: file.size ? parseInt(file.size, 10) : undefined,
          modifiedAt: file.modifiedTime,
          etag: file.md5Checksum,
        });
      }

      pageToken = data.nextPageToken;
    } while (pageToken);

    return files;
  }

  async downloadFile(
    _config: Record<string, unknown>,
    rawCreds: Record<string, unknown>,
    fileRef: FileRef
  ): Promise<Buffer> {
    const creds = googleDriveCredentialsSchema.parse(rawCreds);
    const accessToken = await this.getAccessToken(creds);

    const response = await fetch(
      `https://www.googleapis.com/drive/v3/files/${fileRef.id}?alt=media`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    if (!response.ok) {
      const body = await response.text();
      if (response.status === 401) {
        throw new ConnectorError(`Google Drive auth failed: ${body}`, "auth_failed");
      }
      throw new ConnectorError(`Google Drive download failed: ${body}`, "network_error", true);
    }

    return Buffer.from(await response.arrayBuffer());
  }

  async validateCredentials(rawCreds: Record<string, unknown>): Promise<boolean> {
    const result = googleDriveCredentialsSchema.safeParse(rawCreds);
    if (!result.success) return false;
    try {
      await this.getAccessToken(result.data);
      return true;
    } catch {
      return false;
    }
  }
}
