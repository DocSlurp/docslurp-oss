/**
 * Output-contract clauses that keep generated statements as certain, as
 * conditional and as directed as the source text. They name only general
 * linguistic categories; adding document-, field- or value-specific wording
 * here would leak evaluation inputs into production prompts.
 */
export const SOURCE_FIDELITY_RULES = [
  "Keep each statement exactly as certain as the source: proposals, plans, requests, estimates, possibilities and reported claims stay marked as such and are never restated as completed or confirmed outcomes.",
  "Keep conditions, exceptions, limits and negation attached to what they qualify.",
  "Name who said, decided or did something only when the source does, and resolve a pronoun only to a referent the text states.",
  "Do not add implied or inferred facts; when unsure, omit the detail or keep the source's hedge.",
].join(" ");

/** Graph-specific clause: qualifiers and direction travel in the free-text predicate. */
export const GRAPH_FIDELITY_RULES = [
  "Read `subject predicate object` aloud: it must be a true sentence in that direction, so the subject is the party that acts or holds the relation.",
  "Put modality, negation and conditions in the predicate (for example a proposed, estimated, possible, denied or conditional relation), keeping it concise without dropping necessary qualifiers.",
  "Omit a relationship when its direction or certainty cannot be stated from the text.",
].join(" ");
