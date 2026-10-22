#!/usr/bin/env python3
"""Preserve XLSX formula source and cached values; never recalculate formulas."""
import argparse
import posixpath
import zipfile
import xml.etree.ElementTree as ET

NS = {'s': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
      'r': 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'}
MAX_XML_BYTES = 32 * 1024 * 1024
MAX_FORMULAS = 100_000


def read_xml(archive, name):
    if archive.getinfo(name).file_size > MAX_XML_BYTES:
        raise ValueError('Workbook XML exceeds formula context limit')
    return ET.fromstring(_reject_doctype(archive.read(name)))


def _reject_doctype(data):
    """Refuse a DTD/entity declaration before parsing (entity-expansion DoS)."""
    head = data[:4096].upper()
    if b'<!DOCTYPE' in head or b'<!ENTITY' in head:
        raise ValueError('Workbook XML declares a DTD or entities')
    return data


def escape(value):
    return str(value).replace('\\', '\\\\').replace('|', '\\|').replace('\n', '<br>')


def formula_cells(archive, name):
    """Clear completed worksheet rows instead of retaining all cell XML.

    Keep each row intact until its end event so formula/cached-value children
    survive. XML byte and formula count limits still apply to the whole input.
    """
    if archive.getinfo(name).file_size > MAX_XML_BYTES:
        raise ValueError('Workbook XML exceeds formula context limit')
    with archive.open(name) as source:
        row_tag = '{%s}row' % NS['s']
        cell_tag = '{%s}c' % NS['s']
        formula_tag = '{%s}f' % NS['s']
        for _, element in ET.iterparse(source, events=('end',)):
            if element.tag == row_tag:
                for cell in element:
                    if cell.tag == cell_tag and cell.find(formula_tag) is not None:
                        yield cell
                element.clear()



def formula_context(filename):
    rows = []
    with zipfile.ZipFile(filename) as archive:
        workbook = read_xml(archive, 'xl/workbook.xml')
        relationships = read_xml(archive, 'xl/_rels/workbook.xml.rels')
        targets = {item.attrib['Id']: item.attrib['Target'] for item in relationships}
        for sheet in workbook.findall('s:sheets/s:sheet', NS):
            target = targets.get(sheet.attrib.get('{%s}id' % NS['r']))
            if not target:
                continue
            name = posixpath.normpath(target.lstrip('/') if target.startswith('/') else 'xl/' + target)
            if not name.startswith('xl/'):
                raise ValueError('Invalid worksheet path')
            for cell in formula_cells(archive, name):
                formula = cell.find('s:f', NS)
                if formula is None:
                    continue
                cached = cell.find('s:v', NS)
                expression = '=' + (formula.text or '') if formula.text else 'Shared/array formula reference (not expanded)'
                rows.append([sheet.attrib.get('name', ''), cell.attrib.get('r', ''), expression,
                             cached.text if cached is not None and cached.text is not None else 'Not cached',
                             cell.attrib.get('t', 'n')])
                if len(rows) > MAX_FORMULAS:
                    raise ValueError('Workbook exceeds formula context limit')
    return render_formula_rows(rows)


def render_formula_rows(rows):
    if not rows:
        return ''
    return '\n\n## Spreadsheet formula source\n\nFormulas are source expressions. Cached values were stored by the workbook author; they have not been recalculated.\n\n| Sheet | Cell | Formula | Cached value | XLSX value type |\n| --- | --- | --- | --- | --- |\n' + '\n'.join('| ' + ' | '.join(escape(value) for value in row) + ' |' for row in rows)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--input', required=True)
    args = parser.parse_args()
    print(formula_context(args.input))
