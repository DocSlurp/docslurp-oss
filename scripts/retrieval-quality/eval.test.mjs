import test from "node:test";
import assert from "node:assert/strict";
import { score, normalize } from "./eval.mjs";
const premise = { documentId: "doc-a", pages: [3], quotes: ["office total 40"] };
const example = { id: "synthetic", kind: "explicit", premises: [premise] };
const hit = { text: "Office total 40", citation: { documentId: "doc-a", pageNumbers: [2, 3] } };
test("support needs text, document and PDF page together", () => {
 assert.equal(score(example, [hit]).correct, true);
 assert.equal(score(example, [{ ...hit, citation: { documentId: "wrong", pageNumber: 3 } }]).diagnosis, "citation_metadata");
 assert.equal(score(example, [{ ...hit, citation: { documentId: "doc-a", pageNumber: 2 } }]).correct, false);
 assert.equal(score(example, [{ ...hit, text: "office total 41" }]).correct, false);
});
test("top-k cutoff and joint premise rank", () => {
 const other = { documentId: "doc-a", pages: [9], quotes: ["minimum 10"] };
 const second = { text: "minimum 10", citation: { documentId: "doc-a", pageNumber: 9 } };
 const multi = { ...example, kind: "inferred", premises: [premise, other] };
 assert.equal(score(multi, [hit]).correct, false);
 assert.equal(score(multi, [hit, second]).reciprocalRank, 0.5);
 assert.equal(score(multi, [hit, second], 1).correct, false);
});
test("normalization preserves punctuation and rejects empty oracle", () => {
 assert.equal(normalize("ＯＦＦＩＣＥ\n total  40"), "office total 40");
 assert.throws(() => score({ ...example, premises: [{ ...premise, quotes: [""] }] }, [hit]));
});
test("empty retrieval never proves answer abstention", () => {
 assert.equal(score({ id: "negative", kind: "unanswerable" }, []).status, "requires_answer_abstention_review");
});

test("expanded parent pages do not masquerade as primary or source-trace page evidence", () => {
 const result = score(example, [hit]);
 assert.equal(result.correct, true);
 assert.equal(result.primaryPageCorrect, false);
 assert.equal(result.sourceTracePageCorrect, false);
 const source = score(example, [{ ...hit, citation: { ...hit.citation, sourceTrace: { pageNumbers: [3] } } }]);
 assert.equal(source.sourceTracePageCorrect, true);
 assert.equal(source.primaryPageCorrect, false);
});
