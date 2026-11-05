#!/usr/bin/env python3
"""Offline OCR for customer rasters and PDF pages (protocol docslurp-ocr@1).

Runs PaddleOCR PP-OCRv6 det + rec models through RapidOCR on onnxruntime (CPU).
This is the one fixed OCR program: the worker host and the isolation guest both
call it with the same arguments. It runs inside the isolation boundary and treats
every input byte as hostile.

Guarantees:
- No network. Sockets are disabled before any third-party import and every
    RapidOCR download entry point is replaced with a refusal. Models load only by
    explicit path after their size and sha256 match worker/ocr-models.json.
- The text-line orientation classifier (cls) is never loaded: it corrupts
    Korean/Arabic/Cyrillic lines.
- Rasters are capped (bytes, pixels, side length, frame count) before decode and
    downscaled to --max-long-edge before OCR (default 2000 px keeps RSS bounded).

Exit codes: 0 ok, 2 usage, 3 model refused (also self-test failure),
4 input refused, 5 internal error. Errors print one JSON line on stderr and
leave --output untouched; messages never contain customer bytes.

Usage:
    python3 -I docslurp_ocr.py --input PATH --kind image|pdf --output RESULT.json \\
            --models DIR --manifest worker/ocr-models.json --recognisers multi[,korean,...]
    python3 -I docslurp_ocr.py --self-test --models DIR --manifest worker/ocr-models.json
"""
import argparse
import hashlib
import json
import math
import os
import re
import resource
import socket
import stat
import subprocess
import sys
import tempfile
import time
import warnings

PROTOCOL = 'docslurp-ocr@1'
EXIT_USAGE = 2
EXIT_MODEL_REFUSED = 3
EXIT_INPUT_REFUSED = 4
EXIT_INTERNAL = 5

# Container formats Pillow may open. Everything else (EPS, PSD, ICO, PDF, SVG...)
# is refused before a decoder runs.
ALLOWED_IMAGE_FORMATS = ('PNG', 'JPEG', 'WEBP', 'TIFF', 'BMP', 'GIF')
MAX_SIDE = 30000
# Hard bound on how far we walk a multi-frame container (TIFF IFD chain, GIF),
# whatever --pages asks for. Walking is sequential, so this bounds the work.
MAX_FRAME_INDEX = 2048
# PDF pages are rendered one by one by number (pdftoppm -f/-l), never walked, so they are bounded by the
# document page cap instead (the ocr-result schema's frame bound).
MAX_PDF_PAGE = 100_000
# Most pages one --pages list may name (keeps argv and the job bounded; --max-frames caps the work).
MAX_PAGES_LISTED = 2048
MAX_TEXT_BYTES = 1024 * 1024
MAX_LINES = 20000
MAX_OUTPUT_BYTES = 64 * 1024 * 1024
MAX_MANIFEST_BYTES = 1024 * 1024
PDF_PAGE_TIMEOUT_S = 120
# RapidOCR's default: recognitions below this score are dropped from the text.
TEXT_SCORE = 0.5
# Below this share of letters and digits (of the non-space characters read), a recogniser's read looks like the
# wrong script and the next recogniser in the plan is tried, whatever its confidence.
MIN_LETTER_SHARE = 0.5
# Never created and never read: RapidOCR needs a model_root_dir, but every
# model is passed by explicit path and the dict-download branch is refused.
UNUSED_MODEL_ROOT = '/nonexistent/docslurp-ocr-unused'

# Recogniser family -> (RapidOCR Rec.lang_type, model type). lang_type only
# selects RTL reordering (arabic) and the refused download route.
FAMILIES = {
    'multi': ('ch', 'small'),
    'korean': ('korean', 'mobile'),
    'eslav': ('eslav', 'mobile'),
    'arabic': ('arabic', 'mobile'),
    'devanagari': ('devanagari', 'mobile'),
    'greek': ('el', 'mobile'),
    'thai': ('th', 'mobile'),
}
RTL_FAMILIES = {'arabic'}


class Refusal(Exception):
    """A refusal reported as one JSON line on stderr with a fixed exit code."""

    def __init__(self, code, error, reason, **extra):
        super().__init__(reason)
        self.code = code
        self.payload = {'error': error, 'reason': reason, **extra}


class ModelRefused(Refusal):
    def __init__(self, reason, model=None):
        super().__init__(EXIT_MODEL_REFUSED, 'model-refused', reason, model=model)


class InputRefused(Refusal):
    def __init__(self, reason):
        super().__init__(EXIT_INPUT_REFUSED, 'input-refused', reason)


class UsageError(Refusal):
    def __init__(self, reason):
        super().__init__(EXIT_USAGE, 'usage', reason)


# --- network guard -----------------------------------------------------------

def _network_refused(*_args, **_kwargs):
    raise OSError('network disabled in docslurp-ocr')


class _NoSocket(socket.socket):
    """Subclassable stand-in (ssl subclasses socket.socket) that never opens."""

    def __init__(self, *_args, **_kwargs):
        _network_refused()


