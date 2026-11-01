"""Build-time only: hash-pinned official Apache-2.0 Paddle weights -> CPU ONNX.
Requires pinned paddlepaddle==3.3.1, paddle2onnx==2.1.0. Never run on customer input.
"""
import hashlib,json,subprocess,sys,urllib.request
from pathlib import Path
REVISION='d3b95a6dff5fe8a94f2748e12b61cb26818a0df8'
FILES={'inference.json':'3580978602f309c3554508dd85d4fe09b73a7e0d80d7f9e63258f5b72c390c69',
       'inference.pdiparams':'e8d6e7c5d264507e40e58a655779059d616b20d7441ea22047d829eb3931989c',
       'inference.yml':'9e195eb729a8173588cd0e8a852c8b373aa606e79e77b4ac7d8346f5426caf26'}
if __name__=='__main__':
    out=Path(sys.argv[1]);out.mkdir(parents=True,exist_ok=True)
    for name,digest in FILES.items():
        url=f'https://huggingface.co/PaddlePaddle/PP-LCNet_x1_0_doc_ori/resolve/{REVISION}/{name}'
        with urllib.request.urlopen(url,timeout=90) as response:data=response.read(8*1024*1024+1)
        if len(data)>8*1024*1024 or hashlib.sha256(data).hexdigest()!=digest:raise ValueError('model source hash mismatch')
        (out/name).write_bytes(data)
    subprocess.run(['paddle2onnx','--model_dir',str(out),'--model_filename','inference.json','--params_filename','inference.pdiparams','--save_file',str(out/'model.onnx'),'--opset_version','17'],check=True,timeout=180)
    model=(out/'model.onnx').read_bytes()
    if len(model)>16*1024*1024:raise ValueError('converted model exceeds bound')
    (out/'manifest.json').write_text(json.dumps({'model':'PP-LCNet_x1_0_doc_ori','license':'Apache-2.0','sourceRevision':REVISION,'sourceHashes':FILES,'converter':'paddle2onnx==2.1.0,paddlepaddle==3.3.1,opset17','onnxSha256':hashlib.sha256(model).hexdigest()}))
    for name in FILES:(out/name).unlink()
