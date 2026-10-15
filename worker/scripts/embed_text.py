#!/usr/bin/env python3

import argparse
import json
import math
import os
import sys
import urllib.error
import urllib.request
from dataclasses import dataclass
from hashlib import sha256


LOCAL_MODEL_ALIASES = {
    "Xenova/all-MiniLM-L6-v2": "sentence-transformers/all-MiniLM-L6-v2",
    "Xenova/all-MiniLM-L12-v2": "sentence-transformers/all-MiniLM-L12-v2",
    "Xenova/paraphrase-multilingual-MiniLM-L12-v2": "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2",
    "Xenova/gte-small": "thenlper/gte-small",
    "Xenova/e5-small-v2": "intfloat/e5-small-v2",
    "Xenova/e5-base-v2": "intfloat/e5-base-v2",
    "Xenova/multilingual-e5-small": "intfloat/multilingual-e5-small",
    "Xenova/multilingual-e5-base": "intfloat/multilingual-e5-base",
    "Xenova/all-mpnet-base-v2": "sentence-transformers/all-mpnet-base-v2",
    "Xenova/jina-embeddings-v2-base-en": "jinaai/jina-embeddings-v2-base-en",
    "Xenova/bge-base-en-v1.5": "BAAI/bge-base-en-v1.5",
    "Xenova/bge-small-en-v1.5": "BAAI/bge-small-en-v1.5",
    "Xenova/bge-large-en-v1.5": "BAAI/bge-large-en-v1.5",
    "Xenova/bge-m3": "BAAI/bge-m3",
    "onnx-community/embeddinggemma-300m-ONNX": "google/embeddinggemma-300m",
}


@dataclass
class EmbedArgs:
    runtime: str
    provider: str
    model: str
    dimensions: int
    task: str
    batch_size: int
    normalize: bool


MODEL_CACHE: dict[str, object] = {}
MODEL_CACHE_DTYPE: dict[str, str] = {}

DEFAULT_LOCAL_EMBEDDING_DTYPE = "bfloat16"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate text embeddings.")
    parser.add_argument("--input")
    parser.add_argument("--output")
    parser.add_argument("--runtime", choices=["local", "remote"])
    parser.add_argument("--provider")
    parser.add_argument("--model")
    parser.add_argument("--dimensions", type=int, default=0)
    parser.add_argument("--task", default="document")
    parser.add_argument("--batch-size", type=int, default=32)
    parser.add_argument("--normalize", action="store_true")
    parser.add_argument("--stdio-server", action="store_true")
    return parser.parse_args()


def load_texts(path: str) -> list[str]:
    with open(path, "r", encoding="utf-8") as handle:
        payload = json.load(handle)
    texts = payload.get("texts") or []
    if not isinstance(texts, list) or not texts:
        raise SystemExit("embedding input must contain a non-empty 'texts' array")
    return [str(item) for item in texts]


def estimate_usage(texts: list[str]) -> dict:
    words = sum(len(text.split()) for text in texts)
    return {"estimated_tokens": int(words * 1.3)}


def resolve_local_model_dtype() -> str:
    value = os.getenv("DOCSLURP_LOCAL_EMBEDDING_DTYPE", DEFAULT_LOCAL_EMBEDDING_DTYPE).strip().lower()
    aliases = {
        "bf16": "bfloat16",
        "bfloat16": "bfloat16",
        "fp16": "float16",
        "float16": "float16",
        "fp32": "float32",
        "float32": "float32",
        "auto": "auto",
    }
    return aliases.get(value, DEFAULT_LOCAL_EMBEDDING_DTYPE)


def openai_embeddings(args: EmbedArgs, texts: list[str]) -> tuple[list[list[float]], dict]:
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise SystemExit("OPENAI_API_KEY is required for remote OpenAI embeddings")

    base_url = os.getenv("OPENAI_BASE_URL", "https://api.openai.com/v1").rstrip("/")
    payload = {
        "model": args.model,
        "input": texts,
    }
    if args.dimensions > 0:
        payload["dimensions"] = args.dimensions

    request = urllib.request.Request(
        f"{base_url}/embeddings",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request) as response:
            body = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        raise SystemExit(error.read().decode("utf-8"))

    vectors = [item["embedding"] for item in body.get("data", [])]
    usage = body.get("usage", {})
    return vectors, usage


def huggingface_remote(args: EmbedArgs, texts: list[str]) -> tuple[list[list[float]], dict]:
    try:
        from huggingface_hub import InferenceClient  # type: ignore
    except ImportError as exc:
        raise SystemExit(f"missing dependency: pip install huggingface_hub ({exc})")

    token = os.getenv("HF_TOKEN")
    client = InferenceClient(token=token)
    vectors = client.feature_extraction(texts, model=args.model)
    if vectors and isinstance(vectors[0], (int, float)):
        vectors = [vectors]
    return [truncate(vector, args.dimensions) for vector in vectors], estimate_usage(texts)