def install_network_guard():
    """Make sockets unusable for the rest of the process. Call before importing
    any third-party package so that nothing captures the real constructors."""
    os.environ['HF_HUB_OFFLINE'] = '1'
    os.environ['NO_PROXY'] = '*'
    os.environ['no_proxy'] = '*'
    for name in ('HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'):
        os.environ.pop(name, None)
    import _socket
    socket.socket = _NoSocket
    socket.SocketType = _NoSocket
    _socket.socket = _NoSocket
    for name in ('create_connection', 'create_server', 'getaddrinfo', 'gethostbyname',
                              'gethostbyname_ex', 'gethostbyaddr', 'fromfd', 'socketpair'):
        if hasattr(socket, name):
            setattr(socket, name, _network_refused)
    for name in ('getaddrinfo', 'gethostbyname', 'gethostbyname_ex', 'gethostbyaddr'):
        if hasattr(_socket, name):
            setattr(_socket, name, _network_refused)


def _download_refused(*_args, **_kwargs):
    raise ModelRefused('download-attempted')


def import_ocr_runtime(threads=1):
    """Import numpy/Pillow/onnxruntime/RapidOCR with the network guard in place
    and every RapidOCR download path replaced by a refusal. Returns a namespace."""
    install_network_guard()
    os.environ['OMP_NUM_THREADS'] = str(threads)
    os.environ['OPENBLAS_NUM_THREADS'] = '1'
    import numpy as np
    import onnxruntime
    from PIL import Image, ImageFile, ImageSequence
    import rapidocr
    from rapidocr import RapidOCR
    from rapidocr.utils import download_file, download_models
    from rapidocr.utils.process_img import map_boxes_to_original
    from rapidocr.utils.typings import EngineType, LangRec, ModelType, OCRVersion
    import rapidocr.main as rapidocr_main
    from rapidocr.main import RapidOCRError
    from rapidocr.ch_ppocr_rec import TextRecInput
    # Every engine (onnxruntime, openvino, paddle, torch, mnn) and the rec dict
    # fallback route through DownloadFile; patch the class, not a module copy.
    download_file.DownloadFile.run = classmethod(_download_refused)
    download_file.DownloadFile._make_http_request = classmethod(_download_refused)
    download_models.download_models = _download_refused
    rapidocr_main.download_models = _download_refused
    try:
        import requests
        requests.get = requests.post = requests.request = _download_refused
        requests.Session.request = _download_refused
    except ImportError:
        pass
    version = getattr(rapidocr, '__version__', None)
    if version is None:
        from rapidocr._version import __version__ as version
    return argparse.Namespace(
        np=np, ort=onnxruntime, Image=Image, ImageFile=ImageFile, ImageSequence=ImageSequence,
        RapidOCR=RapidOCR, RapidOCRError=RapidOCRError, TextRecInput=TextRecInput, map_boxes_to_original=map_boxes_to_original, EngineType=EngineType,
        LangRec=LangRec, ModelType=ModelType, OCRVersion=OCRVersion,
        rapidocr_version=version, download_file=download_file)


# --- manifest and model verification -----------------------------------------

_HEX64 = re.compile(r'^[0-9a-f]{64}$')
_MODEL_ID = re.compile(r'^[a-z0-9][a-z0-9.-]{0,63}$')
_MODEL_FILE = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.onnx$')


def _regular_file_or_none(path):
    try:
        st = os.lstat(path)
    except OSError:
        return None
    return st if stat.S_ISREG(st.st_mode) else None


def load_manifest(path):
    st = _regular_file_or_none(path)
    if st is None or st.st_size > MAX_MANIFEST_BYTES:
        raise ModelRefused('manifest-unreadable')
    try:
        with open(path, 'rb') as handle:
            data = json.loads(handle.read(MAX_MANIFEST_BYTES + 1))
    except (OSError, ValueError):
        raise ModelRefused('manifest-unreadable') from None
    try:
        if data['schemaVersion'] != 1 or data['engine']['name'] != 'rapidocr':
            raise ModelRefused('manifest-invalid')
        if not isinstance(data['engine']['version'], str):
            raise ModelRefused('manifest-invalid')
        det, recs, ids = None, {}, set()
        for entry in data['models']:
            ok = (
                isinstance(entry['id'], str) and _MODEL_ID.match(entry['id'])
                and entry['id'] not in ids
                and isinstance(entry['file'], str) and _MODEL_FILE.match(entry['file'])
                and isinstance(entry['sha256'], str) and _HEX64.match(entry['sha256'])
                and isinstance(entry['bytes'], int) and 0 < entry['bytes'] <= 512 * 1024 * 1024
                and entry['ocrVersion'] in ('PP-OCRv5', 'PP-OCRv6')
            )
            if not ok:
                raise ModelRefused('manifest-invalid', entry.get('id') if isinstance(entry, dict) else None)
            ids.add(entry['id'])
            if entry['role'] == 'det' and entry['family'] is None and det is None:
                det = entry
            elif entry['role'] == 'rec' and entry['family'] in FAMILIES and entry['family'] not in recs:
                recs[entry['family']] = entry
            else:
                raise ModelRefused('manifest-invalid', entry['id'])
        if det is None:
            raise ModelRefused('manifest-invalid')
    except (KeyError, TypeError, AttributeError):
        raise ModelRefused('manifest-invalid') from None
    return {'engine': data['engine'], 'det': det, 'recs': recs}


