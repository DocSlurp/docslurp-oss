/**
 * Prompt-injection signals for retrieved evidence: flag-only.
 *
 * A keyword or regex match never edits, hides or drops evidence. API docs say
 * "pass your API key in the Authorization header" and invoices say "send to
 * accounts payable"; deleting those lines silently removed real content while
 * the same instruction in another language passed untouched. Evidence is kept
 * verbatim and isolated structurally instead (`formatEvidenceBlocks` in
 * lib/ai.ts: a nonce-delimited block per document that the document text
 * cannot close, plus the system rule that evidence is data). A match is only
 * logged, so operators can see attacks without readers losing text.
 */
const instructionLikePatterns: Array<{ label: string; pattern: RegExp }> = [
  { label: "override-instructions", pattern: /\b(ignore|forget|disregard|override)\b.{0,40}\b(instruction|system prompt|developer message|previous)\b/i },
  { label: "role-escalation", pattern: /(^|\n)\s*(system|developer|assistant|tool)\s*:/i }
];

export type PromptInjectionClassification = {
  flagged: boolean;
  indicators: string[];
};

/** The labels of injection-shaped patterns in `text`. The text itself is never changed. */
export function classifyUntrustedEvidenceText(text: string): PromptInjectionClassification {
  const indicators = instructionLikePatterns.filter(({ pattern }) => pattern.test(text)).map(({ label }) => label);
  return { flagged: indicators.length > 0, indicators };
}

/** Log (never remove) injection-shaped evidence. Only labels and a source name are written, not the text. */
export function logInjectionIndicators(source: string, classification: PromptInjectionClassification): void {
  if (!classification.flagged) return;
  console.warn(`[prompt-injection] flagged source=${source} indicators=${classification.indicators.join(",")} action=none`);
}
