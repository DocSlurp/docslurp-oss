"""Hold one unsaved blank document and UNO bridge until the parent closes stdin."""
import sys
from writer_native import connect,prop

desktop=connect(sys.argv[1])
document=desktop.loadComponentFromURL('private:factory/swriter','_blank',0,(prop('Hidden',True),))
if document is None:raise RuntimeError('No keeper document')
print('ready',flush=True)
sys.stdin.read()
document.close(True)
