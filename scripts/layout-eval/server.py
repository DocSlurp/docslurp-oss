#!/usr/bin/env python3
"""Opt-in resident detector on IPv4 loopback. Models load once; raw images POST /layout.

Single-flight inference bounds resident work and avoids GPU contention. A client
cancellation does not cancel already-started model execution. No remote bind,
model downloads, credentials, or exposure through the public API is configured.
"""
import argparse
from http.server import BaseHTTPRequestHandler,HTTPServer
import json
import re
import time
from infer import MAX_INPUT_BYTES,add_detector_arguments,build_result,create_detector,encode_result,inference_profile_sha256


def make_handler(detector,device,threshold,model_load_ms):
    class Handler(BaseHTTPRequestHandler):
        protocol_version='HTTP/1.0'
        def setup(self):
            super().setup(); self.connection.settimeout(15)
        def send_bytes(self,status,data):
            self.send_response(status)
            self.send_header('Content-Type','application/json')
            self.send_header('Content-Length',str(len(data)))
            self.end_headers()
            try: self.wfile.write(data)
            except (BrokenPipeError,ConnectionResetError): pass
        def error(self,status,message):
            self.send_bytes(status,json.dumps({'error':message}).encode())
        def local_request(self):
            # Literal Host prevents DNS-rebinding access; no browser-origin client
            # is part of this local raw-byte service contract.
            if not re.fullmatch(r'127\.0\.0\.1(?::[0-9]{1,5})?',self.headers.get('Host','')) or self.headers.get('Origin') is not None:
                self.error(403,'Only literal loopback non-browser clients are supported');return False
            return True
        def do_GET(self):
            if not self.local_request():return
            if self.path!='/health': return self.error(404,'Not found')
            self.send_bytes(200,json.dumps({'ready':True,'model':detector.metadata,'device':device,'inferenceProfileSha256':inference_profile_sha256(detector,device,threshold),
              'modelLoadMs':model_load_ms,'execution':'single-flight-resident'}).encode())
        def do_POST(self):
            if not self.local_request():return
            if self.path!='/layout': return self.error(404,'Not found')
            if self.headers.get('Transfer-Encoding'): return self.error(400,'Chunked transfer unsupported; send Content-Length')
            try: length=int(self.headers.get('Content-Length','0'))
            except ValueError: return self.error(400,'Invalid Content-Length')
            if not 0<length<=MAX_INPUT_BYTES: return self.error(413,'Image must be between 1 byte and 25 MiB')
            try:
                data=self.rfile.read(length)
                if len(data)!=length: return self.error(400,'Incomplete image payload')
                result=build_result(detector,data,device,threshold)
                result['diagnostics']['execution']='warm-resident'
                result['diagnostics']['modelLoadMs']=model_load_ms
                self.send_bytes(200,encode_result(result))
            except (ValueError,OSError) as error:
                self.error(422,f'Image or detector output rejected: {type(error).__name__}')
            except Exception as error:
                # Avoid echoing host paths/model internals to the caller; preserve local logs.
                self.log_error('Detector failure: %r',error)
                self.error(500,f'Detector failed: {type(error).__name__}')
    return Handler


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port',type=int,default=8769)
    add_detector_arguments(parser); args=parser.parse_args()
    if not 1<=args.port<=65535: parser.error('Invalid port')
    start=time.perf_counter(); detector=create_detector(args); load_ms=1000*(time.perf_counter()-start)
    server=HTTPServer(('127.0.0.1',args.port),make_handler(detector,args.device,args.threshold,load_ms))
    print(json.dumps({'ready':True,'address':server.server_address,'modelLoadMs':load_ms,'model':detector.metadata,'device':args.device,'inferenceProfileSha256':inference_profile_sha256(detector,args.device,args.threshold)}),flush=True)
    try: server.serve_forever()
    except KeyboardInterrupt: pass
    finally: server.server_close()


if __name__=='__main__': main()
