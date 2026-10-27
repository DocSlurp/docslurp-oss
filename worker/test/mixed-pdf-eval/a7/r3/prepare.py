"""Record the user's explicit table-presentation override before freezing R2."""
from pathlib import Path
from datetime import datetime, timezone
import json
from author import PAGES

OUT=Path('/home/dan/data/docslurp-evals/mixed-pdf-fools-gold-a7/round3')

def main():
    receipt={'observedAtUtc':datetime.now(timezone.utc).isoformat(),'attempt':7,'formalRound':3,
             'authority':'Coordinator authorizes formal Round 3 only. Explicit user instruction replaces invalid Markdown-like printed tables with real native tabular layout.',
             'visibleTableSeparatorGlyphs':0,'markdownRole':'Extraction reference only; never passed to either native producer.',
             'preserved':['all observation IDs and typed numeric rows','units and formula ASTs','genuine E2 B1:C1 merged span and two header tiers',
                          'all table column widths, row heights and placement containers','nominal 9 pt B / 10 pt A-C Mono fonts and fixed leading',
                          'body, chart and math nominal fonts; full 9 pt displaced fraction scripts'],
             'presentationChanges':['all cells have 4 pt left/right insets','first column left-aligned; numeric columns right-aligned; shared fractional precision aligns decimal marks',
                                    'E2 Readings span centered over Count and Sum K','subdued blue-gray header band; 0.35 pt horizontal vector rules',
                                    'unit-bearing E1/E3 headers replace old compact placeholder labels','Writer tables are real body-owned TextTables; no paint-owning table frame'],
             'explicitDepartures':['Old literal pipe counts, separator-inclusive character counts and old per-header length limits are superseded by the user instruction.',
                                   'Old table word/character budgets are retained as diagnostics only where the new unit-bearing physical cell labels differ. No padding words are introduced.',
                                   'Horizontal cell padding changes from 0/1 pt to 4 pt. Existing grid widths, row heights, fonts and enclosing containers remain unchanged.',
                                   'Native horizontal rules have 0.175 pt half-stroke at outer row boundaries. This is recorded separately from glyph containment and is not an expanded text box.'],
             'nativeBaselineCalibration':{'WriterMono9':{'CharEscapement':13,'CharEscapementHeight':100},
                                          'WriterMono10':{'CharEscapement':12,'CharEscapementHeight':100},
                                          'purpose':'Retain hhea-derived expected glyph baselines without moving the physical table grid or shrinking fonts; constructed controls verify actual 9/10 pt glyphs.'},
             'tables':[{'familyId':p['familyId'],'headerRows':p['table'][:2 if p['classId']=='E2' else 1],
                        'semanticCells':31 if p['classId']=='E2' else 20,'nativeCellStringsContainMarkup':False} for p in PAGES],
             'e1EditorialRepairs':['Initial dryness limits carryover bias, but does not exclude collection loss.',
                                   'Equal initial head does not establish equal final levels; changing head remains unresolved.'],
             'scope':'six one-page PDFs plus three editable ODTs; no R4, bulk generation, canonical/permuted full pairs, model/API or source access'}
    path=OUT/'presentation-override.json';assert not path.exists();path.write_text(json.dumps(receipt,indent=2)+'\n')

if __name__=='__main__':main()
