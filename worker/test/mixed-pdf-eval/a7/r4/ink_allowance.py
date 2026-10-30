"""Pre-authoring outline overhang allowance; never calibrated on candidate output."""
from fractions import Fraction
from math import ceil
from pathlib import Path
import sys

sys.path.insert(0, '/home/dan/data/docslurp-evals/mixed-pdf-fools-gold-handoffs/a7-clean-r2/generic')
from support import FONTS

def table_allowance(data, size):
    font = FONTS['mono']
    measurements = []
    for row in data:
        for text in row:
            if not text:
                continue
            run = font.run('allowance', text, [0, 0], size)
            ink_right = max(g['expectedInkPt'][2] for g in run if g['expectedInkPt'])
            advance = font.width(text, size)
            measurements.append({'literal':text, 'advancePt':advance,
                                 'rightOutlinePt':ink_right, 'overhangPt':max(0, ink_right-advance)})
    overhang = max(m['overhangPt'] for m in measurements)
    # Cover independent rounding of the paragraph/grid coordinate into twips
    # and hundredths mm, rather than relying on a lucky candidate coordinate.
    rounding = Fraction(72, 1440) + Fraction(72, 2540)
    # Native table rules reserve their inner half-stroke at the content clip.
    # Reserve that half-stroke as well as glyph overhang and coordinate rounding.
    half_rule = Fraction(35,200)  # 0.35 pt native rule / 2
    twips = ceil((Fraction(overhang)+half_rule+rounding)*20)
    native_hmm = round(Fraction(twips*2540,1440))
    assert round(Fraction(native_hmm*1440,2540))==twips
    return {'rightInsetHmm':native_hmm, 'rightInsetPt':float(Fraction(twips,20)),
            'maximumRightOverhangPt':overhang, 'coordinateRoundingBudgetPt':str(rounding),
            'nativeRuleHalfStrokePt':str(half_rule),'nativeInsetTwips':twips,
            'policy':'Same inset for all right-aligned cells; 4 pt physical border distances unchanged. No clip enlargement or font change.',
            'measurements':measurements}

def native_cell_placements(data, widths, size, padding, span, inset):
    """Right-align by actual font advance inside real native cells.

    Writer clips right-adjusted text to its rounded line width. Left paragraph
    placement keeps the full cell content clip while sharing a numeric anchor.
    No whitespace, extra glyph, widened box or altered advance is introduced.
    """
    result=[]
    for r,row in enumerate(data):
        for c,text in enumerate(row):
            if span and r==0 and c==2:continue
            center=span and r==0 and c==1
            align='center' if center else 'left' if c==0 else 'right'
            width=sum(widths[1:3]) if center else widths[c]
            desired=0 if align!='right' else width-2*padding-inset-FONTS['mono'].width(text,size)
            assert desired>=0
            twips=round(desired*20)
            hmm=round(Fraction(twips*2540,1440))
            assert round(Fraction(hmm*1440,2540))==twips
            name=chr(65+c-(1 if span and r==0 and c>=3 else 0))+str(r+1)
            result.append({'row':r,'column':c,'nativeName':name,'literal':text,'semanticAlignment':align,
                           'ParaAdjust':3 if center else 0,'ParaLeftMarginHmm':hmm,
                           'ParaRightMarginHmm':0,'leftIndentTwips':twips,
                           'unquantizedIndentPt':desired})
    return result
