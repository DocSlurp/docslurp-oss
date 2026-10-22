#!/usr/bin/env python3
"""Preserve searchable OOXML context that flattened body extraction omits.

Never execute macros, evaluate formulas, follow external links or render charts.
ZIP/XML and output bounds are explicit. Values are source-authored metadata.
"""
import argparse
import posixpath
import re
import zipfile
from defusedxml import ElementTree as ET
from decimal import Decimal, DecimalException
from xlsx_formula_context import render_formula_rows, MAX_FORMULAS

MAX_PART_BYTES = 32 * 1024 * 1024
MAX_CONTEXT_BYTES = 64 * 1024 * 1024
MAX_OUTPUT_CHARS = 2_000_000
MAX_PARTS = 4096
S = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'


def local(tag):
    return tag.rsplit('}', 1)[-1]


def safe_text(value):
    return str(value).replace('\\', '\\\\').replace('|', '\\|').replace('\r', ' ').replace('\n', '<br>')


class Context:
    def __init__(self, archive):
        self.archive = archive
        self.read_bytes = 0
        self.output_chars = 0
        self.parts = []
        self.formula_rows = []

    def read(self, name):
        info = self.archive.getinfo(name)
        self.read_bytes += info.file_size
        if info.file_size > MAX_PART_BYTES or self.read_bytes > MAX_CONTEXT_BYTES:
            raise ValueError('Office context XML exceeds byte limit')
        data = self.archive.read(name)
        return ET.fromstring(data, forbid_dtd=True)

    def emit(self, kind, location, value):
        if value is None or value == '':
            return
        row = '| ' + ' | '.join(safe_text(v) for v in [kind, location, value]) + ' |'
        self.output_chars += len(row)
        if self.output_chars > MAX_OUTPUT_CHARS:
            raise ValueError('Office context exceeds output limit')
        self.parts.append(row)


def relationships(context, owner):
    name = posixpath.join(posixpath.dirname(owner), '_rels', posixpath.basename(owner) + '.rels')
    if name not in context.archive.namelist():
        return {}
    return {node.attrib.get('Id'): node.attrib for node in context.read(name)}


def target_part(owner, target):
    result = posixpath.normpath(target.lstrip('/') if target.startswith('/') else posixpath.join(posixpath.dirname(owner), target))
    if result.startswith('../') or result == '..':
        raise ValueError('Invalid Office relationship path')
    return result


def word_context(context, names):
    for name in names:
        if not re.fullmatch(r'word/(header\d*|footer\d*|comments)\.xml', name):
            continue
        root = context.read(name)
        for paragraph in root.iter('{%s}p' % W):
            text = ''.join(t.text or '' for t in paragraph.iter('{%s}t' % W))
            context.emit(local(root.tag), name, text)
    for relation in relationships(context, 'word/document.xml').values():
        if relation.get('Type', '').endswith('/hyperlink'):
            context.emit('hyperlink target', 'document', relation.get('Target'))


