"""One content-free, noncandidate real-UNO binding/merge/illustration control."""
from pathlib import Path
import hashlib
import json
import shutil
import sys
from datetime import datetime,timezone
from thermal_logger import thermal_logger
from run_writer import launch
from ink_allowance import table_allowance, native_cell_placements

ROOT=Path(__file__).resolve().parent
OUT=Path('/home/dan/data/docslurp-evals/mixed-pdf-fools-gold-a7/round4/mechanism-setup')

def main():
    seq=sys.argv[1] if len(sys.argv)>1 else '01'
    target=OUT/('bound-control-'+seq);target.mkdir(parents=True)
    plan={'stem':'constructed-bound-control','title':'Native binding mechanism control','author':'Mechanism validation',
          'objects':[
              {'id':'control.text','kind':'text','text':'Agx09 K mV','font':'sans','sizePt':10,'leadingPt':14.7705,
               'color':[.08,.1,.12],'framePt':[39,40,300,54.7705],'z':20},
              {'id':'control.rotated','kind':'text','text':'Residual','font':'sans','sizePt':8,'leadingPt':10,
               'color':[.08,.1,.12],'framePt':[420,250,480,260],'rotation':270,'z':20},
              {'id':'control.table','kind':'table','data':[['Group','Readings','','Mean'],['ID','Count','Sum K','Mean K']]+
                   [['A0001','100','30000','300.0 K'] for _ in range(6)],'span':True,'rules':True,'paddingPt':4,
               'columnWidthsPt':[81,81,81,81],'rowHeightPt':12.25,'sizePt':10,'leadingPt':11.6407,
               'headerRows':2,'headerFill':[.90,.94,.96],'color':[.08,.1,.12],
               'nativeTablePt':[39,308.641,363,406.641],'z':20},
          ]}
    table=plan['objects'][-1]
    table['data']=[['Group','Values','','Mean'],['ID','mV','K','Mean K']]+[['A0001','100','30000','300.0 K'] for _ in range(6)]
    table['sizePt']=9 if seq.startswith('09') else 10
    table['leadingPt']=11 if table['sizePt']==9 else 11.6407
    allowance=table_allowance(table['data'],table['sizePt'])
    table['rightInkInsetPt']=allowance['rightInsetPt']
    table['inkAllowance']=allowance
    table['nativeCellPlacements']=native_cell_placements(table['data'],table['columnWidthsPt'],table['sizePt'],4,True,allowance['rightInsetPt'])
    pp=target/'control.plan.json';pp.write_text(json.dumps(plan,indent=2))
    sources=target/'source-snapshot';sources.mkdir()
    files={pp.name:hashlib.sha256(pp.read_bytes()).hexdigest()}
    for name in ['writer_native.py','export_binding.py','writer_export_wrapper.py','width_readback.py','run_writer.py','ink_allowance.py','outline_clip_check.py']:
        shutil.copyfile(ROOT/name,sources/name);files['source-snapshot/'+name]=hashlib.sha256((sources/name).read_bytes()).hexdigest()
    freeze=target/'CONTROL-FREEZE.json';freeze.write_text(json.dumps({'candidate':False,'createdAtUtc':datetime.now(timezone.utc).isoformat(),'files':files},indent=2))
    result=launch(pp,target,'a7r4boundcontrol'+seq,freeze)
    print('Content-free real-UNO control exit:',result,flush=True)
    if result:sys.exit(result)

if __name__=='__main__':main()