def load_local_model(model_name: str) -> tuple[object, bool, str]:
    if os.getenv("DOCSLURP_EMBED_TEXT_STUB") == "1":
        if model_name not in MODEL_CACHE:
            MODEL_CACHE[model_name] = {"stub": True, "name": model_name}
            MODEL_CACHE_DTYPE[model_name] = "stub"
            return MODEL_CACHE[model_name], False, "stub"
        return MODEL_CACHE[model_name], True, MODEL_CACHE_DTYPE.get(model_name, "stub")

    if model_name not in MODEL_CACHE:
        try:
            from sentence_transformers import SentenceTransformer  # type: ignore
        except ImportError as exc:
            raise SystemExit(f"missing dependency: pip install sentence-transformers ({exc})")

        preferred_dtype = resolve_local_model_dtype()
        tried_dtypes: list[str] = []
        for dtype in [preferred_dtype, "float32"]:
            if dtype in tried_dtypes:
                continue
            tried_dtypes.append(dtype)
            try:
                MODEL_CACHE[model_name] = SentenceTransformer(
                    model_name,
                    trust_remote_code=True,
                    model_kwargs={"torch_dtype": dtype},
                )
                MODEL_CACHE_DTYPE[model_name] = dtype
                return MODEL_CACHE[model_name], False, dtype
            except Exception:
                if dtype == "float32":
                    raise

        raise SystemExit(f"unable to load local embedding model: {model_name}")

    return MODEL_CACHE[model_name], True, MODEL_CACHE_DTYPE.get(model_name, resolve_local_model_dtype())


def stub_embeddings(texts: list[str], dimensions: int, normalize: bool) -> list[list[float]]:
    width = dimensions if dimensions > 0 else 8
    vectors: list[list[float]] = []
    for text in texts:
        digest = sha256(text.encode("utf-8")).digest()
        values = [((digest[i % len(digest)] / 255.0) * 2) - 1 for i in range(width)]
        if normalize:
            norm = math.sqrt(sum(value * value for value in values)) or 1.0
            values = [value / norm for value in values]
        vectors.append(values)
    return vectors


def local_embeddings(args: EmbedArgs, texts: list[str]) -> tuple[list[list[float]], dict]:
    model_name = LOCAL_MODEL_ALIASES.get(args.model, args.model)
    model, cache_hit, dtype = load_local_model(model_name)

    if os.getenv("DOCSLURP_EMBED_TEXT_STUB") == "1":
        vectors = stub_embeddings(texts, args.dimensions, args.normalize)
    else:
        vectors = model.encode(  # type: ignore[attr-defined]
            texts,
            batch_size=args.batch_size,
            normalize_embeddings=args.normalize,
            show_progress_bar=False,
        )
        vectors = [truncate(vector.tolist(), args.dimensions) for vector in vectors]

    usage = estimate_usage(texts)
    usage["runtime"] = "local"
    usage["cache_hit"] = cache_hit
    usage["worker_pid"] = os.getpid()
    usage["dtype"] = dtype
    return vectors, usage


def truncate(vector: list[float], dimensions: int) -> list[float]:
    if dimensions > 0 and len(vector) > dimensions:
        return vector[:dimensions]
    return vector


def to_embed_args(payload: dict) -> EmbedArgs:
    model = payload.get("model")
    if not isinstance(model, str) or not model.strip():
        raise ValueError("embedding model must be explicitly configured")
    return EmbedArgs(
        runtime=str(payload.get("runtime") or "local"),
        provider=str(payload.get("provider") or "transformers.js"),
        model=model.strip(),
        dimensions=int(payload.get("dimensions") or 0),
        task=str(payload.get("task") or "document"),
        batch_size=int(payload.get("batchSize") or payload.get("batch_size") or 16),
        normalize=bool(payload.get("normalize", False)),
    )


def embed(args: EmbedArgs, texts: list[str]) -> dict:
    if args.runtime == "remote" and args.provider == "openai":
        vectors, usage = openai_embeddings(args, texts)
    elif args.runtime == "remote":
        vectors, usage = huggingface_remote(args, texts)
    else:
        vectors, usage = local_embeddings(args, texts)

    if not vectors:
        raise SystemExit("embedding provider returned no vectors")

    return {
        "model": args.model,
        "dimensions": len(vectors[0]),
        "vectors": vectors,
        "usage": usage,
    }


def run_stdio_server() -> int:
    for line in sys.stdin:
        raw = line.strip()
        if not raw:
            continue

        req_id = None
        try:
            payload = json.loads(raw)
            req_id = payload.get("id")
            args = to_embed_args(payload.get("args") or {})
            texts = payload.get("args", {}).get("texts") or []
            if not isinstance(texts, list) or not texts:
                raise ValueError("embedding request must include a non-empty texts array")

            result = embed(args, [str(text) for text in texts])
            response = {"id": req_id, "result": result}
        except SystemExit as exc:
            response = {"id": req_id, "error": str(exc)}
        except Exception as exc:  # pragma: no cover - defensive server fallback
            response = {"id": req_id, "error": str(exc)}

        sys.stdout.write(json.dumps(response) + "\n")
        sys.stdout.flush()

    return 0


def main() -> int:
    cli_args = parse_args()

    if cli_args.stdio_server:
        return run_stdio_server()

    required = [cli_args.input, cli_args.output, cli_args.runtime, cli_args.provider, cli_args.model]
    if any(value is None for value in required):
        raise SystemExit("--input, --output, --runtime, --provider, and --model are required")

    texts = load_texts(str(cli_args.input))
    args = EmbedArgs(
        runtime=str(cli_args.runtime),
        provider=str(cli_args.provider),
        model=str(cli_args.model),
        dimensions=int(cli_args.dimensions),
        task=str(cli_args.task),
        batch_size=int(cli_args.batch_size),
        normalize=bool(cli_args.normalize),
    )
    payload = embed(args, texts)

    with open(str(cli_args.output), "w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2)
        handle.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
