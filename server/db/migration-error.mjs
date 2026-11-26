/**
 * The migration runner wraps a failed file in "migration <file> failed: ..." and keeps the database's own error (a
 * migration's RAISE EXCEPTION, its HINT) as the cause; lead with it. Child-process stdout and stderr are kept too.
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
