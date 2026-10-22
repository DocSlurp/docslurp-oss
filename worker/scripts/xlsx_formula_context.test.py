import importlib.util
from pathlib import Path
import tempfile
import unittest
import zipfile
from defusedxml.common import DTDForbidden

spec = importlib.util.spec_from_file_location('formula_context', Path(__file__).with_name('xlsx_formula_context.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class FormulaContextTests(unittest.TestCase):
    def test_streaming_keeps_shared_formula_references_and_row_order(self):
        with tempfile.TemporaryDirectory() as directory:
            filename = Path(directory) / 'book.xlsx'
            with zipfile.ZipFile(filename, 'w') as archive:
                archive.writestr('xl/workbook.xml', '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Data" r:id="rId1"/></sheets></workbook>')
                archive.writestr('xl/_rels/workbook.xml.rels', '<Relationships><Relationship Id="rId1" Target="/xl/worksheets/sheet1.xml"/></Relationships>')
                archive.writestr('xl/worksheets/sheet1.xml', '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row><c r="A1"><f t="shared" si="0">B1*2</f><v>8</v></c></row><row><c r="A2"><f t="shared" si="0"/><v>10</v></c></row></sheetData></worksheet>'.encode('utf-16'))
            context = module.formula_context(filename)
            self.assertIn('| Data | A1 | =B1*2 | 8 | n |', context)
            self.assertIn('| Data | A2 | Shared/array formula reference (not expanded) | 10 | n |', context)
            self.assertLess(context.index('A1'), context.index('A2'))

    def test_rejects_dtd_in_tree_and_streaming_paths(self):
        for encoding in ('utf-8', 'utf-16'):
            for padding in ('', ' ' * 8192):
                for streaming in (False, True):
                    with self.subTest(encoding=encoding, padding=len(padding), streaming=streaming):
                        with tempfile.TemporaryDirectory() as directory:
                            filename = Path(directory) / 'hostile.xlsx'
                            with zipfile.ZipFile(filename, 'w') as archive:
                                archive.writestr('part.xml', (padding + '<!DOCTYPE root [<!ENTITY payload "expanded">]><root>&payload;</root>').encode(encoding))
                            with zipfile.ZipFile(filename) as archive:
                                with self.assertRaises(DTDForbidden):
                                    if streaming:
                                        list(module.formula_cells(archive, 'part.xml'))
                                    else:
                                        module.read_xml(archive, 'part.xml')

    def test_streaming_rejects_oversized_part(self):
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as directory:
            filename = Path(directory) / 'large.xlsx'
            with zipfile.ZipFile(filename, 'w') as archive:
                archive.writestr('part.xml', '<worksheet/>')
            with zipfile.ZipFile(filename) as archive, patch.object(module, 'MAX_XML_BYTES', 8):
                with self.assertRaisesRegex(ValueError, 'limit'):
                    list(module.formula_cells(archive, 'part.xml'))

    def test_preserves_formulas_coordinates_cached_values_and_types(self):
        with tempfile.TemporaryDirectory() as directory:
            filename = Path(directory) / 'book.xlsx'
            with zipfile.ZipFile(filename, 'w') as archive:
                archive.writestr('xl/workbook.xml', '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Revenue" r:id="rId1"/></sheets></workbook>')
                archive.writestr('xl/_rels/workbook.xml.rels', '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>')
                archive.writestr('xl/worksheets/sheet1.xml', '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row><c r="B4"><f>SUM(B2:B3)</f><v>200</v></c><c r="C4"><f>B4*2</f><v/></c><c r="D4" t="e"><f>1/0</f><v>#DIV/0!</v></c></row></sheetData></worksheet>')
            context = module.formula_context(filename)
            self.assertIn('| Revenue | B4 | =SUM(B2:B3) | 200 | n |', context)
            self.assertIn('| Revenue | C4 | =B4*2 | Not cached | n |', context)
            self.assertIn('| Revenue | D4 | =1/0 | #DIV/0! | e |', context)
            self.assertIn('have not been recalculated', context)


if __name__ == '__main__':
    unittest.main()
