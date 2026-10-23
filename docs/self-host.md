# Self-host DocSlurp

The self-host documentation moved to [self-host/README.md](self-host/README.md).
This page stays so that old links keep working. The table shows where each
section of the old page went.

| Old section | Now |
| --- | --- |
| <a id="requirements"></a>Requirements | [requirements.md](self-host/requirements.md), [docker-compose.md#requirements](self-host/docker-compose.md#requirements) |
| <a id="start"></a>Start | [docker-compose.md#start](self-host/docker-compose.md#start) |
| <a id="configuration"></a>Configuration | [configuration.md](self-host/configuration.md) |
| <a id="storage-configuration"></a>Storage configuration | [configuration.md#storage-configuration](self-host/configuration.md#storage-configuration) |
| <a id="public-access"></a>Public access | [public-access.md](self-host/public-access.md) |
| <a id="client-ip-behind-a-proxy-or-cdn"></a>Client IP behind a proxy or CDN | [public-access.md#client-ip-behind-a-proxy-or-cdn](self-host/public-access.md#client-ip-behind-a-proxy-or-cdn) |
| <a id="data-upgrades-and-recovery"></a>Data, upgrades, and recovery | Backups: [operations.md#backups-and-restore](self-host/operations.md#backups-and-restore). Upgrades: [operations.md#upgrades](self-host/operations.md#upgrades). Stopping containers: [docker-compose.md#stop](self-host/docker-compose.md#stop) |

## MCP Apps uploader and MinIO

The optional MCP Apps uploader (`DOCSLURP_MCP_APPS_UI_ENABLED`) makes the browser PUT files to presigned storage URLs. In the default Compose stack those URLs point at `http://minio:9000`, which browsers cannot reach, so the uploader does not work there. To fix that, publish MinIO on a hostname browsers can reach (an https reverse proxy in front of `minio:9000`), set `STORAGE_PUBLIC_ENDPOINT` to that origin, and add a PUT-only CORS rule. The server keeps talking to `http://minio:9000` and only signs upload URLs against the public origin. The setting applies to every presigned upload URL (dashboard, SDK and CLI direct uploads too). Using R2, Tigris or S3 for `STORAGE_URI` also works. Details: [mcp.md](mcp.md#mcp-apps-uploader-openuploader).
