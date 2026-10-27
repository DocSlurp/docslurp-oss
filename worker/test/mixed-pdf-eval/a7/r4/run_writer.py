"""Own one isolated Writer process; delegate its exact PID to the bound wrapper."""
from pathlib import Path
import json
import subprocess
import time
import traceback
import select
import psutil
from writer_export_wrapper import export_writer

SCRATCH=Path('/home/dan/tmp/agents/a7-round4.o790ttuh')

def launch(plan,directory,pipe,freeze):
    directory=Path(directory);profile=SCRATCH/(pipe+'-profile')
    assert not profile.exists()
    accept='--accept=pipe,name='+pipe+';urp;StarOffice.ServiceManager'
    proc=subprocess.Popen(['/usr/bin/soffice','-env:UserInstallation='+profile.as_uri(),'--headless','--norestore',
        '--nodefault','--nofirststartwizard',accept],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    converter=None;keeper=None
    try:
        for _ in range(100):
            try:family=[psutil.Process(proc.pid)]+psutil.Process(proc.pid).children(recursive=True)
            except psutil.Error:family=[]
            candidates=[]
            for child in family:
                try:
                    if child.name()=='soffice.bin' and accept in child.cmdline():candidates.append(child)
                except psutil.Error:pass
            if candidates:
                assert len(candidates)==1;converter=candidates[0];break
            time.sleep(.05)
        assert converter is not None,'No owned soffice.bin with the exact pipe argv'
        keeper=subprocess.Popen(['/usr/bin/python3','-B',str(Path(__file__).with_name('keeper_connection.py')),pipe],
                                stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
        assert select.select([keeper.stdout],[],[],15)[0],'No keeper bridge readiness'
        assert keeper.stdout.readline().strip()==b'ready','Keeper bridge failed'
        # A first-use profile can restart its bootstrap process. Bind only the
        # actual, ready converter owning this unique pipe after UNO readiness.
        ready=[]
        for candidate in psutil.process_iter(['name','cmdline']):
            try:
                if candidate.info['name']=='soffice.bin' and accept in (candidate.info['cmdline'] or []):ready.append(candidate)
            except psutil.Error:pass
        assert len(ready)==1,'Ready UNO pipe does not identify one native converter'
        converter=ready[0]
        export_writer(plan,directory,freeze,pipe,converter.pid)
        return 0
    except Exception:
        target=directory/(pipe+'.launcher-error.txt')
        assert not target.exists();target.write_text(traceback.format_exc())
        print(traceback.format_exc(),flush=True)
        return 1
    finally:
        if keeper is not None:
            if keeper.stdin:keeper.stdin.close();keeper.stdin=None
            try:ka,kb=keeper.communicate(timeout=5)
            except subprocess.TimeoutExpired:keeper.terminate();ka,kb=keeper.communicate(timeout=5)
            (directory/(pipe+'.keeper-log.txt')).write_bytes(ka+kb)
        if converter is not None:
            try:converter.terminate()
            except psutil.Error:pass
        proc.terminate()
        try:a,b=proc.communicate(timeout=10)
        except subprocess.TimeoutExpired:proc.kill();a,b=proc.communicate()
        (directory/(pipe+'.soffice-log.txt')).write_bytes(a+b)
