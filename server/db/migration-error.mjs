/** drizzle-kit writes SQL errors to stdout on some failures; retain both streams. */
export function migrationFailureDetail(error) {
  const failure = error && typeof error === 'object' ? error : {};
  const parts = [error instanceof Error ? error.message : String(error), failure.stdout, failure.stderr]
    .filter(value => typeof value === 'string' && value.trim());
  return [...new Set(parts)].join('\n')
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/postgres(?:ql)?:\/\/[^\s'"<>]+/gi, '[redacted database URL]');
}
