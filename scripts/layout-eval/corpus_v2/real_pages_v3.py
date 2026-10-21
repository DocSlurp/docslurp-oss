#!/usr/bin/env python3
"""Admit rights-cleared real historic pages with explicitly scoped manual labels.

Real scans are not authored, so nothing here is construction gold. Two pages get
**figure-scope** manual silver: boxes for engravings, halftone photographs and a
comic strip, measured by the reviewing agent against a coordinate grid on the
exact work raster. Text regions are deliberately unlabeled, so these pages support
figure *recall* only; precision and text-class scores are not computable on them.
The third page is admitted as an unlabeled reference. Machine OCR is retained as
unreviewed evidence and is never treated as a transcript.
"""
import argparse
import datetime
import hashlib
import json
from pathlib import Path

from PIL import Image

REAL = Path('/home/dan/data/docslurp-evals/layout-corpus-v3/assets/real')

PAGES = {
    'historic-omaha-bee-1898-06-01-p1': {
        'features': ['real-scan', 'historic-print', 'column-rules', 'engraving', 'portrait-collage', 'masthead-engraving', 'dense-columns'],
        'label_scope': 'figure-regions-only',
        'regions': [
            ('illustration', [340, 640, 1062, 1058], 'Engraved portrait collage with name scrolls ("Prominent in promoting the exposition"); scroll lettering is embedded text, not transcribed.'),
            ('illustration', [640, 1886, 1396, 2384], 'Engraved collage of six governors with name scrolls; embedded lettering not transcribed.'),
            ('illustration', [1496, 712, 1792, 2395], 'Continuous right-hand column of oval portrait engravings, treated as one composite; individual portraits are not separate boxes.'),
            ('caption', [540, 1068, 862, 1094], 'Caption under the first collage.'),
            ('caption', [835, 1863, 1072, 1882], 'Caption above the governors collage.'),
        ],
        'excluded': ['Masthead engraving with title lettering (ambiguous header vs illustration; deliberately unlabeled).',
                     'Decorated initial "A" at the start of the lead story (ornament).',
                     'All text columns, headlines and datelines (out of label scope).'],
    },
    'historic-seattle-star-1915-05-08-p1': {
        'features': ['real-scan', 'historic-print', 'column-rules', 'halftone-photo', 'comic-strip', 'banner-headlines', 'dense-columns'],
        'label_scope': 'figure-regions-only',
        'regions': [
            ('photo', [912, 955, 1318, 1630], 'Halftone portrait photograph in a decorative frame.'),
            ('caption', [1058, 1636, 1172, 1654], 'Photo caption "Mrs. Anne Inglis."'),
            ('illustration', [72, 1995, 1310, 2340], 'Comic strip with title banner and speech balloons; balloon text is embedded and not transcribed.'),
        ],
        'excluded': ['Masthead and ear boxes (unlabeled).', 'All headlines, decks and text columns (out of label scope).'],
    },
    'historic-sf-call-1900-12-25-p1': {
        'features': ['real-scan', 'historic-print', 'column-rules', 'dense-columns'],
        'label_scope': 'none-unlabeled-reference',
        'regions': [],
        'excluded': ['No regions labeled; admitted as a rights-cleared unlabeled reference only.'],
    },
}


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def poly(b):
    return [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]]


def build(root, reviewed_at):
    root = Path(root)
    out = root / 'real-pages'
    (out / 'images').mkdir(parents=True, exist_ok=True)
    rows = []
    for identifier, spec in PAGES.items():
        receipt_path = REAL / f'{identifier}.receipt.json'
        receipt = json.loads(receipt_path.read_text())
        work = REAL / f'{identifier}.work.jpg'
        if sha(work) != receipt['work_sha256']:
            raise ValueError(f'{identifier}: work raster differs from receipt')
        image = out / 'images' / f'{identifier}.png'
        with Image.open(work) as im:
            if not image.exists():
                im.convert('L').save(image)
            width, height = im.size
        regions = []
        for index, (label, box, note) in enumerate(spec['regions']):
            if not (0 <= box[0] < box[2] <= width and 0 <= box[1] < box[3] <= height):
                raise ValueError(f'{identifier}: box outside raster {box}')
            regions.append({'id': f'm{index:03d}', 'label': label, 'bbox': box, 'polygon': poly(box), 'text': None, 'visibility': 1.0,
                            'reading_order': None, 'attributes': {'note': note, 'coordinate_space': 'work raster pixels (see metadata.work_sha256)',
                                                                  'annotationTier': 'manual-silver-agent-measured',
                                                                  'annotationConfidence': {'geometry': {'score': .5, 'status': 'agent-measured', 'basis': ['Boxes read against a 25-100 px coordinate grid on the exact work raster; not independently reviewed']},
                                                                                           'semanticLabel': {'score': .5, 'status': 'agent-assigned'},
                                                                                           'textTranscription': {'score': 0, 'status': 'unknown', 'reason': 'Embedded/printed text not transcribed'},
                                                                                           'readingOrder': {'score': 0, 'status': 'unknown'}}}})
        ocr = REAL / f'{identifier}.ocr.txt'
        row = {'id': identifier, 'image_path': str(image), 'width': width, 'height': height, 'regions': regions, 'split': 'unassigned',
               'metadata': {'kind': 'real-rights-cleared-historic-page', 'source_cluster': identifier, 'source_family': identifier,
                            'document_id': receipt.get('archive_item_id'), 'declared_features': spec['features'],
                            'label_scope': spec['label_scope'], 'label_exclusions': spec['excluded'],
                            'scoring_policy': 'figure-class recall only; unlabeled text makes precision and all text classes non-scorable' if regions else 'not scorable; reference only',
                            'original_sha256': receipt['sha256'], 'work_sha256': receipt['work_sha256'], 'image_png_sha256': sha(image),
                            'receipt_path': str(receipt_path), 'receipt_sha256': sha(receipt_path), 'license': receipt['license'],
                            'archive_item_id': receipt['archive_item_id'], 'source_page_url': receipt.get('source_page_url'),
                            'machine_ocr': {'path': str(ocr), 'sha256': sha(ocr), 'status': 'unreviewed machine OCR from the archive; not a transcript'} if ocr.exists() else None,
                            'review': {'reviewer': 'agent', 'reviewed_at': reviewed_at, 'method': 'full-page and gridded close-up inspection of the work raster',
                                       'human_adjudicated': False},
                            'review_status': 'manual-silver-figure-scope' if regions else 'unlabeled-reference'}}
        rows.append(row)
    (out / 'manifest.jsonl').write_text(''.join(json.dumps(r, ensure_ascii=False) + '\n' for r in rows))
    return rows


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--root', type=Path, required=True)
    p.add_argument('--reviewed-at', default=datetime.datetime.now(datetime.timezone.utc).isoformat())
    a = p.parse_args()
    rows = build(a.root, a.reviewed_at)
    print(json.dumps({r['id']: len(r['regions']) for r in rows}, indent=1))


if __name__ == '__main__':
    main()
