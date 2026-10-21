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
    'handwriting-lincoln-papers-andrew-telegram-1862': {
        'features': ['real-scan', 'genuine-handwriting', 'printed-form-metadata', 'signature', 'seal-stamp', 'archival-annotation'],
        'label_scope': 'all-visible-regions',
        'transcript_policy': 'Region text split from the Library of Congress By the People transcript; [* *] archival annotations kept without brackets. The pencil "1862" at right is a separate region although the transcript appends it to the Boston line.',
        'regions': [
            ('header', [980, 118, 1675, 172], 'Printed form heading.', 'United States Military Telegraph'),
            ('paragraph', [130, 90, 600, 350], 'Later pencil archival annotation (date), diagonal.', 'July 28 1862'),
            ('paragraph', [225, 195, 1195, 285], 'Printed form caption followed by handwritten time.', 'Time Received, Washington, 7.36 PM 28th'),
            ('seal', [1578, 172, 1762, 348], 'Library of Congress ownership stamp (red); stamp text not transcribed.', None),
            ('paragraph', [855, 290, 1745, 390], 'Handwritten origin and time.', 'Boston 7 35 PM 28th'),
            ('paragraph', [1568, 378, 1748, 452], 'Pencil archival annotation (year).', '1862'),
            ('paragraph', [100, 405, 1110, 550], 'Handwritten addressee line.', 'The Presdt of the US'),
            ('paragraph', [100, 528, 1772, 962], 'Handwritten message body.', 'I have the honor\nto acknowledge receipt of your\nTelegram I have sent full reply\nby mail'),
            ('paragraph', [745, 975, 1695, 1135], 'Handwritten signature.', 'John A. Andrew'),
            ('paragraph', [965, 1122, 1215, 1182], 'Handwritten charge note.', '17 Pd'),
            ('number', [98, 2246, 208, 2284], 'Stamped archival folio number.', '17296'),
        ],
        'excluded': ['Blank paper margins and the scan edge.'],
    },
    'handwriting-barton-diary-1906-12-15': {
        'features': ['real-scan', 'genuine-handwriting', 'diary', 'page-number', 'paragraph-boundaries'],
        'label_scope': 'all-visible-regions',
        'transcript_policy': 'Region text split from the Library of Congress By the People transcript at its paragraph indents; bracketed uncertain readings and blanks retained verbatim.',
        'regions': [
            ('number', [138, 138, 248, 202], 'Circled page number.', '31'),
            ('paragraph', [110, 200, 1345, 430], 'First diary paragraph.', 'Sat Sat Dec 15 - 1906 - In the morning\nprepared for a visit on sunday with Mrs\nA L Barber of Belmont.'),
            ('paragraph', [110, 452, 1472, 1535], 'Second paragraph, indented first line.', 'At three the large Auto mobile with Mrs\nBarber, A. L.  her daughter Mrs. Bertha\nBarber Mrs               and a friend\ncame for me - We drove first to [Canton Junc.]\nthen to train - then to Arlington - heads\nthrough all the zig zag streets of the Mall\nand home at night - found the pretty\ndaughter in law Mrs Katharine [ ]\nBarber, widow of the late son, an\nAustrian lady- the little Baby girl of 2\nMiss [Colkins] the home keeper - her mother\nan invalid up stairs, & the servants.'),
            ('paragraph', [118, 1560, 1378, 1812], 'Third paragraph, continues on the next page.', 'Supper - a pleasant evening - and a\nroom fit for a princess - To my amused\nastonishment 2 [ ] then all friends'),
        ],
        'excluded': ['Stray margin mark at right (x≈1535, y≈1060).'],
    },
    'handwriting-anthony-cash-account-1872': {
        'features': ['real-scan', 'genuine-handwriting', 'printed-ledger', 'two-page-spread', 'handwritten-table', 'struck-through-entries'],
        'label_scope': 'all-regions; table cells not annotated',
        'transcript_policy': 'Table text is the Library of Congress By the People transcript for each month, kept as lines; no cell-level row/column assignment is claimed.',
        'regions': [
            ('header', [195, 222, 832, 258], 'Printed page heading, left page.', 'CASH ACCOUNT. OCTOBER.'),
            ('header', [1003, 212, 1688, 248], 'Printed page heading, right page.', 'CASH ACCOUNT. NOVEMBER.'),
            ('table', [132, 268, 958, 1470], 'Printed ruled ledger (Date / Received / Paid) with handwritten entries, struck-through first line and totals; extent is the ruled area in use.', 'Date Received Paid\n8. N.Y. State R.Con 100\nPaid Sister M Lo. 100\n17 Mrs C S Lozier 45\nNational Life In.Co. 25\nMiss Larsen for meeting\nGrendine- Red silk- grey\ntraveling & black silk 44\nthread, lace & trimmings [15] 15\nMiss Barkus, Bonnet. 10\nRepub Fund to Balt & Phila\ndelphia Conventions 65\n2 slap jars 7\ndrilling, myrrh & sundries 5\nwashing & pressing winter dress 1.75\nmarking stamp 1.50\nLace- wash blouse [?] .75\nCarrie over\n210 210'),
            ('table', [962, 262, 1728, 1490], 'Printed ruled ledger, right page; entries occupy the upper third, ruled rows continue empty below.', 'Date Received Paid\nBrot forward\n11 dozen Pocket h\'ff\'s 2.50\nColoring beaver cloth sargne 1.75\nblue cashmere for Lasque 15\n26 Macedon Center 12.\ndebt- 7.25\n19.25 19.25'),
        ],
        'excluded': ['Book gutter and binding thread.', 'Cell-level structure (not annotated).'],
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
        if receipt.get('work_sha256'):
            if sha(work) != receipt['work_sha256']:
                raise ValueError(f'{identifier}: work raster differs from receipt')
        else:
            work = next(p for p in REAL.glob(identifier + '.*') if p.suffix in ('.png', '.jpg') and sha(p) == receipt['sha256'])
        image = out / 'images' / f'{identifier}.png'
        with Image.open(work) as im:
            if not image.exists():
                im.convert('L').save(image)
            width, height = im.size
        regions = []
        for index, region in enumerate(spec['regions']):
            label, box, note = region[:3]
            text = region[3] if len(region) > 3 else None
            if not (0 <= box[0] < box[2] <= width and 0 <= box[1] < box[3] <= height):
                raise ValueError(f'{identifier}: box outside raster {box}')
            regions.append({'id': f'm{index:03d}', 'label': label, 'bbox': box, 'polygon': poly(box), 'text': text, 'visibility': 1.0,
                            'reading_order': None, 'attributes': {'note': note, 'coordinate_space': 'work raster pixels (see metadata.work_sha256)',
                                                                  'annotationTier': 'manual-silver-agent-measured',
                                                                  'content_kind': 'handwriting' if identifier.startswith('handwriting-') and label in ('paragraph', 'table', 'number') and 'Printed' not in note and 'Stamped' not in note else 'print-or-mixed',
                                                                  'table_cells': 'not-annotated' if label == 'table' else 'not-applicable',
                                                                  'annotationConfidence': {'geometry': {'score': .5, 'status': 'agent-measured', 'basis': ['Boxes read against a 25-100 px coordinate grid on the exact work raster; not independently reviewed']},
                                                                                           'semanticLabel': {'score': .5, 'status': 'agent-assigned'},
                                                                                           'textTranscription': ({'score': .5, 'status': 'imported-crowd-reviewed', 'basis': ['Library of Congress By the People transcript (transcribed and reviewed by volunteers); region split and spot check by agent']}
                                                                                                                 if text else {'score': 0, 'status': 'unknown', 'reason': 'Embedded/printed text not transcribed'}),
                                                                                           'readingOrder': {'score': 0, 'status': 'unknown'}}}})
        ocr = REAL / f'{identifier}.ocr.txt'
        row = {'id': identifier, 'image_path': str(image), 'width': width, 'height': height, 'regions': regions, 'split': 'unassigned',
               'metadata': {'kind': 'real-rights-cleared-historic-page', 'source_cluster': identifier, 'source_family': identifier,
                            'document_id': receipt.get('archive_item_id'), 'declared_features': spec['features'],
                            'label_scope': spec['label_scope'], 'label_exclusions': spec['excluded'],
                            'scoring_policy': {'figure-regions-only': 'figure-class recall only; unlabeled text makes precision and all text classes non-scorable',
                                               'all-visible-regions': 'all region classes scorable at block level; silver geometry',
                                               'all-regions; table cells not annotated': 'region classes scorable; table structure/cells not scorable'}.get(spec['label_scope'], 'not scorable; reference only'),
                            'original_sha256': receipt['sha256'], 'work_sha256': receipt.get('work_sha256') or receipt['sha256'], 'image_png_sha256': sha(image),
                            'transcript_policy': spec.get('transcript_policy'),
                            'transcript_source_url': receipt.get('transcript_source_url'),
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
