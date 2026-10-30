"""R2 noncandidate native controls; one isolated Writer process at a time."""
from pathlib import Path
import json
import subprocess
import sys
import hashlib
from datetime import datetime, timezone

ROOT=Path(__file__).resolve().parent
OUT=Path('/home/dan/data/docslurp-evals/mixed-pdf-fools-gold-a7/round4')
SCRATCH=Path('/home/dan/tmp/agents/a7-round3.3YAT1Y')

def launch(plan,directory,pipe):
    profile=SCRATCH/(pipe+'-profile')
    proc=subprocess.Popen(['/usr/bin/soffice','-env:UserInstallation='+profile.as_uri(),'--headless','--norestore','--nodefault',
                           '--nofirststartwizard','--accept=pipe,name='+pipe+';urp;StarOffice.ServiceManager'],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    try:
        result=subprocess.run(['/usr/bin/python3',str(ROOT/'writer_native.py'),pipe,str(plan),str(directory)],capture_output=True,text=True,timeout=120)
        (directory/(pipe+'.stdout.txt')).write_text(result.stdout);(directory/(pipe+'.stderr.txt')).write_text(result.stderr)
        print(result.stdout,result.stderr,flush=True);return result.returncode
    finally:
        proc.terminate()
        try:a,b=proc.communicate(timeout=10)
        except subprocess.TimeoutExpired:proc.kill();a,b=proc.communicate()
        (directory/(pipe+'.soffice.txt')).write_bytes(a+b)

def main():
    sequence=sys.argv[1] if len(sys.argv)>1 else '01'
    directory=OUT/'mechanism-setup';directory.mkdir(exist_ok=True)
    for name,size,leading,widths,rh,headers in [('compact',9,10.4766,[60,54,70.2,48.6],10.4766,1),
            ('wide',10,11.6407,[66.1,60,78,48],11.6407,1),('merged',10,11.6407,[81]*4,12.25,2)]:
        stem='control-'+sequence+'-'+name
        tabletop=128 if headers==1 else 308.641
        data=[['Run ID','Vol L','Time s','Q L/min']]+[['A0001','180','900','12.0']]*4 if headers==1 else [
            ['Plateau','Readings','','Mean temp'],['Run ID','Count','Sum K','Mean K']]+[['A0001','12000','3600000','300.0 K']]*6
        if name=='wide':data[0]=['Point','V mV','T K','T degC']
        objects=[dict(id='control.panel',kind='rect',rectPt=[32,469,580,701],fill=[.93,.95,.97],z=10),
                 dict(id='control.caption',kind='text',text='Aligned measurement columns',font='mono',sizePt=size,leadingPt=leading,color=[.08,.1,.12],framePt=[39,119,292,119+leading],z=20),
                 dict(id='control.table',kind='table',data=data,span=headers==2,rules=True,paddingPt=4,
                      columnWidthsPt=widths,rowHeightPt=rh,sizePt=size,leadingPt=leading,headerRows=headers,
                      headerFill=[.90,.94,.96],color=[.08,.1,.12],nativeTablePt=[39,tabletop,39+sum(widths),tabletop+rh*len(data)],z=20),
                 dict(id='control.fraction.bar',kind='path',pointsPt=[[320,430],[350,430]],color=[.08,.1,.12],widthPt=.45,z=20),
                 dict(id='control.fraction.top',kind='text',text='V',font='mono',sizePt=9,leadingPt=12,color=[.08,.1,.12],framePt=[330,417,345,429],z=20),
                 dict(id='control.fraction.bottom',kind='text',text='t',font='mono',sizePt=9,leadingPt=12,color=[.08,.1,.12],framePt=[330,429,345,441],z=20)]
        for i,(kind,sz,ld) in enumerate([('sans',10,14.7705),('sans',13,19.2017),('mono',9,11),('mono',10,11.6407),
                                          ('sans',8,10),('sans',9,13.2935),('mono',9,12),('mono',9,10.4766)]):
            y=470+i*25
            objects.append(dict(id=f'control.text{i}',kind='text',text='Agx09+/ K mV',font=kind,sizePt=sz,leadingPt=ld,
                                color=[.08,.1,.12],framePt=[39,y,300,y+ld],z=20))
        plan=dict(stem=stem,title='Native alignment and transparency control',author='Mechanism validation',objects=objects)
        path=directory/(stem+'.plan.json');assert not path.exists();path.write_text(json.dumps(plan,indent=2))
        code=launch(path,directory,'a7r3setup'+sequence+name)
        (directory/(stem+'.execution.json')).write_text(json.dumps({'observedAtUtc':datetime.now(timezone.utc).isoformat(),'candidate':False,
            'codeSha256':hashlib.sha256((ROOT/'writer_native.py').read_bytes()).hexdigest(),'exitCode':code},indent=2))
        if code:sys.exit(code)
        import pymupdf
        with pymupdf.open(directory/(stem+'.pdf')) as d:
            d[0].get_pixmap(dpi=150).save(directory/(stem+'.png'))
            for t in d[0].get_texttrace():print(t['font'],t['size'],t['chars'][0][2],''.join(chr(c[0]) for c in t['chars']))
            print('FILLS',[(list(x['rect']),x['fill']) for x in d[0].get_drawings() if x.get('fill')],flush=True)

if __name__=='__main__':main()
