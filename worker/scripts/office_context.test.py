import importlib.util
from pathlib import Path
import tempfile
import unittest
import zipfile
from defusedxml.common import DTDForbidden

spec = importlib.util.spec_from_file_location('office_context', Path(__file__).with_name('office_context.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class OfficeContextTests(unittest.TestCase):
    def extract(self, parts):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'source.zip'
            with zipfile.ZipFile(path, 'w') as archive:
                for name, value in parts.items():
                    archive.writestr(name, value)
            return module.office_context(path)

    def test_word_runs_headers_footers_metadata_and_links(self):
        text = self.extract({
            'word/document.xml': '<document/>',
            'word/header1.xml': f'<w:hdr xmlns:w="{module.W}"><w:p><w:r><w:t>Head</w:t></w:r><w:r><w:t>line</w:t></w:r></w:p></w:hdr>',
            'word/footer1.xml': f'<w:ftr xmlns:w="{module.W}"><w:p><w:r><w:t>Footer | value</w:t></w:r></w:p></w:ftr>',
            'docProps/core.xml': '<properties><subject>Review context</subject></properties>',
            'word/_rels/document.xml.rels': '<Relationships><Relationship Id="r1" Type="x/hyperlink" Target="https://example.test/" TargetMode="External"/></Relationships>',
        })
        self.assertIn('Headline', text)
        self.assertIn(r'Footer \| value', text)
        self.assertIn('Review context', text)
        self.assertIn('https://example.test/', text)

    def test_spreadsheet_relationships_and_validation(self):
        text = self.extract({
            'xl/workbook.xml': f'<workbook xmlns="{module.S}" xmlns:r="{module.R}"><sheets><sheet name="Data" state="hidden" r:id="r1"/></sheets><definedNames><definedName name="Area">Data!A1:B2</definedName></definedNames></workbook>',
            'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="r1" Target="worksheets/sheet1.xml"/></Relationships>',
            'xl/worksheets/sheet1.xml': f'<worksheet xmlns="{module.S}" xmlns:r="{module.R}"><sheetData><row><c r="A1"><v>1</v></c></row></sheetData><hyperlinks><hyperlink ref="B1" r:id="r2"/></hyperlinks><dataValidations><dataValidation type="list" sqref="B2"><formula1>"Yes,No"</formula1></dataValidation></dataValidations></worksheet>',
            'xl/worksheets/_rels/sheet1.xml.rels': '<Relationships><Relationship Id="r2" Type="x/hyperlink" Target="https://example.test/" TargetMode="External"/><Relationship Id="r3" Type="x/comments" Target="../comments/comment1.xml"/></Relationships>',
            'xl/comments/comment1.xml': f'<comments xmlns="{module.S}"><commentList><comment ref="A1"><text><t>Reviewer note</t></text></comment></commentList></comments>',
        })
        for expected in ['hidden', 'Area', 'Data!B1', 'https://example.test/', 'Yes,No', 'Data!A1', 'Reviewer note']:
            self.assertIn(expected, text)

    def test_rejects_dtd_in_tree_and_streaming_paths(self):
        for encoding in ('utf-8', 'utf-16'):
            for padding in ('', ' ' * 8192):
                for part in ('docProps/core.xml', 'xl/worksheets/sheet1.xml'):
                    with self.subTest(encoding=encoding, padding=len(padding), part=part):
                        parts = {
                            'xl/workbook.xml': f'<workbook xmlns="{module.S}" xmlns:r="{module.R}"><sheets><sheet name="Data" r:id="r1"/></sheets></workbook>',
                            'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="r1" Target="worksheets/sheet1.xml"/></Relationships>',
                            'xl/worksheets/sheet1.xml': f'<worksheet xmlns="{module.S}"/>',
                        }
                        parts[part] = (padding + '<!DOCTYPE root [<!ENTITY payload "expanded">]><root>&payload;</root>').encode(encoding)
                        with self.assertRaises(DTDForbidden):
                            self.extract(parts)

    def test_utf16_metadata_is_preserved(self):
        text = self.extract({
            'word/document.xml': '<document/>',
            'docProps/core.xml': '<properties><title>Résumé context</title></properties>'.encode('utf-16'),
        })
        self.assertIn('Résumé context', text)

    def test_parent_escape_is_rejected(self):
        with self.assertRaises(ValueError):
            module.target_part('xl/workbook.xml', '../../outside.xml')

    def test_oversized_xml_fails(self):
        limit = module.MAX_PART_BYTES
        try:
            module.MAX_PART_BYTES = 8
            with self.assertRaises(ValueError):
                self.extract({'word/document.xml':'<document/>', 'docProps/core.xml':'<properties><title>data</title></properties>'})
        finally:
            module.MAX_PART_BYTES = limit

    def test_combined_scan_preserves_formula_cache_and_percentage(self):
        text = self.extract({
            'xl/workbook.xml': f'<workbook xmlns="{module.S}" xmlns:r="{module.R}"><sheets><sheet name="Values" r:id="r1"/></sheets></workbook>',
            'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="r1" Target="worksheets/sheet1.xml"/></Relationships>',
            'xl/styles.xml': f'<styleSheet xmlns="{module.S}"><cellXfs><xf numFmtId="0"/><xf numFmtId="10"/></cellXfs></styleSheet>',
            'xl/worksheets/sheet1.xml': f'<worksheet xmlns="{module.S}"><sheetData><row><c r="A1" s="1"><f>1/4</f><v>0.25</v></c></row><row><c r="B2"><f t="shared" si="0"/><v>7</v></c><c r="C2" s="1"><v>1e999999</v></c></row></sheetData></worksheet>',
        })
        self.assertIn('| Values | A1 | =1/4 | 0.25 | n |', text)
        self.assertIn('Shared/array formula reference (not expanded) | 7', text)
        self.assertIn('25.00%', text)
        self.assertLess(len(text), 5000)
        self.assertIn('have not been recalculated', text)


if __name__ == '__main__':
    unittest.main()
