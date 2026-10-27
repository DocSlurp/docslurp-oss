"""Noncandidate constructed glyph/table/path controls, separate from formal export."""
import json
import os
from pathlib import Path
import subprocess
import sys
from datetime import datetime, timezone
import hashlib

ROOT = Path(__file__).resolve().parent
OUT = Path('/home/dan/data/docslurp-evals/mixed-pdf-fools-gold-a7/round1/mechanism-setup')
SCRATCH = Path('/home/dan/tmp/agents/a7-round1.fzXoiR')

def launch(plan, directory, pipe):
    profile = SCRATCH / (pipe + '-profile')
    process = subprocess.Popen(['/usr/bin/soffice', '-env:UserInstallation=' + profile.as_uri(), '--headless', '--norestore',
                                '--nodefault', '--nofirststartwizard', '--accept=pipe,name=' + pipe + ';urp;StarOffice.ServiceManager'],
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        result = subprocess.run(['/usr/bin/python3', str(ROOT / 'writer_native.py'), pipe, str(plan), str(directory)],
                                capture_output=True, text=True, timeout=120)
        (directory / (pipe + '.stdout.txt')).write_text(result.stdout)
        (directory / (pipe + '.stderr.txt')).write_text(result.stderr)
        print(result.stdout, result.stderr)
        return result.returncode
    finally:
        process.terminate()
        try: stdout, stderr = process.communicate(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill(); stdout, stderr = process.communicate()
        (directory / (pipe + '.soffice-log.txt')).write_bytes(stdout + stderr)

def main():
    OUT.mkdir(parents=True, exist_ok=True)
    sequence = sys.argv[1] if len(sys.argv) > 1 else '01'
    objects = [dict(id='control.background', kind='rect', rectPt=[30, 450, 580, 650], fill=[.93,.95,.97], z=10),
               dict(id='control.line', kind='path', pointsPt=[[320,330],[400,300],[450,350]], color=[.2,.3,.4], widthPt=.6, z=20)]
    for i, (kind, size, leading) in enumerate([('sans', 10, 14.7705), ('sans',13,19.2017), ('mono',9,11), ('mono',10,11.6407),('sans',8,10),('sans',9,13.2935),('mono',9,12),('mono',9,10.4766)]):
        y = 40 + i * 45
        objects.append(dict(id=f'control.text.{i}', kind='text', text='Agx09|+/ K mV\nAgx09|+/ K mV',
                            font=kind, sizePt=size, leadingPt=leading, color=[.08,.1,.12], framePt=[39,y,300,y+2*leading],z=20))
    objects.append(dict(id='control.table', kind='table', framePt=[39,470,363,568],
                        sizePt=10,leadingPt=11.6407,rowHeightPt=12.25,columnWidthsPt=[81]*4,paddingPt=1,
                        data=[['Abcd','Efg hijk','','Lmno'],['Abcd','Efgh','Ijkl','Mnop']] + [['A0001','120','36000','300.0 K']]*6,
                        span=True,rules=True,color=[.08,.1,.12],z=20))
    objects.append(dict(id='control.table9', kind='table', framePt=[39,600,271.8,657],
                        sizePt=9,leadingPt=10.4766,rowHeightPt=10.4766,columnWidthsPt=[60,54,70.2,48.6],paddingPt=0,
                        data=[['Abcdef | ','Efgh | ','Ijklmno | ','Mnop']] + [['A0001 | ','120 | ','900 | ','12.0']]*4,
                        span=False,rules=False,color=[.08,.1,.12],z=20))
    objects.append(dict(id='control.rotated',kind='text',text='Residual (mK)',font='sans',sizePt=8,leadingPt=10,
                        framePt=[420,600,480,610],rotation=270,color=[.08,.1,.12],z=20))
    objects.append(dict(id='control.table10', kind='table', framePt=[39,400,291.1,460.2035],
                        sizePt=10,leadingPt=11.6407,rowHeightPt=11.6407,columnWidthsPt=[66.1,60,78,48],paddingPt=0,
                        data=[['Abcdef | ','Efgh | ','Ijklmno | ','Mnop']] + [['A0001 | ','200 | ','293 | ','19.9']]*4,
                        span=False,rules=False,color=[.08,.1,.12],z=20))
    objects.append(dict(id='control.indices',kind='text',text='n1*T1+n2*T2+n3*T3',font='mono',sizePt=9,leadingPt=12,
                        framePt=[320,400,500,412],color=[.08,.1,.12],z=20,
                        spans=[{'text':c,'dyPt':2 if c.isdigit() else 0} for c in 'n1*T1+n2*T2+n3*T3']))
    stem = 'control-' + sequence
    plan = dict(stem=stem, title='Constructed mechanism control',author='Mechanism validation',objects=objects)
    path = OUT / (stem + '.plan.json'); assert not path.exists(); path.write_text(json.dumps(plan,indent=2))
    code = launch(path, OUT, 'a7setup' + sequence)
    receipt = {'observedAtUtc':datetime.now(timezone.utc).isoformat(),'candidate':False,'exitCode':code,
               'writerCodeSha256':hashlib.sha256((ROOT/'writer_native.py').read_bytes()).hexdigest(),
               'planSha256':hashlib.sha256(path.read_bytes()).hexdigest()}
    (OUT/(stem + '.execution.json')).write_text(json.dumps(receipt,indent=2))
    if code: sys.exit(code)
    import fitz
    with fitz.open(OUT/(stem + '.pdf')) as doc:
        print('PAGES',len(doc))
        for trace in doc[0].get_texttrace():
            print(trace['font'],trace['size'],trace['chars'][0][2],''.join(chr(c[0]) for c in trace['chars']))
        doc[0].get_pixmap(dpi=150).save(OUT/(stem + '.png'))

if __name__ == '__main__': main()
