"""Bounded encoding-equivalence scoring; occurrence/visibility remain separate.

Read one JSON request from stdin: reference/candidate strings plus optional
referenceEncoding/candidateEncoding, or a list of such objects in pairs.
Unsupported expressions have a null score, never a perfect aggregate.
"""
import hashlib
import json
from pathlib import Path
import platform
import sys

MAX_REQUEST_BYTES = 131072
MAX_PAIRS = 32
VERSION = "math-encoding-equivalence@v1"


def score_request(request):
    import math_encodings

    if not isinstance(request, dict):
        raise ValueError("request must be an object")
    if "pairs" in request:
        pairs = request["pairs"]
    else:
        pairs = [request]
    if not isinstance(pairs, list) or not 1 <= len(pairs) <= MAX_PAIRS:
        raise ValueError("pairs must contain between 1 and 32 expressions")
    results = []
    seen = set()
    for index, pair in enumerate(pairs):
        if not isinstance(pair, dict):
            raise ValueError("each pair must be an object")
        pair_id = pair.get("id", str(index))
        if not isinstance(pair_id, str) or not pair_id or len(pair_id) > 128:
            raise ValueError("pair id must be a nonempty string of at most 128 characters")
        if pair_id in seen:
            raise ValueError("duplicate pair id")
        seen.add(pair_id)
        if not all(isinstance(pair.get(key), str) for key in ("reference", "candidate")):
            raise ValueError("reference and candidate must be strings")
        reference_encoding = pair.get("referenceEncoding", "auto")
        candidate_encoding = pair.get("candidateEncoding", "auto")
        if not isinstance(reference_encoding, str) or not isinstance(candidate_encoding, str):
            raise ValueError("encodings must be strings")
        result = math_encodings.compare_math(
            pair["reference"], pair["candidate"],
            expected_encoding=reference_encoding, actual_encoding=candidate_encoding,
        )
        results.append({"id": pair_id, **result})
    complete = all(result["supported"] is True for result in results)
    return {
        "version": VERSION,
        "normalizerVersion": math_encodings.VERSION,
        "scope": "encoding-equivalence-only",
        "score": min(result["score"] for result in results) if complete else None,
        "encodingEvidenceComplete": complete,
        "supportedPairs": sum(result["supported"] is True for result in results),
        "totalPairs": len(results),
        "pairs": results,
        "acceptanceEvidenceComplete": False,
        "blockingEvidence": ["formula-occurrence-ownership", "formula-visibility"],
        "identity": {
            "python": platform.python_version(),
            "scorerSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
            "normalizerSha256": hashlib.sha256(Path(math_encodings.__file__).read_bytes()).hexdigest(),
        },
    }


def main():
    try:
        raw = sys.stdin.buffer.read(MAX_REQUEST_BYTES + 1)
        if len(raw) > MAX_REQUEST_BYTES:
            raise ValueError("request exceeds 128 KiB")
        request = json.loads(raw)
        result = score_request(request)
    except (ValueError, TypeError, RecursionError) as error:
        print(json.dumps({"error": str(error), "version": VERSION}), file=sys.stderr)
        return 2
    print(json.dumps(result, allow_nan=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
