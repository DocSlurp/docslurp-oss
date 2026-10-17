import copy
import unittest
from dataset import digest, scenario
from score import score


class ScorerTests(unittest.TestCase):
    def setUp(self):
        self.dataset = {"versionSha256": "fixture", "documents": [{"id": "a", "pages": 10000}], "queries": [
            {"id": "positive", "answerable": True, "expectedAnswer": "needle", "relevant": [{"document": "a", "page": 5}]},
            {"id": "negative", "answerable": False, "expectedAnswer": None, "relevant": []}]}
        self.scenario = scenario(self.dataset, 10000)
        self.run = {"datasetSha256": "fixture", "scenarioSha256": self.scenario["versionSha256"],
                    "pipeline": {"mode": "hybrid"}, "index": {"chunks": 12000, "pages": 10000, "documents": 1}, "results": [
                        {"queryId": "positive", "hits": [{"document": "a", "page": 5}], "abstained": False, "answer": "needle", "citations": [{"document": "a", "page": 5}], "latencyMs": 4},
                        {"queryId": "negative", "hits": [], "abstained": True, "answer": "", "citations": [], "latencyMs": 8}]}

    def test_perfect_and_missing_cost_is_unknown(self):
        result = score(self.dataset, self.scenario, self.run)
        self.assertEqual(result["retrieval"]["mrr"], 1)
        self.assertEqual(result["answer"]["negativeAbstentionRate"], 1)
        self.assertIsNone(result["queryCosts"]["delivery"]["totalUsd"])

    def test_missing_query_is_not_silently_skipped(self):
        self.run["results"].pop()
        with self.assertRaises(ValueError): score(self.dataset, self.scenario, self.run)

    def test_missing_positive_label_fails(self):
        self.dataset["queries"][0]["relevant"] = []
        with self.assertRaises(ValueError): score(self.dataset, self.scenario, self.run)

    def test_wrong_document_does_not_count(self):
        self.run["results"][0]["hits"] = [{"document": "other", "page": 5}]
        with self.assertRaises(ValueError): score(self.dataset, self.scenario, self.run)

    def test_abstention_with_claim_does_not_pass(self):
        self.run["results"][1]["answer"] = "invented answer"
        self.assertEqual(score(self.dataset, self.scenario, self.run)["answer"]["negativeAbstentionRate"], 0)

    def test_repeated_chunks_do_not_consume_page_rank(self):
        self.run["results"][0]["hits"] = [{"document": "a", "page": 1}] * 10 + [{"document": "a", "page": 5}]
        self.assertEqual(score(self.dataset, self.scenario, self.run)["retrieval"]["mrr"], .5)

    def test_unmet_scale_fails(self):
        with self.assertRaisesRegex(ValueError, "unmet"): scenario(self.dataset, 50000)

    def test_changed_scenario_fails(self):
        self.scenario["actualPages"] = 50000
        with self.assertRaises(ValueError): score(self.dataset, self.scenario, self.run)

    def test_negative_latency_fails(self):
        self.run["results"][0]["latencyMs"] = -1
        with self.assertRaises(ValueError): score(self.dataset, self.scenario, self.run)

    def test_rubric_answers_require_review_not_surface_matching(self):
        self.dataset["queries"][0]["rubric"] = {"requiredCitationDocuments": ["a"]}
        report = score(self.dataset, self.scenario, self.run)
        self.assertIsNone(report["answer"]["surfaceMatchRate"])
        self.assertEqual(report["answer"]["rubricReviewRequired"], 1)
        self.assertEqual(report["answer"]["requiredDocumentsCitedRate"], 1)

    def test_incomplete_index_cannot_claim_full_scale(self):
        self.run["index"]["pages"] = 9999
        with self.assertRaises(ValueError): score(self.dataset, self.scenario, self.run)


if __name__ == "__main__": unittest.main()
