"""Necessary contract conditions checked before any candidate is authored.

This is not a scorer. A counterexample to a necessary condition stops the build;
passing these conditions cannot establish conformance.
"""
from __future__ import annotations
import argparse
import itertools
from pathlib import Path
from contract import SPEC, FONTS, family_plan, layout, save, tool_receipt


def baseline_ink(kind, size, literal, top=0):
    f = FONTS[kind]
    return [g for g in f.run('necessary', literal, [0, top+f.asc*size], size) if g['expectedInkPt']]


def inspect():
    findings = []
    for family in family_plan():
        d = layout(family)
        for b in d['blocks']:
            if not b.get('table_shape'): continue
            t = b['table_shape']
            widths = t['column_widths_pt']
            box = b['placement_container_pt']
            if abs(sum(widths) - (box[2]-box[0])) > .01:
                findings.append(dict(familyId=family['familyId'], block=b['id'], kind='table-width',
                    declaredWidth=sum(widths), envelopeWidth=box[2]-box[0]))
            if 'header_character_ranges' in t:
                # Use the shortest available glyph advance for a necessary lower bound.
                font = FONTS[b['typography']['font_class']]
                size = b['typography']['font_size_pt']
                smallest = min(font.glyph(c)[2]*size for c in 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789')
                for col, limits in enumerate(t['header_character_ranges']):
                    available = widths[col]-2*t['cell_padding_pt']
                    if limits[0]*smallest > available:
                        findings.append(dict(familyId=family['familyId'], block=b['id'], column=col,
                            kind='minimum-header-cannot-fit', required=limits[0]*smallest, available=available))
    return findings


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('output', type=Path)
    args=parser.parse_args()
    save(args.output/'tool-receipt.json',tool_receipt())
    result=dict(kind='necessary-conditions-only', formalBuildRoundsUsed=0,
                findings=inspect(), acceptanceDecision=None)
    save(args.output/'necessary-conditions.json',result)
    print(result)


if __name__=='__main__':main()
