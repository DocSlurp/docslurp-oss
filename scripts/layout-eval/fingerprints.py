"""Geometry and repeat-detection fingerprints from image pixels, without labels.

DHash is a cheap perceptual similarity signal, not identity or semantic recognition.
Exact RGB hash includes dimensions; compressed encodings of identical pixels agree.
"""
import hashlib
import math


def describe_region(image,region):
    from PIL import Image
    x0,y0,x1,y1=region['bbox']
    box=(max(0,math.floor(x0*image.width)),max(0,math.floor(y0*image.height)),
         min(image.width,math.ceil(x1*image.width)),min(image.height,math.ceil(y1*image.height)))
    crop=image.crop(box).convert('RGB')
    tiny=list(crop.convert('L').resize((9,8),Image.Resampling.BILINEAR).tobytes())
    bits=0
    for y in range(8):
        for x in range(8): bits=(bits<<1)|int(tiny[y*9+x]>tiny[y*9+x+1])
    exact=hashlib.sha256(f'{crop.width}x{crop.height}:RGB:'.encode()+crop.tobytes()).hexdigest()
    coverage=(x1-x0)*(y1-y0)
    output={'imageCoverage':coverage,'fingerprint':{'algorithm':'dhash-64','value':f'{bits:016x}'},'exactCropSha256':exact}
    if region['label'] in ('figure','photo','chart','logo','illustration'):
        output['coverageKind']='full-page' if coverage>=.9 else 'half-page' if coverage>=.4 else 'region'
    return output
