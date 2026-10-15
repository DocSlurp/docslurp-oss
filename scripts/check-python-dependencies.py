"""Offline compatibility smoke for the supported document parser stack."""
import argparse
import importlib.metadata
import json
import tempfile
from pathlib import Path


def minimal_pdf(text: str) -> bytes:
    """One-page Helvetica PDF with a text layer, built by hand so no PDF library is needed."""
    stream = f'BT /F1 12 Tf 72 720 Td ({text}) Tj ET'.encode('latin-1')
    objects = [
        b'<< /Type /Catalog /Pages 2 0 R >>',
        b'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
        b'<< /Length %d >>\nstream\n' % len(stream) + stream + b'\nendstream',
        b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ]
    out, offsets = bytearray(b'%PDF-1.4\n'), []
    for number, body in enumerate(objects, 1):
        offsets.append(len(out))
        out += f'{number} 0 obj\n'.encode() + body + b'\nendobj\n'
    xref = len(out)
    out += f'xref\n0 {len(objects) + 1}\n0000000000 65535 f \n'.encode()
    out += b''.join(f'{offset:010d} 00000 n \n'.encode() for offset in offsets)
    out += f'trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n'.encode()
    return bytes(out)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--optional', action='store_true')
    args = parser.parse_args()
    import bs4, ebooklib, openpyxl, pptx, trafilatura, xlsx2csv  # noqa: F401
    from PIL import Image  # noqa: F401

    text = 'Document parser compatibility smoke.'
    with tempfile.TemporaryDirectory(prefix='docslurp-parser-smoke-') as directory:
        root = Path(directory)
        pdf = root / 'document.pdf'
        pdf.write_bytes(minimal_pdf(text))
        packages = ['beautifulsoup4', 'ebooklib', 'openpyxl', 'python-pptx', 'trafilatura', 'xlsx2csv', 'pillow']
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
