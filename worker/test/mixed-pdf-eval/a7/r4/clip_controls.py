"""Small content-free controls for full-outline loss and safe native insets."""
from pathlib import Path
from datetime import datetime, timezone
import json
from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from outline_clip_check import inspect
from copy import deepcopy
from export_binding import validate_plan_state

OUT=Path('/home/dan/data/docslurp-evals/mixed-pdf-fools-gold-a7/round4/mechanism-setup')

def main():
    pdfmetrics.registerFont(TTFont('OutlineControl','/usr/share/fonts/liberation/LiberationMono-Regular.ttf'))
    reports=[]
    images=OUT/"outline-validation-02";images.mkdir()
    for size in [9,10]:
        for clipped in [False,True]:
            path=images/('outline-'+str(size)+('-negative.pdf' if clipped else '-positive.pdf'))
            assert not path.exists()
            c=canvas.Canvas(str(path),pagesize=(612,792));c.setFont('OutlineControl',size)
            width=pdfmetrics.stringWidth('mV K','OutlineControl',size)
            if clipped:
                p=c.beginPath();p.rect(39,700, width-.175,30);c.clipPath(p,stroke=0,fill=0)
            c.drawString(39,710,'mV K');c.showPage();c.save()
            r=inspect(path);r['constructedNegative']=clipped
            assert r['completeForObservedMechanisms']
            assert r['noOutlineClipMisses'] != clipped
            if clipped:assert [g['text'] for g in r['glyphsOutsideActiveClips']]==['K']
            reports.append(r)
    native_mutations=[]
    for size in [9,10]:
        path=OUT/('bound-control-09c' if size==9 else 'bound-control-10c')/'constructed-bound-control.pdf'
        r=inspect(path)
        assert r['noOutlineClipMisses'],r['glyphsOutsideActiveClips']
        reports.append(r)
        plan=json.loads((path.parent/'control.plan.json').read_text())
        state=json.loads((path.parent/'constructed-bound-control.readback-reloaded.json').read_text())
        validate_plan_state(state,plan)
        changed=deepcopy(state)
        changed['tables'][0]['cellProperties']['C1']['paragraph']['ParaRightMargin']+=1
        try:validate_plan_state(changed,plan)
        except RuntimeError:native_mutations.append({'sizePt':size,'insetMutationDetected':True})
        else:raise AssertionError('Native inset mutation escaped')
    target=OUT/'outline-control-results.json';assert not target.exists()
    target.write_text(json.dumps({'observedAtUtc':datetime.now(timezone.utc).isoformat(),'candidate':False,'reports':reports,
                                 'negativeCasesDetected':2,'positiveCasesChecked':4,'fontSizesPt':[9,10],
                                 'nativeInsetMutations':native_mutations},indent=2)+'\n')
    print('Outline checker detects both constructed clipped tips; all four positives survive.')

if __name__=='__main__':main()
