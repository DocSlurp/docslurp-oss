"""Project validated v4 authoring into extraction references without reauthoring gold.

This is a format adapter, not an acceptance gate. Callers must first validate the
immutable authoring/transform records and the independent corpus approval receipt.
"""
import copy


def table_rows(cells):
    """Keep merged-cell text at its origin; covered cells remain empty."""
    height = max(c['row'] + c['rowSpan'] for c in cells)
    width = max(c['column'] + c['columnSpan'] for c in cells)
    rows = [[''] * width for _ in range(height)]
    occupied = set()
    for cell in cells:
        r, c = cell['row'], cell['column']
        if min(r, c) < 0 or min(cell['rowSpan'], cell['columnSpan']) < 1:
            raise ValueError('invalid-table-cell')
        for y in range(r, r + cell['rowSpan']):
            for x in range(c, c + cell['columnSpan']):
                if (y, x) in occupied:
                    raise ValueError('overlapping-table-cells')
                occupied.add((y, x))
        rows[r][c] = cell['displayText']
    if len(occupied) != height * width:
        raise ValueError('incomplete-table-grid')
    return rows


def page_reference(page):
    blocks = {b['id']: b for b in page['blocks']}
    order = page['readingOrder']
    if len(blocks) != len(page['blocks']) or len(order) != len(set(order)):
        raise ValueError('duplicate-reference-id')
    expected_ids = {b['id'] for b in blocks.values() if b['visible'] and b['displayText']}
    if set(order) != expected_ids:
        raise ValueError('incomplete-visible-reading-order')
    ordered = [blocks[i] for i in order]
    sections = [b['displayText'] for b in ordered]
    if page['sections'] != sections or page['paragraphs'] != sections:
        raise ValueError('inconsistent-authoring-projection')
    if page['expectedMarkdown'] != '\n\n'.join(sections):
        raise ValueError('inconsistent-visible-markdown')
    formulas = [b['formula'] for b in ordered if b['formula'] is not None]
    occurrences=[];offset=0
    for block in ordered:
        literal=block['displayText']
        if block['formula'] is not None:
            printed=block['formula']['display']
            if literal.count(printed)!=1:
                raise ValueError('ambiguous-authored-formula-occurrence')
            start=offset+literal.index(printed)
            occurrences.append(dict(blockId=block['id'],start=start,end=start+len(printed),text=printed))
        offset+=len(literal)+2
    return {
        'printedFormulaOccurrences': occurrences,
        'pageId': page.get('pageId', page.get('id')),
        'expectedMarkdown': page['expectedMarkdown'],
        'sections': sections,
        'paragraphs': list(sections),
        'tables': [{'rows': table_rows(b['cells']), 'cells': copy.deepcopy(b['cells'])}
                   for b in ordered if b['cells']],
        'formulas': [f['latex'] for f in formulas],
        'printedFormulas': [f['display'] for f in formulas],
        'typedFormulas': copy.deepcopy(formulas),
        'excludedText': [b['displayText'] for b in blocks.values()
                         if not b['visible'] and b['displayText']],
        'readingOrder': list(order),
        'blocks': copy.deepcopy(page['blocks']),
        'bbox': [0, 0, *page['sizePt']],
    }
