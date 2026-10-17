/** Browser-safe, closed vocabulary. Never use an exception's text as public copy. */
export const PUBLIC_ERROR_MESSAGES = {
  noSpeech: "No speech was detected. Try again.",
  noAudio: "No audio was recorded. Try again.",
  recordingTooLarge: "Recording is too large. Try a shorter question.",
  signIn: "We couldn’t sign you in. Check your email and password.",
  verificationCode: "That code is invalid or has expired. Please request a new one.",
  quickSignIn: "Quick sign-in is unavailable here. Please use your email and password.",
  unexpected: "We couldn’t complete that request. Please try again in a moment.",
  unavailable: "This feature is temporarily unavailable. Please try again later.",
  invalid: "Please check the information you entered and try again.",
  unauthorized: "Please sign in again to continue.",
  forbidden: "You don’t have access to this action. Ask your workspace administrator for help.",
  missing: "We couldn’t find what you’re looking for. It may have been moved or removed.",
  conflict: "Something changed while you were working. Refresh and try again.",
  tooLarge: "This file is too large. Please choose a smaller file and try again.",
  rateLimit: "Please wait a moment before trying again.",
  processing: "We couldn’t finish processing this document. Please try again.",
  paused: "Processing is paused. Your workspace administrator can help you resume it.",
} as const;

export function publicErrorForStatus(status: number): string {
  if (status === 401) return PUBLIC_ERROR_MESSAGES.unauthorized;
  if (status === 402 || status === 503) return PUBLIC_ERROR_MESSAGES.unavailable;
  if (status === 403) return PUBLIC_ERROR_MESSAGES.forbidden;
  if (status === 404) return PUBLIC_ERROR_MESSAGES.missing;
  if (status === 409) return PUBLIC_ERROR_MESSAGES.conflict;
  if (status === 413) return PUBLIC_ERROR_MESSAGES.tooLarge;
  if (status === 429) return PUBLIC_ERROR_MESSAGES.rateLimit;
  if (status >= 400 && status < 500) return PUBLIC_ERROR_MESSAGES.invalid;
  return PUBLIC_ERROR_MESSAGES.unexpected;
}

/** Only our reviewed vocabulary crosses an untrusted error boundary. */
export function friendlyErrorMessage(error: unknown, fallback: string = PUBLIC_ERROR_MESSAGES.unexpected): string {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : null;
  const aliases: Record<string, string> = {
    "Invalid email or password": PUBLIC_ERROR_MESSAGES.signIn,
    "Invalid password": PUBLIC_ERROR_MESSAGES.signIn,
    "Invalid or expired code": PUBLIC_ERROR_MESSAGES.verificationCode,
    "Seed sign-in is only available in development": PUBLIC_ERROR_MESSAGES.quickSignIn,
  };
  if (message && Object.hasOwn(aliases, message)) return aliases[message]!;
  return Object.values(PUBLIC_ERROR_MESSAGES).some(value => value === message) ? message! : fallback;
}

/** Diagnostic objects only: never apply this to document text, schemas or model output. */
export function publicDiagnostics(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(publicDiagnostics);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).flatMap(([key, item]) => {
    if (/stack|exception|traceback|stderr|stdout|debug|raw.?response|provider.?response/i.test(key)) return [];
    if (/error|failure|warning|reason|message|detail/i.test(key)) {
      if (item == null || item === false || item === "") return [[key, item]];
      if (typeof item === "number" || typeof item === "boolean") return [[key, item]];
      // Reasons and warnings also describe successful routing/tuning decisions.
      // Redact their private text without inventing a processing failure.
      const replacement = /error|failure/i.test(key)
        ? PUBLIC_ERROR_MESSAGES.processing
        : "Diagnostic details withheld.";
      return [[key, Array.isArray(item)
        ? item.map(entry => typeof entry === "string" ? replacement : publicDiagnostics(entry))
        : typeof item === "object" ? publicDiagnostics(item) : replacement]];
    }
    return [[key, publicDiagnostics(item)]];
  }));
}

export function publicProcessingMessage(status: string | null): string {
  switch (status) {
    case "failed": return PUBLIC_ERROR_MESSAGES.processing;
    case "paused": return PUBLIC_ERROR_MESSAGES.paused;
    case "completed": return "Processing complete.";
    case "cancelled": case "canceled": return "Processing stopped.";
    case "queued": return "Your documents are waiting to be processed.";
    case "skipped": return "This processing step was skipped.";
    default: return "Processing your documents.";
  }
}
