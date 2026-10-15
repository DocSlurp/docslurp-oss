const instructionLikePatterns: Array<{ label: string; pattern: RegExp }> = [
  { label: "override-instructions", pattern: /\b(ignore|forget|disregard|override)\b.{0,40}\b(instruction|system prompt|developer message|previous)\b/i },
  { label: "role-escalation", pattern: /\b(system:|developer:|assistant:|tool:|function call|tool call)\b/i },
  { label: "secret-seeking", pattern: /\b(api key|token|password|secret|credential|environment variable|env var)\b/i },
  { label: "exfiltration", pattern: /\b(exfiltrate|send to|upload to|post to|webhook|curl|wget|fetch this url)\b/i },
  { label: "tool-manipulation", pattern: /\b(run command|execute code|browse the web|open the link|call the tool|use the connector)\b/i }
];

export type PromptInjectionReview = {
  text: string;
  flagged: boolean;
  indicators: string[];
  suppressedLineCount: number;
};

export function reviewUntrustedEvidenceText(text: string): PromptInjectionReview {
  const indicators = new Set<string>();
  let suppressedLineCount = 0;

  const sanitizedLines = text
    .split(/\r?\n/)
    .map((line) => {
      const matched = instructionLikePatterns.filter(({ pattern }) => pattern.test(line));
      if (matched.length === 0) {
        return line;
      }

      suppressedLineCount += 1;
      for (const entry of matched) {
        indicators.add(entry.label);
      }
      return "[suppressed instruction-like content removed from untrusted evidence]";
    });

  return {
    text: sanitizedLines.join("\n"),
    flagged: indicators.size > 0,
    indicators: [...indicators],
    suppressedLineCount
  };
}

export function buildPromptInjectionWarning(flaggedDocuments: number): string | null {
  if (flaggedDocuments <= 0) {
    return null;
  }

  return `Suppressed instruction-like text from ${flaggedDocuments} retrieved excerpt(s) before LLM generation.`;
}
