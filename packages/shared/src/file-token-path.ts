/** Where the file proxy is mounted (server routes/files.ts). */
export const FILE_PROXY_PREFIX = "/v1/files";

/** Request paths with the token removed, for logs and telemetry. */
export function redactFileTokenPath(pathname: string): string {
  return pathname.startsWith(`${FILE_PROXY_PREFIX}/`) ? `${FILE_PROXY_PREFIX}/:token` : pathname;
}
