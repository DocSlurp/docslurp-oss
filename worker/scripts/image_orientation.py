"""Offline CPU orientation for document rasters. Called only inside the confined VM.
Originals are immutable; output is a lossless PNG derivative. Model policy is opt-in,
not calibrated for arbitrary photographs/diagrams. No OCR or arbitrary-angle deskew.
"""
import hashlib
import json
import math
import os
from pathlib import Path

MODEL_ID = 'PP-LCNet_x1_0_doc_ori'
MODEL_PATH = Path('/opt/docslurp/orientation/model.onnx')
MAX_PIXELS = 16_000_000
MAX_BYTES = 32 * 1024 * 1024
MIN_CONFIDENCE = 0.90
MIN_MARGIN = 0.50


def decision(scores):
    if len(scores) != 4 or any(not math.isfinite(float(x)) or not 0 <= x <= 1 for x in scores) or abs(sum(scores) - 1) > .01:
        raise ValueError('invalid orientation probabilities')
    ranking = sorted(range(4), key=lambda i: scores[i], reverse=True)
    top, second = ranking[:2]
    confidence, margin = float(scores[top]), float(scores[top] - scores[second])
    angle = top * 90
    return angle, confidence, margin, confidence >= MIN_CONFIDENCE and margin >= MIN_MARGIN


def normalize(source, output, model_path=MODEL_PATH):
    # Set before loading BLAS/runtime; keep model inference at one CPU thread.
    os.environ['OPENBLAS_NUM_THREADS'] = '1'
    os.environ['OMP_NUM_THREADS'] = '1'
    import numpy as np
    import onnxruntime as ort
    from PIL import Image, ImageOps
    Image.MAX_IMAGE_PIXELS = MAX_PIXELS
    manifest = json.loads(model_path.with_name('manifest.json').read_text())
    if manifest['model'] != MODEL_ID or hashlib.sha256(model_path.read_bytes()).hexdigest() != manifest['onnxSha256']:
        raise ValueError('orientation model hash mismatch')
    if Path(source).stat().st_size > MAX_BYTES:
        raise ValueError('orientation input exceeds byte limit')
    with Image.open(source) as image:
        if image.format not in ('PNG', 'JPEG', 'WEBP') or getattr(image, 'n_frames', 1) != 1:
            raise ValueError('unsupported orientation raster')
        width, height = image.size
        if width < 1 or height < 1 or width * height > MAX_PIXELS:
            raise ValueError('orientation pixel limit')
        # Classify displayed pixels, after EXIF orientation; never rotate twice.
        exif_orientation = image.getexif().get(274, 1)
        if exif_orientation not in range(1,9):
            raise ValueError('invalid EXIF orientation')
        image = ImageOps.exif_transpose(image)
        image = image.convert('RGBA' if 'A' in image.getbands() or 'transparency' in image.info else 'RGB')
        width, height = image.size
        options = ort.SessionOptions()
        options.intra_op_num_threads = 1
        options.inter_op_num_threads = 1
        options.log_severity_level = 3
        session = ort.InferenceSession(str(model_path), sess_options=options, providers=['CPUExecutionProvider'])
        def rgb_view(im):
            if im.mode == 'RGBA':
                background = Image.new('RGBA', im.size, (255,255,255,255))
                return Image.alpha_composite(background, im).convert('RGB')
            return im.convert('RGB')
        def classify(im):
            im = rgb_view(im)
            scale = 256 / min(im.size)
            # Bound intermediate allocation for hostile extreme aspect ratios.
            if max(im.size) / min(im.size) > 8:
                return None
            resized = im.resize((int(im.width * scale), int(im.height * scale)), Image.Resampling.BILINEAR)
            x, y = (resized.width - 224) // 2, (resized.height - 224) // 2
            array = np.asarray(resized.crop((x, y, x + 224, y + 224)), dtype=np.float32) / 255
            array = (array - np.array([.485,.456,.406], dtype=np.float32)) / np.array([.229,.224,.225], dtype=np.float32)
            scores = session.run(None, {'x': array.transpose(2,0,1)[None]})[0].reshape(-1)
            return decision(scores.tolist())
        angle, confidence, margin = 0, 0.0, 0.0
        status = 'uncertain'
        sample = np.asarray(rgb_view(image).resize((64,64)).convert('L'))
        if min(image.size) >= 64 and float(sample.std()) >= 8:
            result = classify(image)
            if result:
                proposed, confidence, margin, confident = result
                if confident and proposed == 0:
                    status = 'upright'
                elif confident:
                    # Labels describe clockwise input orientation. PIL transpose is CCW.
                    rotated = image.transpose({90:Image.Transpose.ROTATE_90,180:Image.Transpose.ROTATE_180,270:Image.Transpose.ROTATE_270}[proposed])
                    check = classify(rotated)
                    if check and check[0] == 0 and check[3]:
                        image, angle, status = rotated, proposed, 'corrected'
        image.save(output, format='PNG')
        if Path(output).stat().st_size > 64 * 1024 * 1024:
            raise ValueError('orientation output exceeds limit')
        return {'model': MODEL_ID, 'modelSha256': manifest['onnxSha256'], 'status': status,
                'inputClockwiseDegrees': angle, 'correctionClockwiseDegrees': (360-angle)%360,
                'confidence': confidence, 'margin': margin, 'width': image.width, 'height': image.height,
                'sourceWidth': width, 'sourceHeight': height, 'exifOrientation': exif_orientation, 'exifApplied': exif_orientation != 1, 'mimeType':'image/png'}
