#!/usr/bin/env python3
"""Score page retrieval separately from answers; missing responses fail closed."""
import argparse
import json
import math
from pathlib import Path
from dataset import digest, load_dataset, normalize, write_json


def finite_number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value >= 0


def score(dataset, scenario, run, ks=(1, 5, 10, 20)):
    if scenario["datasetSha256"] != dataset["versionSha256"] or run["datasetSha256"] != dataset["versionSha256"]:
        raise ValueError("Dataset version mismatch")
    if digest({k: v for k, v in scenario.items() if k != "versionSha256"}) != scenario["versionSha256"]:
        raise ValueError("Scenario content hash mismatch")
    if run["scenarioSha256"] != scenario["versionSha256"]:
        raise ValueError("Scenario version mismatch")
    queries = {q["id"]: q for q in dataset["queries"] if q["id"] in scenario["queryIds"]}
    if not queries or len(queries) != len(scenario["queryIds"]):
        raise ValueError("Missing or duplicate query labels")
    rows = {r["queryId"]: r for r in run["results"]}
    if len(rows) != len(run["results"]) or set(rows) != set(queries):
        raise ValueError("Responses must contain every scenario query exactly once")
    if not run.get("pipeline") or not run.get("index", {}).get("chunks"):
        raise ValueError("Pipeline configuration and actual index chunk count required")
    if run["index"].get("pages") != scenario["actualPages"] or run["index"].get("documents") != scenario["documentCount"]:
        raise ValueError("Indexed corpus counts do not match scenario")
    documents = {d["id"]: d for d in dataset["documents"] if d["id"] in scenario["documents"]}
    positive = negative = rubric_required = automatic_answers = all_documents_cited = 0
    hits = {k: 0 for k in ks}; recalls = {k: 0 for k in ks}; mrr = grounded = answers = citations = abstentions = false_abstentions = 0
    latencies, delivery, customer, per_query = [], [], [], []
    for id, q in queries.items():
        row = rows[id]
        if not isinstance(row.get("abstained"), bool) or not isinstance(row.get("hits"), list):
            raise ValueError("Explicit abstention boolean and ranked hits required: " + id)
        if not finite_number(row.get("latencyMs")):
            raise ValueError("Measured nonnegative latencyMs required: " + id)
        latencies.append(row["latencyMs"])
        def page_key(hit):
            doc, page = hit["document"], hit["page"]
            if doc not in documents or not isinstance(page, int) or isinstance(page, bool) or not 1 <= page <= documents[doc]["pages"]:
                raise ValueError("Invalid page reference: " + id)
            return (doc, page)
        # Multiple chunks on the same page do not consume extra page-level ranks.
        ranked = list(dict.fromkeys(page_key(h) for h in row["hits"]))
        cited = set(page_key(h) for h in row.get("citations", []))
        if q["answerable"]:
            if not q.get("relevant") or not normalize(q.get("expectedAnswer", "")):
                raise ValueError("Missing positive labels: " + id)
            positive += 1
            relevant = set(page_key(h) for h in q["relevant"])
            rank = next((i + 1 for i, hit in enumerate(ranked) if hit in relevant), None)
            mrr += 1 / rank if rank else 0
            for k in ks:
                matches = relevant.intersection(ranked[:k])
                hits[k] += bool(matches)
                recalls[k] += len(matches) / len(relevant)
            needs_review = bool(q.get("rubric"))
            rubric_required += needs_review
            automatic_answers += not needs_review
            answer_match = not needs_review and not row["abstained"] and normalize(q["expectedAnswer"]) in normalize(row.get("answer", ""))
            citation_match = bool(cited & relevant)
            required_docs = set(q.get("rubric", {}).get("requiredCitationDocuments", [])) if q.get("rubric") else {doc for doc, page in relevant}
            all_documents_cited += bool(required_docs) and required_docs.issubset({doc for doc, page in cited & relevant})
            answers += answer_match; citations += citation_match; grounded += answer_match and citation_match
            false_abstentions += row["abstained"]
            per_query.append({"queryId": id, "split": q.get("split", "development"), "challenges": q.get("challenges", []), "position": q.get("position"), "firstRelevantRank": rank, "answerSurfaceMatch": None if needs_review else answer_match, "rubricReviewRequired": needs_review, "citedSupportPage": citation_match})
        else:
            if q.get("relevant") or q.get("expectedAnswer") is not None:
                raise ValueError("Negative query must have no positive labels")
            negative += 1
            # Abstention cannot pass while still returning an asserted answer/citation.
            abstentions += row["abstained"] and not row.get("answer", "").strip() and not cited
            per_query.append({"queryId": id, "abstained": row["abstained"]})
        for key, values in [("deliveryUsd", delivery), ("customerUsd", customer)]:
            value = row.get(key)
            if value is not None and not finite_number(value):
                raise ValueError("Invalid cost: " + key)
            if value is not None:
                values.append(value)
    def ratio(n, d): return n / d if d else None
    def money(values): return {"totalUsd": sum(values) if len(values) == len(rows) else None, "recordedSubtotalUsd": sum(values), "knownQueries": len(values), "totalQueries": len(rows)}
    sorted_ms = sorted(latencies)
    return {"schema": "docslurp-large-retrieval-score-v1", "datasetSha256": dataset["versionSha256"],
            "scenarioSha256": scenario["versionSha256"], "runSha256": digest(run),
            "scope": {"pages": scenario["actualPages"], "documents": len(documents), "chunks": run["index"]["chunks"],
                      "positiveQueries": positive, "negativeQueries": negative, "heldOutGold": 0},
            "retrieval": {"hitRateAtK": {str(k): ratio(hits[k], positive) for k in ks},
                          "pageRecallAtK": {str(k): ratio(recalls[k], positive) for k in ks}, "mrr": ratio(mrr, positive)},
            "answer": {"surfaceMatchRate": ratio(answers, automatic_answers), "automaticallyScoredAnswers": automatic_answers, "rubricReviewRequired": rubric_required, "citedSupportPageRate": ratio(citations, positive),
                       "requiredDocumentsCitedRate": ratio(all_documents_cited, positive), "surfaceMatchWithCitationRate": ratio(grounded, automatic_answers), "negativeAbstentionRate": ratio(abstentions, negative),
                       "falseAbstentionRate": ratio(false_abstentions, positive),
                       "warning": "Exact normalized answer containment is not a semantic correctness judge; page overlap is not entailment."},
            "latencyMs": {"p50": sorted_ms[math.ceil(len(rows)*.5)-1], "p95": sorted_ms[math.ceil(len(rows)*.95)-1]},
            "queryCosts": {"delivery": money(delivery), "customer": money(customer)},
            "ingestionCosts": run.get("ingestionCosts", {"deliveryUsd": None, "customerUsd": None}),
            "pipeline": run["pipeline"], "perQuery": per_query}


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__)
    for name in ["dataset", "scenario", "run", "output"]: p.add_argument("--" + name, required=True)
    a = p.parse_args()
    report = score(load_dataset(a.dataset), json.loads(Path(a.scenario).read_text()), json.loads(Path(a.run).read_text()))
    write_json(a.output, report)
    print(json.dumps({"retrieval": report["retrieval"], "answer": report["answer"], "latencyMs": report["latencyMs"]}))