class VerifiedModel:
    """A model file whose bytes matched the manifest. The verified descriptor is
    kept open and handed to onnxruntime as /proc/self/fd/N, so a path swapped
    after verification cannot be loaded instead."""

    def __init__(self, entry, fd, path):
        self.entry = entry
        self.fd = fd
        proc_path = f'/proc/self/fd/{fd}'
        self.load_path = proc_path if os.path.exists(proc_path) else path


def verify_model(models_dir, entry):
    path = os.path.join(models_dir, entry['file'])
    model_id = entry['id']
    try:
        st = os.lstat(path)
    except FileNotFoundError:
        raise ModelRefused('missing', model_id) from None
    except OSError:
        raise ModelRefused('unreadable', model_id) from None
    if not stat.S_ISREG(st.st_mode):
        raise ModelRefused('not-regular-file', model_id)
    if st.st_size != entry['bytes']:
        raise ModelRefused('size-mismatch', model_id)
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    except OSError:
        raise ModelRefused('unreadable', model_id) from None
    fst = os.fstat(fd)
    if (fst.st_dev, fst.st_ino) != (st.st_dev, st.st_ino) or fst.st_size != entry['bytes']:
        os.close(fd)
        raise ModelRefused('changed-during-verify', model_id)
    digest = hashlib.sha256()
    while True:
        chunk = os.read(fd, 1 << 20)
        if not chunk:
            break
        digest.update(chunk)
    if digest.hexdigest() != entry['sha256']:
        os.close(fd)
        raise ModelRefused('sha256-mismatch', model_id)
    os.lseek(fd, 0, os.SEEK_SET)
    return VerifiedModel(entry, fd, path)


def rtl_available():
    try:
        from bidi.algorithm import get_display  # noqa: F401
    except ImportError:
        return False
    return True


# --- OCR engines --------------------------------------------------------------

class OcrEngines:
    """One RapidOCR instance per recogniser family, built lazily. Detection runs
    once per frame on the first engine; other families only run recognition on
    the same crops, so their det sessions are never loaded."""

    def __init__(self, rt, det, recs, threads, max_long_edge):
        self.rt = rt
        self.det = det
        self.recs = recs
        self.threads = threads
        self.max_long_edge = max_long_edge
        self.engines = {}
        self.det_engine = None
        self.used = [det.entry]

    def params(self, family):
        rt, rec = self.rt, self.recs[family]
        lang, model_type = FAMILIES[family]
        return {
            'Global.use_det': True,
            'Global.use_cls': False,
            'Global.use_rec': True,
            'Global.text_score': TEXT_SCORE,
            'Global.max_side_len': self.max_long_edge,
            'Global.log_level': 'warning',
            'Global.model_root_dir': UNUSED_MODEL_ROOT,
            'Det.engine_type': rt.EngineType.ONNXRUNTIME,
            'Det.ocr_version': rt.OCRVersion(self.det.entry['ocrVersion']),
            'Det.model_type': rt.ModelType.SMALL,
            'Det.model_path': self.det.load_path,
            'Rec.engine_type': rt.EngineType.ONNXRUNTIME,
            'Rec.ocr_version': rt.OCRVersion(rec.entry['ocrVersion']),
            'Rec.model_type': rt.ModelType(model_type),
            'Rec.lang_type': rt.LangRec(lang),
            'Rec.model_path': rec.load_path,
            # Never used (cls stays off); point it at nothing loadable.
            'Cls.model_path': UNUSED_MODEL_ROOT + '/cls.onnx',
            'EngineConfig.onnxruntime.intra_op_num_threads': self.threads,
            'EngineConfig.onnxruntime.inter_op_num_threads': 1,
        }

    def engine(self, family):
        if family in self.engines:
            return self.engines[family]
        rec = self.recs[family]
        try:
            engine = self.rt.RapidOCR(params=self.params(family))
            if engine.cfg.Global.use_cls or engine.use_cls:
                raise ModelRefused('cls-enabled', rec.entry['id'])
            # Load the recogniser now so a model without an embedded character list
            # is refused here (its dict-download fallback raises ModelRefused).
            text_rec = engine._load_rec_model()
        except ModelRefused as error:
            if error.payload['reason'] == 'download-attempted':
                raise ModelRefused('dict-missing', rec.entry['id']) from None
            raise
        except Exception:
            raise ModelRefused('engine-load-failed', rec.entry['id']) from None
        if not text_rec.session.have_key():
            raise ModelRefused('dict-missing', rec.entry['id'])
        if engine.text_cls is not None:
            raise ModelRefused('cls-loaded', rec.entry['id'])
        self.engines[family] = engine
        self.used.append(rec.entry)
        if self.det_engine is None:
            self.det_engine = engine
        return engine

    def detect(self, bgr, first_family):
        """Returns (crops, boxes as Nx4x2 in frame coordinates) or ([], None)."""
        engine = self.det_engine or self.engine(first_family)
        img, op_record = engine.preprocess_img(bgr)
        try:
            crops, det_res = engine.detect_and_crop(img, op_record)
        except self.rt.RapidOCRError:  # raised when nothing is detected
            return [], None
        if not crops:
            return [], None
        boxes = self.rt.map_boxes_to_original(
            self.rt.np.array(det_res.boxes, dtype='float32'), op_record, bgr.shape[0], bgr.shape[1])
        return crops, boxes

    def recognise(self, family, crops):
        text_rec = self.engine(family).text_rec
        result = text_rec(self.rt.TextRecInput(img=crops, return_word_box=False))
        return list(result.txts or ()), [float(s) for s in (result.scores or ())]


