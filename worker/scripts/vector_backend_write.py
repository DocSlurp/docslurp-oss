#!/usr/bin/env python3

import argparse
import json
import os
import sys
from urllib.parse import parse_qs, unquote, urlparse


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Write embedding records to a vector backend.")
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--backend", required=True, choices=["lancedb", "chroma", "milvus"])
    parser.add_argument("--collection", required=True)
    return parser.parse_args()


def load_payload(path: str) -> dict:
    with open(path, "r", encoding="utf-8") as handle:
        payload = json.load(handle)
    records = payload.get("records") or []
    if not records:
        raise SystemExit("vector input must contain records")
    return payload


def lancedb_target(raw: str) -> tuple[str, dict | None]:
    """Mirrors parseLanceDbUri in @docslurp/shared: LANCEDB_URI query overrides,
    then endpoint/region/credentials inherited from STORAGE_URI."""
    base, _, query = raw.partition("?")
    root = unquote(urlparse(base).path) if base.startswith("file://") else base.rstrip("/")
    if not root.startswith("s3://"):
        return root, None

    params = parse_qs(query)
    storage = urlparse(os.getenv("STORAGE_URI") or "")
    storage_params = parse_qs(storage.query)

    def pick(key: str, fallback: str = "") -> str:
        return (params.get(key) or storage_params.get(key) or [fallback])[0]

    options = {"region": pick("region", "us-west-2" if storage.scheme == "s3" else "auto")}
    endpoint = pick("endpoint")
    if endpoint and urlparse(endpoint).hostname == "minio" and not os.path.exists("/.dockerenv"):
        endpoint = endpoint.replace("//minio", "//localhost", 1)
    if endpoint:
        options["endpoint"] = endpoint
        options["allow_http"] = (params.get("allowHttp") or [str(endpoint.startswith("http://")).lower()])[0]
    if storage.username and storage.password:
        options["aws_access_key_id"] = unquote(storage.username)
        options["aws_secret_access_key"] = unquote(storage.password)
    return root, options


class UnsupportedEmbeddingMetadata(ValueError):
    pass


def assert_numeric_lance_table(table):
    # All vectors are supplied by our usage-accounted embedding stage. Never
    # restore arbitrary provider configuration from persisted table metadata.
    metadata = table.schema.metadata or {}
    if b"embedding_functions" in metadata or "embedding_functions" in metadata:
        raise UnsupportedEmbeddingMetadata("LanceDB worker refuses persisted embedding_functions metadata")


def write_lancedb(args: argparse.Namespace, payload: dict) -> dict:
    try:
        import lancedb  # type: ignore
    except ImportError as exc:
        raise SystemExit(f"missing dependency: pip install lancedb ({exc})")

    uri, storage_options = lancedb_target(os.getenv("LANCEDB_URI") or "/tmp/docslurp-lancedb")
    db = lancedb.connect(uri, storage_options=storage_options) if storage_options else lancedb.connect(uri)
    records = payload["records"]
    mode = "append"
    try:
        table = db.open_table(args.collection)
        assert_numeric_lance_table(table)
        table.add(records)
    except UnsupportedEmbeddingMetadata:
        raise
    except Exception:
        try:
            db.create_table(args.collection, data=records)
            mode = "create"
        except Exception:
            # Another worker may have created the org table after our open failed.
            table = db.open_table(args.collection)
            assert_numeric_lance_table(table)
            table.add(records)
    return {
        "backend": "lancedb",
        "collection": args.collection,
        "records": len(records),
        "uri": uri,
        "location": uri,
        "mode": mode,
    }


def write_chroma(args: argparse.Namespace, payload: dict) -> dict:
    try:
        import chromadb  # type: ignore
    except ImportError as exc:
        raise SystemExit(f"missing dependency: pip install chromadb ({exc})")

    url = os.getenv("CHROMA_URL")
    if url:
        parsed = urlparse(url)
        client = chromadb.HttpClient(host=parsed.hostname or "localhost", port=parsed.port or 8000)
        location = url
    else:
        path = os.getenv("CHROMA_PATH", "/tmp/docslurp-chroma")
        client = chromadb.PersistentClient(path=path)
        location = path

    collection = client.get_or_create_collection(args.collection)
    records = payload["records"]
    collection.upsert(
        ids=[record["id"] for record in records],
        embeddings=[record["vector"] for record in records],
        documents=[record["text"] for record in records],
        metadatas=[record.get("metadata", {}) for record in records],
    )
    return {"backend": "chroma", "collection": args.collection, "records": len(records), "location": location}


def write_milvus(args: argparse.Namespace, payload: dict) -> dict:
    try:
        from pymilvus import MilvusClient  # type: ignore
    except ImportError as exc:
        raise SystemExit(f"missing dependency: pip install pymilvus ({exc})")

    uri = os.getenv("MILVUS_URI", "http://localhost:19530")
    client = MilvusClient(uri=uri)
    records = payload["records"]
    dimension = len(records[0]["vector"])

    if not client.has_collection(collection_name=args.collection):
        client.create_collection(collection_name=args.collection, dimension=dimension)

    client.upsert(
        collection_name=args.collection,
        data=[
            {
                "id": record["id"],
                "document_id": record["documentId"],
                "chunk_index": record["chunkIndex"],
                "text": record["text"],
                "vector": record["vector"],
                "metadata": record.get("metadata", {}),
            }
            for record in records
        ],
    )
    return {"backend": "milvus", "collection": args.collection, "records": len(records), "uri": uri}


def main() -> int:
    args = parse_args()
    payload = load_payload(args.input)

    if args.backend == "lancedb":
        result = write_lancedb(args, payload)
    elif args.backend == "chroma":
        result = write_chroma(args, payload)
    else:
        result = write_milvus(args, payload)

    with open(args.output, "w", encoding="utf-8") as handle:
        json.dump(result, handle, indent=2)
        handle.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
