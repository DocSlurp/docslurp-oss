"""Bounded local-only thumbnail scan. Stdlib only; media never leaves the process.

Candidate timestamps use ffmpeg's uniform fps output timeline. They are approximate
sample positions, not proof of a cut or complete temporal/semantic coverage.
"""
import argparse
from collections import deque
import json
import math
import subprocess


def scan(source, duration, fps):
    if not 0 < duration <= 7200 or not 0 < fps <= 10 or duration * fps > 14400.01:
        raise ValueError('Invalid scan bounds')
    size = 96 * 54
    command = ['ffmpeg', '-nostdin', '-v', 'error', '-threads', '1', '-protocol_whitelist', 'file,pipe',
               '-format_whitelist', 'mov,matroska,webm,avi', '-i', source, '-t', str(duration),
               '-map', '0:v:0', '-an', '-sn', '-dn', '-vf', f'fps={fps},scale=96:54',
               '-pix_fmt', 'gray', '-threads', '1', '-f', 'rawvideo', 'pipe:1']
    rows, history = [], deque()
    with subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL) as proc:
        try:
            while len(rows) < math.ceil(duration * fps):
                frame = proc.stdout.read(size)
                if not frame:
                    break
                if len(frame) != size:
                    raise ValueError('Truncated scan frame')
                t = len(rows) / fps
                while len(history) > 1 and history[1][0] <= t - .5:
                    history.popleft()
                delta = area = tile = hist = 0.0
                if history:
                    old_t, old = history[0]
                    scale = min(1, .5 / max(.001, t - old_t)) / 255
                    diffs = [abs(a-b) * scale for a,b in zip(frame, old)]
                    delta = sum(diffs)/size
                    area = sum(d > .1 for d in diffs)/size
                    tiles = [0.0]*48
                    for i,d in enumerate(diffs):
                        tiles[(i//96//9)*8 + i%96//12] += d/108
                    tile = max(tiles)
                    a,b = [0]*16,[0]*16
                    for x,y in zip(frame,old):
                        a[x//16]+=1; b[y//16]+=1
                    hist = sum(abs(x-y) for x,y in zip(a,b))/(2*size)
                rows.append([round(t,6),round(delta,5),round(area,5),round(tile,5),round(hist,5)])
                history.append((t,frame))
            # Read EOF before wait so an unexpected extra packet cannot block the child.
            if proc.stdout.read(1):
                raise ValueError('Scan exceeded candidate ceiling')
            if proc.wait(timeout=10):
                raise ValueError('Video decoder failed')
        finally:
            if proc.poll() is None:
                proc.kill(); proc.wait()
    if not rows:
        raise ValueError('No video candidates')
    return rows


if __name__ == '__main__':
    p=argparse.ArgumentParser();p.add_argument('--source',required=True);p.add_argument('--duration',type=float,required=True);p.add_argument('--fps',type=float,required=True)
    args=p.parse_args()
    print(json.dumps(scan(args.source,args.duration,args.fps),separators=(',',':')))