# --- text assembly ------------------------------------------------------------

def _spaceless(ch):
    code = ord(ch)
    return (
        0x0E00 <= code <= 0x0E7F  # Thai
        or 0x3000 <= code <= 0x30FF  # CJK punctuation, Hiragana, Katakana
        or 0x31F0 <= code <= 0x31FF
        or 0x3400 <= code <= 0x4DBF
        or 0x4E00 <= code <= 0x9FFF
        or 0xF900 <= code <= 0xFAFF
        or 0xFF00 <= code <= 0xFFEF  # full-width forms
        or 0x20000 <= code <= 0x3FFFF
    )


def _join(left, right):
    if not left:
        return right
    if left[-1].isspace() or (right and right[0].isspace()):
        return left + right
    if right and _spaceless(left[-1]) and _spaceless(right[0]):
        return left + right
    return left + ' ' + right


def assemble(items, rtl):
    """items: [{'text','confidence','box':[x0,y0,x1,y1]}]. Groups boxes into
    visual lines (top-to-bottom by centre, merged when centres sit within half a
    line height) and orders each line left-to-right (right-to-left for RTL).
    Returns (lines, text) where a vertical gap above ~0.8 line heights starts a
    new paragraph."""
    if not items:
        return [], ''
    items = sorted(items, key=lambda it: ((it['box'][1] + it['box'][3]) / 2, it['box'][0]))
    rows = []
    for item in items:
        x0, y0, x1, y1 = item['box']
        cy, height = (y0 + y1) / 2, max(1.0, y1 - y0)
        row = rows[-1] if rows else None
        if row is not None and abs(cy - row['cy']) <= 0.5 * min(height, row['height']):
            row['items'].append(item)
            count = len(row['items'])
            row['cy'] += (cy - row['cy']) / count
            row['height'] += (height - row['height']) / count
        else:
            rows.append({'cy': cy, 'height': height, 'items': [item]})
    lines = []
    for row in rows:
        members = sorted(row['items'], key=lambda it: it['box'][0], reverse=rtl)
        text = ''
        for member in members:
            text = _join(text, member['text'])
        lines.append({
            'text': text,
            'confidence': round(sum(m['confidence'] for m in members) / len(members), 4),
            'box': [
                min(m['box'][0] for m in members), min(m['box'][1] for m in members),
                max(m['box'][2] for m in members), max(m['box'][3] for m in members),
            ],
        })
    heights = sorted(line['box'][3] - line['box'][1] for line in lines)
    median_height = max(1, heights[len(heights) // 2])
    parts = []
    for index, line in enumerate(lines):
        if index:
            gap = line['box'][1] - lines[index - 1]['box'][3]
            parts.append('\n\n' if gap > 0.8 * median_height else '\n')
        parts.append(line['text'])
    return lines, ''.join(parts)


def clamp_text(text):
    encoded = text.encode('utf-8')
    if len(encoded) <= MAX_TEXT_BYTES:
        return text, False
    return encoded[:MAX_TEXT_BYTES].decode('utf-8', errors='ignore'), True


# --- raster loading -----------------------------------------------------------

EXIF_TRANSPOSE = {2: 'FLIP_LEFT_RIGHT', 3: 'ROTATE_180', 4: 'FLIP_TOP_BOTTOM', 5: 'TRANSPOSE',
                                    6: 'ROTATE_270', 7: 'TRANSVERSE', 8: 'ROTATE_90'}


def _check_size(size, max_pixels):
    width, height = size
    if not (1 <= width <= MAX_SIDE and 1 <= height <= MAX_SIDE):
        raise InputRefused('dimensions-out-of-range')
    if width * height > max_pixels:
        raise InputRefused('too-many-pixels')


def _target_size(width, height, max_long_edge):
    long_edge = max(width, height)
    if long_edge <= max_long_edge:
        return width, height
    scale = max_long_edge / long_edge
    return max(1, round(width * scale)), max(1, round(height * scale))


def _to_rgb(rt, frame):
    """Flatten any decoded mode to 8-bit RGB; transparency composites on white."""
    Image, np = rt.Image, rt.np
    mode = frame.mode
    if mode in ('I', 'F') or mode.startswith('I;16'):
        array = np.asarray(frame, dtype=np.float64)
        low, high = float(array.min()), float(array.max())
        span = high - low if high > low else 1.0
        gray = ((array - low) * (255.0 / span)).clip(0, 255).astype(np.uint8)
        return Image.fromarray(gray, 'L').convert('RGB')
    if mode == 'P' and 'transparency' in frame.info:
        frame = frame.convert('RGBA')
        mode = 'RGBA'
    if mode in ('RGBA', 'LA', 'PA', 'RGBa', 'La'):
        rgba = frame.convert('RGBA')
        background = Image.new('RGBA', rgba.size, (255, 255, 255, 255))
        return Image.alpha_composite(background, rgba).convert('RGB')
    return frame if mode == 'RGB' else frame.convert('RGB')


def _decode_frame(rt, image, first_frame, max_long_edge, exif_method):
    Image = rt.Image
    width, height = image.size
    target = _target_size(width, height, max_long_edge)
    if image.format == 'JPEG' and first_frame and target != (width, height):
        # DCT-domain downscale: decodes at 1/2, 1/4 or 1/8 size, never below target.
        image.draft('RGB', target)
    image.load()
    frame = _to_rgb(rt, image)
    factor = min(frame.width // target[0], frame.height // target[1])
    if factor >= 2:
        frame = frame.reduce(factor)
    if frame.size != target:
        frame = frame.resize(target, Image.Resampling.LANCZOS)
    if exif_method:
        frame = frame.transpose(getattr(Image.Transpose, exif_method))
    return frame


def _exif_method(image):
    try:
        orientation = image.getexif().get(0x0112, 1)
    except Exception:
        return None
    return EXIF_TRANSPOSE.get(orientation) if isinstance(orientation, int) else None


def open_image(rt, fileobj, max_pixels):
    Image = rt.Image
    try:
        image = Image.open(fileobj, formats=ALLOWED_IMAGE_FORMATS)
    except (Image.DecompressionBombError, Image.DecompressionBombWarning):
        raise InputRefused('too-many-pixels') from None
    except Image.UnidentifiedImageError:
        raise InputRefused('unsupported-format') from None
    except MemoryError:
        raise InputRefused('too-large') from None
    except Exception:
        raise InputRefused('decode-failed') from None
    if image.format not in ALLOWED_IMAGE_FORMATS:
        raise InputRefused('unsupported-format')
    _check_size(image.size, max_pixels)
    return image


def iter_image_frames(rt, fileobj, args, pages, state):
    """Yields (frame_no, rgb_image, (source_w, source_h)). Walks frames
    sequentially (never n_frames, which walks a whole TIFF IFD chain) and stops
    at --max-frames processed or MAX_FRAME_INDEX walked; state['truncated'] is set
    when more frames remained."""
    image = open_image(rt, fileobj, args.max_pixels)
    wanted = set(pages) if pages else None
    last_wanted = max(wanted) if wanted else None
    index = processed = 0
    try:
        while True:
            if index:
                try:
                    image.seek(index)
                except EOFError:
                    break
            frame_no = index + 1
            if wanted is None or frame_no in wanted:
                if processed >= args.max_frames:
                    state['truncated'] = True
                    break
                _check_size(image.size, args.max_pixels)
                exif_method = _exif_method(image)
                source = image.size
                if exif_method in ('TRANSPOSE', 'TRANSVERSE', 'ROTATE_90', 'ROTATE_270'):
                    source = (source[1], source[0])
                yield frame_no, _decode_frame(rt, image, index == 0, args.max_long_edge, exif_method), source
                processed += 1
            index += 1
            if last_wanted is not None and index >= last_wanted:
                break
            if index >= MAX_FRAME_INDEX:
                try:
                    image.seek(index)
                    state['truncated'] = True
                except EOFError:
                    pass
                break
    except Refusal:
        raise
    except (rt.Image.DecompressionBombError, rt.Image.DecompressionBombWarning):
        raise InputRefused('too-many-pixels') from None
    except MemoryError:
        raise InputRefused('too-large') from None
    except Exception:
        raise InputRefused('decode-failed') from None
    finally:
        image.close()


def iter_pdf_frames(rt, args, pages, state, workdir):
    if len(pages) > args.max_frames:
        state['truncated'] = True
        pages = pages[:args.max_frames]
    env = {'PATH': '/usr/bin:/bin', 'LC_ALL': 'C'}
    for page in pages:
        prefix = os.path.join(workdir, f'page-{page:05d}')
        command = [args.pdftoppm, '-r', str(args.pdf_dpi), '-f', str(page), '-l', str(page),
                              '-png', '-singlefile', '-scale-to', str(args.max_long_edge), args.input, prefix]
        try:
            result = subprocess.run(command, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                                            stderr=subprocess.DEVNULL, env=env, timeout=PDF_PAGE_TIMEOUT_S,
                                                            check=False)
        except subprocess.TimeoutExpired:
            raise InputRefused('pdf-render-timeout') from None
        except OSError:
            raise UsageError('pdftoppm-unavailable') from None
        png = prefix + '.png'
        if result.returncode != 0 or _regular_file_or_none(png) is None:
            raise InputRefused('pdf-render-failed')
        with open(png, 'rb') as handle:
            for _frame, rgb, source in iter_image_frames(rt, handle, args, None, {}):
                yield page, rgb, source
                break
        os.unlink(png)


# --- per-frame OCR -------------------------------------------------------------

def is_blank(rt, rgb):
    sample = rgb.convert('L')
    sample.thumbnail((256, 256))
    return float(rt.np.asarray(sample, dtype=rt.np.float32).std()) < 2.0


def letter_share(items):
    """Share of letters and digits among the non-space characters a recogniser kept (1.0 when it kept none)."""
    total = letters = 0
    for item in items:
        for char in item['text']:
            if char.isspace():
                continue
            total += 1
            if char.isalnum():
                letters += 1
    return letters / total if total else 1.0


def _attempt_rank(attempt):
    # A read with text that is mostly letters beats an empty or mostly-punctuation read; confidence breaks ties.
    return (attempt['_plausible'], attempt['meanConfidence'] if attempt['meanConfidence'] is not None else -1)


def ocr_frame(rt, engines, rgb, families, args):
    np = rt.np
    bgr = np.ascontiguousarray(np.asarray(rgb, dtype=np.uint8)[:, :, ::-1])
    crops, boxes = engines.detect(bgr, families[0])
    if not crops:
        return None, [], [], '', None, False
    crops = crops[:MAX_LINES]
    rects = []
    for quad in boxes[:len(crops)]:
        xs, ys = quad[:, 0], quad[:, 1]
        rects.append([int(math.floor(xs.min())), int(math.floor(ys.min())),
                                    int(math.ceil(xs.max())), int(math.ceil(ys.max()))])
    attempts, best = [], None
    for family in families[:args.max_attempts]:
        txts, scores = engines.recognise(family, crops)
        scores = [s if math.isfinite(s) else 0.0 for s in scores]
        # Mean over every detected region (dropped low-score ones included), so a
        # wrong-script recogniser cannot look confident by filtering itself.
        mean = round(sum(scores) / len(scores), 4) if scores else None
        items = [
            {'text': txt.strip(), 'confidence': round(score, 4), 'box': rect}
            for txt, score, rect in zip(txts, scores, rects)
            if txt.strip() and score >= TEXT_SCORE
        ]
        # A recogniser for the wrong script can read detected text confidently as punctuation or as nothing at all
        # (the general model reads Cyrillic that way): such a read is never accepted while another recogniser
        # remains to try.
        plausible = bool(items) and letter_share(items) >= MIN_LETTER_SHARE
        attempts.append({'recogniser': family, 'meanConfidence': mean, 'lines': len(items), '_items': items, '_plausible': plausible})
        if best is None or _attempt_rank(attempts[-1]) > _attempt_rank(best):
            best = attempts[-1]
        if mean is not None and mean >= args.retry_below and plausible:
            break
    lines, text = assemble(best['_items'], best['recogniser'] in RTL_FAMILIES)
    text, truncated = clamp_text(text)
    for attempt in attempts:
        del attempt['_items'], attempt['_plausible']
    return best['recogniser'], attempts, lines, text, best['meanConfidence'], truncated


# --- output -------------------------------------------------------------------

def check_image_dir(path):
    try:
        st = os.lstat(path)
    except OSError:
        raise UsageError('image-dir-missing') from None
    if not stat.S_ISDIR(st.st_mode):
        raise UsageError('image-dir-not-directory')
    if os.listdir(path):
        raise UsageError('image-dir-not-empty')


def write_png(rgb, directory, name):
    fd = os.open(os.path.join(directory, name),
                              os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o644)
    with os.fdopen(fd, 'wb') as handle:
        rgb.save(handle, format='PNG')


def write_rendition(rt, rgb, directory, frame_no, max_edge, max_bytes):
    """The frame's rendition (RGB, long edge <= max_edge, PNG), or None when it would exceed max_bytes."""
    width, height = rgb.size
    scale = min(1.0, max_edge / max(width, height))
    image = rgb if scale >= 1.0 else rgb.resize((max(1, round(width * scale)), max(1, round(height * scale))), rt.Image.LANCZOS)
    name = f'rendition-{frame_no:04d}.png'
    path = os.path.join(directory, name)
    write_png(image.convert('RGB'), directory, name)
    if os.path.getsize(path) > max_bytes:
        os.unlink(path)
        return None
    return name


def write_result_atomically(path, payload):
    data = json.dumps(payload, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    if len(data) > MAX_OUTPUT_BYTES:
        # Keep the text; drop per-line geometry, which is the bulk.
        for frame in payload['frames']:
            frame['lines'] = []
        payload['linesDropped'] = True
        data = json.dumps(payload, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
        if len(data) > MAX_OUTPUT_BYTES:
            raise Refusal(EXIT_INTERNAL, 'output-too-large', 'output-too-large')
    directory = os.path.dirname(os.path.abspath(path))
    fd, temp = tempfile.mkstemp(prefix='.docslurp-ocr-', suffix='.tmp', dir=directory)
    try:
        with os.fdopen(fd, 'wb') as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp, path)
    except BaseException:
        try:
            os.unlink(temp)
        except OSError:
            pass
        raise


def usage_stats():
    own = resource.getrusage(resource.RUSAGE_SELF)
    children = resource.getrusage(resource.RUSAGE_CHILDREN)
    cpu = own.ru_utime + own.ru_stime + children.ru_utime + children.ru_stime
    # Linux reports ru_maxrss in KiB. The sum is an upper bound across processes.
    return {'peakRssKb': int(own.ru_maxrss + children.ru_maxrss), 'cpuMs': int(cpu * 1000)}


# --- CLI ----------------------------------------------------------------------

def _csv(value):
    return [part.strip() for part in value.split(',') if part.strip()] if value else []


def _pages(value):
    try:
        pages = [int(part) for part in _csv(value)]
    except ValueError:
        raise argparse.ArgumentTypeError('pages must be comma-separated integers') from None
    if not pages or len(pages) > MAX_PAGES_LISTED or any(p < 1 or p > MAX_PDF_PAGE for p in pages):
        raise argparse.ArgumentTypeError(f'pages must be at most {MAX_PAGES_LISTED} numbers within 1..{MAX_PDF_PAGE}')
    return sorted(set(pages))


def _bounded(kind, low, high):
    def parse(value):
        try:
            number = kind(value)
        except ValueError:
            raise argparse.ArgumentTypeError(f'expected {kind.__name__}') from None
        if not low <= number <= high:
            raise argparse.ArgumentTypeError(f'must be within {low}..{high}')
        return number
    return parse


def parse_args(argv):
    parser = argparse.ArgumentParser(description='Offline PP-OCR (RapidOCR/onnxruntime) for one raster or PDF.')
    parser.add_argument('--input')
    parser.add_argument('--kind', choices=('image', 'pdf'))
    parser.add_argument('--output')
    parser.add_argument('--models', required=True)
    parser.add_argument('--manifest', required=True)
    parser.add_argument('--recognisers', type=_csv, default=None)
    parser.add_argument('--max-attempts', type=_bounded(int, 1, len(FAMILIES)), default=3)
    parser.add_argument('--retry-below', type=_bounded(float, 0.0, 1.0), default=0.80)
    parser.add_argument('--pages', type=_pages, default=None)
    parser.add_argument('--max-frames', type=_bounded(int, 1, MAX_FRAME_INDEX), default=64)
    parser.add_argument('--max-long-edge', type=_bounded(int, 32, 8000), default=2000)
    parser.add_argument('--max-pixels', type=_bounded(int, 1, MAX_SIDE * MAX_SIDE), default=50_000_000)
    parser.add_argument('--max-input-bytes', type=_bounded(int, 1, 1 << 34), default=104_857_600)
    parser.add_argument('--threads', type=_bounded(int, 1, 64), default=1)
    parser.add_argument('--pdftoppm')
    parser.add_argument('--pdf-dpi', type=_bounded(int, 36, 600), default=150)
    parser.add_argument('--image-dir')
    parser.add_argument('--escalate-below', type=_bounded(float, 0.0, 1.0), default=0.80)
    parser.add_argument('--escalate-recognisers', type=_csv, default=[])
    # A bounded, normalized rendition of every frame for visual indexing (the host never decodes the customer's own bytes):
    # rendition-NNNN.png, long edge at most --rendition-max-edge, dropped when it encodes larger than --rendition-max-bytes.
    parser.add_argument('--rendition-max-edge', type=_bounded(int, 0, 2048), default=0)
    parser.add_argument('--rendition-max-bytes', type=_bounded(int, 1024, 16 * 1024 * 1024), default=4 * 1024 * 1024)
    parser.add_argument('--self-test', action='store_true')
    return parser.parse_args(argv)


def resolve_families(args, manifest):
    families = args.recognisers if args.recognisers else (None if args.self_test else ['multi'])
    if families is None:
        families = list(manifest['recs'])
    if len(set(families)) != len(families):
        raise UsageError('duplicate-recogniser')
    for family in families + list(args.escalate_recognisers):
        if family not in FAMILIES:
            raise UsageError('unknown-recogniser')
    for family in families:
        if family not in manifest['recs']:
            raise ModelRefused('not-in-manifest', family)
    return families


def verify_job_models(args, manifest, families):
    if not os.path.isdir(args.models):
        raise ModelRefused('models-dir-missing')
    if RTL_FAMILIES.intersection(families) and not rtl_available():
        raise ModelRefused('rtl-missing', manifest['recs']['arabic']['id'])
    det = verify_model(args.models, manifest['det'])
    recs = {family: verify_model(args.models, manifest['recs'][family]) for family in families}
    return det, recs


def check_engine_version(rt, manifest):
    if rt.rapidocr_version != manifest['engine']['version']:
        raise ModelRefused('engine-version-mismatch')


def self_test(args):
    manifest = load_manifest(args.manifest)
    families = resolve_families(args, manifest)
    det, recs = verify_job_models(args, manifest, families)
    rt = import_ocr_runtime(args.threads)
    check_engine_version(rt, manifest)
    print(json.dumps({
        'ok': True,
        'protocol': PROTOCOL,
        'engine': {'name': 'rapidocr', 'version': rt.rapidocr_version, 'onnxruntime': rt.ort.__version__},
        'models': [{'id': m.entry['id'], 'sha256': m.entry['sha256']} for m in [det, *recs.values()]],
        'recognisers': families,
        'rtl': rtl_available(),
    }))


def run(args):
    for name in ('input', 'kind', 'output'):
        if not getattr(args, name):
            raise UsageError(f'missing-{name}')
    if args.kind == 'pdf' and (not args.pdftoppm or not args.pages):
        raise UsageError('pdf-needs-pdftoppm-and-pages')
    # Image frames are walked sequentially, so they keep the frame-walk bound.
    if args.kind == 'image' and args.pages and max(args.pages) > MAX_FRAME_INDEX:
        raise UsageError('image-frame-out-of-range')
    if args.image_dir:
        check_image_dir(args.image_dir)
    if args.rendition_max_edge and not args.image_dir:
        raise UsageError('rendition-needs-image-dir')
    manifest = load_manifest(args.manifest)
    families = resolve_families(args, manifest)
    det, recs = verify_job_models(args, manifest, families)

    # Input guards run before the heavy imports: hostile bytes never reach a
    # decoder when they are oversize, a symlink or not a regular file.
    st = _regular_file_or_none(args.input)
    if st is None:
        raise InputRefused('input-not-regular-file')
    if st.st_size > args.max_input_bytes:
        raise InputRefused('input-too-large')
    if st.st_size == 0:
        raise InputRefused('input-empty')

    rt = import_ocr_runtime(args.threads)
    check_engine_version(rt, manifest)
    rt.Image.MAX_IMAGE_PIXELS = args.max_pixels
    rt.ImageFile.LOAD_TRUNCATED_IMAGES = False
    warnings.simplefilter('error', rt.Image.DecompressionBombWarning)
    engines = OcrEngines(rt, det, recs, args.threads, args.max_long_edge)
    escalate = set(args.escalate_recognisers)

    state = {'truncated': False}
    frames = []
    with tempfile.TemporaryDirectory(prefix='docslurp-ocr-') as workdir:
        if args.kind == 'pdf':
            source = iter_pdf_frames(rt, args, args.pages, state, workdir)
            input_handle = None
        else:
            try:
                input_fd = os.open(args.input, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
            except OSError:
                raise InputRefused('input-not-regular-file') from None
            input_handle = os.fdopen(input_fd, 'rb')
            if os.fstat(input_fd).st_size > args.max_input_bytes:
                raise InputRefused('input-too-large')
            source = iter_image_frames(rt, input_handle, args, args.pages, state)
        try:
            started = time.perf_counter()
            for frame_no, rgb, (source_w, source_h) in source:
                blank = is_blank(rt, rgb)
                if blank:
                    # Nothing to read: skip detection, which also keeps a frame
                    # bomb of empty pages cheap.
                    recogniser, attempts, lines, text, mean, text_truncated = None, [], [], '', None, False
                else:
                    recogniser, attempts, lines, text, mean, text_truncated = ocr_frame(rt, engines, rgb, families, args)
                frame = {
                    'frame': frame_no,
                    'width': rgb.width,
                    'height': rgb.height,
                    'sourceWidth': source_w,
                    'sourceHeight': source_h,
                    'recogniser': recogniser,
                    'attempts': attempts,
                    'text': text,
                    'lines': lines,
                    'meanConfidence': mean,
                    'chars': len(text),
                    'elapsedMs': int((time.perf_counter() - started) * 1000),
                    'image': None,
                }
                if text_truncated:
                    frame['textTruncated'] = True
                if args.image_dir and (
                    (mean is not None and mean < args.escalate_below)
                    or recogniser in escalate
                    or (not text and not blank)
                ):
                    name = f'frame-{frame_no:04d}.png'
                    write_png(rgb, args.image_dir, name)
                    frame['image'] = name
                if args.rendition_max_edge:
                    frame['rendition'] = write_rendition(rt, rgb, args.image_dir, frame_no, args.rendition_max_edge, args.rendition_max_bytes)
                frames.append(frame)
                started = time.perf_counter()
        finally:
            if input_handle is not None:
                input_handle.close()

    payload = {
        'protocol': PROTOCOL,
        'engine': {'name': 'rapidocr', 'version': rt.rapidocr_version, 'onnxruntime': rt.ort.__version__},
        'models': [{'id': entry['id'], 'sha256': entry['sha256']} for entry in engines.used],
        'truncatedFrames': bool(state['truncated']),
        'frames': frames,
    }
    payload.update(usage_stats())
    write_result_atomically(args.output, payload)


def main(argv=None):
    args = parse_args(sys.argv[1:] if argv is None else argv)
    try:
        if args.self_test:
            self_test(args)
        else:
            run(args)
    except Refusal as refusal:
        print(json.dumps(refusal.payload), file=sys.stderr)
        return refusal.code
    except MemoryError:
        print(json.dumps({'error': 'input-refused', 'reason': 'out-of-memory'}), file=sys.stderr)
        return EXIT_INPUT_REFUSED
    except Exception as error:  # never echo messages: they can quote customer bytes
        print(json.dumps({'error': 'internal', 'reason': type(error).__name__}), file=sys.stderr)
        return EXIT_INTERNAL
    return 0


if __name__ == '__main__':
    sys.exit(main())