def spreadsheet_context(context, names):
    owner = 'xl/workbook.xml'
    workbook = context.read(owner)
    links = relationships(context, owner)
    formats = {9: '0%', 10: '0.00%'}
    cell_formats = []
    if 'xl/styles.xml' in names:
        styles = context.read('xl/styles.xml')
        for item in styles.findall('{%s}numFmts/{%s}numFmt' % (S, S)):
            formats[int(item.attrib['numFmtId'])] = item.attrib.get('formatCode', '')
        cell_formats = [formats.get(int(item.attrib.get('numFmtId', '0')), '')
                        for item in styles.findall('{%s}cellXfs/{%s}xf' % (S, S))]
    has_number_formats = any(cell_formats)
    for item in workbook.findall('{%s}definedNames/{%s}definedName' % (S, S)):
        context.emit('defined name', item.attrib.get('name', ''), item.text)
    for sheet in workbook.findall('{%s}sheets/{%s}sheet' % (S, S)):
        title = sheet.attrib.get('name', '')
        context.emit('sheet visibility', title, sheet.attrib.get('state', 'visible'))
        relation = links.get(sheet.attrib.get('{%s}id' % R), {})
        if not relation.get('Target') or relation.get('TargetMode') == 'External':
            continue
        part = target_part(owner, relation['Target'])
        # Read only small structural nodes and clear cell rows on their end event.
        info = context.archive.getinfo(part)
        context.read_bytes += info.file_size
        if info.file_size > MAX_PART_BYTES or context.read_bytes > MAX_CONTEXT_BYTES:
            raise ValueError('Office context XML exceeds byte limit')
        sheet_links = relationships(context, part)
        retained_tags = {'{%s}%s' % (S, name) for name in
                         ('row', 'hyperlink', 'dataValidation', 'mergeCell', 'autoFilter', 'pane')}
        formula_tag, value_tag = '{%s}f' % S, '{%s}v' % S
        with context.archive.open(part) as source:
            for _, node in ET.iterparse(source, events=('end',), forbid_dtd=True):
                if node.tag not in retained_tags:
                    continue
                kind = local(node.tag)
                if node.tag == '{%s}row' % S:
                    for cell in node:
                        formula = cell.find(formula_tag)
                        if formula is not None:
                            cached = cell.find(value_tag)
                            context.formula_rows.append([title, cell.attrib.get('r', ''),
                                '=' + formula.text if formula.text else 'Shared/array formula reference (not expanded)',
                                cached.text if cached is not None and cached.text is not None else 'Not cached',
                                cell.attrib.get('t', 'n')])
                            if len(context.formula_rows) > MAX_FORMULAS:
                                raise ValueError('Workbook exceeds formula context limit')
                        if not has_number_formats:
                            continue
                        style = int(cell.attrib.get('s', '0'))
                        code = cell_formats[style] if 0 <= style < len(cell_formats) else ''
                        value = cell.find(value_tag)
                        if code and value is not None and value.text:
                            location = title + '!' + cell.attrib.get('r', '')
                            context.emit('number format', location, code)
                            percent = re.fullmatch(r'0(?:\.(0+))?%', code)
                            if percent and len(percent.group(1) or '') <= 12:
                                try:
                                    number = Decimal(value.text)
                                    # Excel numbers fit IEEE doubles. Do not expand
                                    # hostile XML such as 1e999999 into huge text.
                                    if not number.is_finite() or abs(number.adjusted()) > 308:
                                        continue
                                    display = format(number * 100, '.' + str(len(percent.group(1) or '')) + 'f') + '%'
                                    context.emit('formatted percentage from stored value', location, display)
                                except DecimalException:
                                    pass
                    node.clear()
                elif node.tag == '{%s}hyperlink' % S:
                    link = sheet_links.get(node.attrib.get('{%s}id' % R), {})
                    context.emit('hyperlink target', title + '!' + node.attrib.get('ref', ''),
                                 link.get('Target') or node.attrib.get('location'))
                elif node.tag == '{%s}dataValidation' % S:
                    rules = '; '.join(local(child.tag) + '=' + (child.text or '') for child in node)
                    context.emit('validation ' + node.attrib.get('type', ''), title + '!' + node.attrib.get('sqref', ''), rules)
                elif node.tag in {'{%s}mergeCell' % S, '{%s}autoFilter' % S, '{%s}pane' % S}:
                    context.emit(kind, title, '; '.join(k + '=' + v for k, v in node.attrib.items()))
        for link in sheet_links.values():
            if link.get('TargetMode') == 'External' or not link.get('Target'):
                continue
            if link.get('Type', '').endswith('/comments'):
                comments = context.read(target_part(part, link['Target']))
                for comment in comments.iter('{%s}comment' % S):
                    text = ''.join(t.text or '' for t in comment.iter('{%s}t' % S))
                    context.emit('cell comment', title + '!' + comment.attrib.get('ref', ''), text)
            elif link.get('Type', '').endswith('/table'):
                table = context.read(target_part(part, link['Target']))
                context.emit('table', title + '!' + table.attrib.get('ref', ''), table.attrib.get('displayName') or table.attrib.get('name'))
    for name in names:
        if re.fullmatch(r'xl/charts/chart\d+\.xml', name):
            root = context.read(name)
            for node in root.iter():
                if local(node.tag) == 'title':
                    context.emit('chart title', name, ''.join(t.text or '' for t in node.iter() if local(t.tag) in {'t', 'v'}))
                elif local(node.tag) == 'f':
                    context.emit('chart source range', name, node.text)


def office_context(filename):
    with zipfile.ZipFile(filename) as archive:
        names = archive.namelist()
        if len(names) > MAX_PARTS:
            raise ValueError('Office archive exceeds context part limit')
        context = Context(archive)
        if 'docProps/core.xml' in names:
            for prop in context.read('docProps/core.xml'):
                context.emit('document property', local(prop.tag), prop.text)
        if 'word/document.xml' in names:
            word_context(context, names)
        elif 'xl/workbook.xml' in names:
            spreadsheet_context(context, names)
        else:
            return ''
        if not context.parts:
            return ''
        return (render_formula_rows(context.formula_rows) + '\n\n## Office source context\n\nSource-authored metadata and structural context; links were not fetched, charts were not rendered, and formulas were not recalculated.\n\n'
                '| Kind | Source location | Value |\n| --- | --- | --- |\n' + '\n'.join(context.parts))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--input', required=True)
    print(office_context(parser.parse_args().input))
