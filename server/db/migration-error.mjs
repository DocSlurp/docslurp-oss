/**
 * drizzle-kit writes SQL errors to stdout on some failures; retain both streams. drizzle-orm wraps a failed statement in
 * "Failed query: ..." and keeps the database's own error (a migration's RAISE EXCEPTION, its HINT) as the cause; keep it.
 */
export function migrationFailureDetail(error) {
  const failure = error && typeof error === 'object' ? error : {};
  const cause = failure.cause && typeof failure.cause === 'object' ? failure.cause : null;
  const causeDetail = cause instanceof Error ? [`cause: ${cause.message}`, typeof cause.hint === 'string' ? `hint: ${cause.hint}` : null] : [];
  const parts = [...causeDetail, error instanceof Error ? error.message : String(error), failure.stdout, failure.stderr]
    .filter(value => typeof value === 'string' && value.trim());
  return [...new Set(parts)].join('\n')
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/postgres(?:ql)?:\/\/[^\s'"<>]+/gi, '[redacted database URL]');
}
