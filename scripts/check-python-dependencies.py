"""Offline compatibility smoke for the supported document parser stack."""
import argparse
import importlib.metadata
import json
import tempfile
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--optional', action='store_true')
    args = parser.parse_args()
    import pymupdf
    import pymupdf4llm

    text = 'Document parser compatibility smoke.'
    with tempfile.TemporaryDirectory(prefix='docslurp-parser-smoke-') as directory:
        root = Path(directory)
        pdf = root / 'document.pdf'
        with pymupdf.open() as document:
            page = document.new_page()
            page.insert_text((72, 72), text)
            document.save(pdf)
        assert text in pymupdf4llm.to_markdown(str(pdf))
        packages = ['pymupdf', 'pymupdf4llm', 'pillow']
        if args.optional:
            from unstructured.partition.pdf import partition_pdf
            assert text in '\n'.join(str(element) for element in partition_pdf(filename=str(pdf), strategy='fast'))
            from docling.document_converter import DocumentConverter
            html = root / 'document.html'
            html.write_text(f'<html><body><p>{text}</p></body></html>')
            assert text in DocumentConverter().convert(html).document.export_to_markdown()
            # Check imports without model downloads, inference, or API calls.
            import torch
            import transformers
            from sentence_transformers import SentenceTransformer
            assert SentenceTransformer is not None
            packages += ['docling', 'unstructured', 'torch', 'transformers', 'sentence-transformers']
        print(json.dumps({'status': 'passed', 'versions': {name: importlib.metadata.version(name) for name in packages}}, sort_keys=True))


if __name__ == '__main__':
    main()
