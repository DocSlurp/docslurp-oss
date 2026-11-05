"""Tests for docslurp_ocr.py (offline PP-OCR CLI).

Run with the OCR venv (worker/requirements-ocr.lock.txt) and the pinned models:

    DOCSLURP_OCR_TEST_MODELS=/path/to/models python -m unittest worker/scripts/test_docslurp_ocr.py

The models directory must hold the files listed in worker/ocr-models.json; the
tests never download anything. Tests that need a missing dependency (models,
fonts, pdftoppm, the OCR runtime) are skipped with the reason.
"""
import io
import json
import os
import shutil
import struct
import subprocess
import sys
import tempfile
import time
import unittest
import zlib

SCRIPTS = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(SCRIPTS, 'docslurp_ocr.py')
MANIFEST = os.path.join(os.path.dirname(SCRIPTS), 'ocr-models.json')
MODELS = os.environ.get('DOCSLURP_OCR_TEST_MODELS', '')
PYTHON = os.environ.get('DOCSLURP_OCR_PYTHON', sys.executable)
PDFTOPPM = shutil.which('pdftoppm')

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:  # pragma: no cover
    Image = None

try:
    import rapidocr  # noqa: F401
    import onnxruntime  # noqa: F401
    HAVE_RUNTIME = True
except ImportError:
    HAVE_RUNTIME = False


def read_json(path):
    with open(path) as handle:
        return json.load(handle)


def write_json(path, value):
    with open(path, 'w') as handle:
        json.dump(value, handle)


def _font(*candidates):
    for path in candidates:
        if os.path.isfile(path):
            return path
    try:
        out = subprocess.run(['fc-list', '--format', '%{file}\n'], capture_output=True, text=True, timeout=20).stdout
    except (OSError, subprocess.SubprocessError):
        return None
    names = [os.path.basename(p) for p in candidates]
    for line in out.splitlines():
        if os.path.basename(line) in names:
            return line
    return None


LATIN_FONT = _font('/usr/share/fonts/noto/NotoSans-Regular.ttf', '/usr/share/fonts/TTF/DejaVuSans.ttf',
                   '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf')
CJK_FONT = _font('/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc',
                 '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc')


def models_ready():
    if not MODELS or not os.path.isdir(MODELS):
        return False
    manifest = read_json(MANIFEST)
    return all(os.path.isfile(os.path.join(MODELS, m['file'])) for m in manifest['models'])


needs_models = unittest.skipUnless(models_ready() and HAVE_RUNTIME and Image is not None,
                                   'set DOCSLURP_OCR_TEST_MODELS to the pinned models dir and use the OCR venv')
needs_latin_font = unittest.skipUnless(LATIN_FONT, 'no Latin TrueType font found (fc-list)')


def text_image(lines, size=(1400, 400), font=None, font_size=56):
    image = Image.new('RGB', size, 'white')
    draw = ImageDraw.Draw(image)
    face = ImageFont.truetype(font or LATIN_FONT, font_size)
    y = 40
    for line in lines:
        draw.text((40, y), line, font=face, fill='black')
        y += int(font_size * 1.6)
    return image


def png_chunk(kind, data):
    return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xFFFFFFFF)


def png_bomb(width, height):
    """A PNG header declaring width x height 1-bit pixels with a tiny IDAT.
    Never allocates the image."""
    ihdr = struct.pack('>IIBBBBB', width, height, 1, 0, 0, 0, 0)
    idat = zlib.compress(b'\x00' * 1024, 9)
    return b'\x89PNG\r\n\x1a\n' + png_chunk(b'IHDR', ihdr) + png_chunk(b'IDAT', idat) + png_chunk(b'IEND', b'')


def jpeg_with_dimensions(width, height):
    """A valid small JPEG whose SOF0 header is patched to claim width x height."""
    buffer = io.BytesIO()
    Image.new('RGB', (16, 16), 'white').save(buffer, format='JPEG')
    data = bytearray(buffer.getvalue())
    sof = data.index(b'\xff\xc0')
    struct.pack_into('>HH', data, sof + 5, height, width)
    return bytes(data)


def tiff_ifd_loop(path):
    """Writes a 2-frame TIFF whose last IFD points back at the first."""
    frames = [Image.new('L', (8, 8), 255) for _ in range(2)]
    frames[0].save(path, format='TIFF', save_all=True, append_images=frames[1:])
    with open(path, 'rb') as handle:
        data = bytearray(handle.read())
    assert data[:2] == b'II'
    first = offset = struct.unpack_from('<I', data, 4)[0]
    while True:
        count = struct.unpack_from('<H', data, offset)[0]
        next_pos = offset + 2 + 12 * count
        following = struct.unpack_from('<I', data, next_pos)[0]
        if following == 0:
            struct.pack_into('<I', data, next_pos, first)
            break
        offset = following
    with open(path, 'wb') as handle:
        handle.write(bytes(data))


class OcrCliCase(unittest.TestCase):
    def setUp(self):
        self.work = tempfile.mkdtemp(prefix='docslurp-ocr-test-')

    def tearDown(self):
        shutil.rmtree(self.work, ignore_errors=True)

    def path(self, name):
        return os.path.join(self.work, name)

    def run_cli(self, input_path, *extra, kind='image', models=None, manifest=None, recognisers='multi', timeout=180):
        output = self.path('result.json')
        if os.path.exists(output):
            os.unlink(output)
        command = [PYTHON, '-I', SCRIPT, '--input', input_path, '--kind', kind, '--output', output,
                   '--models', models or MODELS, '--manifest', manifest or MANIFEST,
                   '--recognisers', recognisers, *extra]
        started = time.monotonic()
        proc = subprocess.run(command, capture_output=True, text=True, timeout=timeout)
        elapsed = time.monotonic() - started
        result = read_json(output) if proc.returncode == 0 else None
        if proc.returncode != 0:
            self.assertFalse(os.path.exists(output), 'refusals must not write --output')
        return proc, result, elapsed

    def assert_refused(self, proc, code, error, reason=None):
        self.assertEqual(proc.returncode, code, proc.stderr)
        last = proc.stderr.strip().splitlines()[-1]
        payload = json.loads(last)
        self.assertEqual(payload['error'], error)
        if reason is not None:
            self.assertEqual(payload['reason'], reason)
        return payload

    def model_copy(self):
        """A models dir of hard links (copies across filesystems) the test may mutate."""
        target = self.path('models')
        os.mkdir(target)
        for name in os.listdir(MODELS):
            try:
                os.link(os.path.join(MODELS, name), os.path.join(target, name))
            except OSError:
                shutil.copy2(os.path.join(MODELS, name), os.path.join(target, name))
        return target

    def save(self, image, name, **kwargs):
        path = self.path(name)
        image.save(path, **kwargs)
        return path

    def write(self, name, data):
        path = self.path(name)
        with open(path, 'wb') as handle:
            handle.write(data)
        return path

    def run_snippet(self, code):
        prelude = f'import sys; sys.path.insert(0, {SCRIPTS!r}); import docslurp_ocr as o\n'
        return subprocess.run([PYTHON, '-I', '-c', prelude + code], capture_output=True, text=True, timeout=180)


@needs_models
@needs_latin_font
class HappyPathTest(OcrCliCase):
    def test_english(self):
        path = self.save(text_image(['Invoice number 48213', 'Total due: 1,250.00 EUR']), 'en.png')
        proc, result, _ = self.run_cli(path)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(result['protocol'], 'docslurp-ocr@1')
        frame = result['frames'][0]
        self.assertIn('Invoice number 48213', frame['text'])
        self.assertIn('1,250.00', frame['text'])
        self.assertEqual(frame['recogniser'], 'multi')
        self.assertGreater(frame['meanConfidence'], 0.9)
        self.assertEqual(frame['chars'], len(frame['text']))
        self.assertEqual([m['id'] for m in result['models']], ['pp-ocrv6-det-small', 'pp-ocrv6-rec-small'])
        self.assertIsNone(frame['image'])
        self.assertGreater(result['peakRssKb'], 0)
        # Lines are top-to-bottom.
        self.assertLess(frame['lines'][0]['box'][1], frame['lines'][1]['box'][1])

    @unittest.skipUnless(CJK_FONT, 'no CJK font found (fc-list)')
    def test_chinese(self):
        path = self.save(text_image(['文档识别测试', '合同金额'], font=CJK_FONT), 'zh.png')
        proc, result, _ = self.run_cli(path)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        text = result['frames'][0]['text']
        self.assertIn('文档识别测试', text)
        self.assertIn('合同金额', text)

    @unittest.skipUnless(CJK_FONT, 'no CJK font found (fc-list)')
    def test_retry_with_second_recogniser(self):
        path = self.save(text_image(['한국어 문서 인식'], font=CJK_FONT), 'ko.png')
        proc, result, _ = self.run_cli(path, '--retry-below', '1.0', recognisers='multi,korean')
        self.assertEqual(proc.returncode, 0, proc.stderr)
        frame = result['frames'][0]
        self.assertEqual([a['recogniser'] for a in frame['attempts']], ['multi', 'korean'])
        self.assertEqual(frame['recogniser'], 'korean')
        self.assertIn('한국어', frame['text'])
        self.assertIn('pp-ocrv5-rec-korean-mobile', [m['id'] for m in result['models']])

    def test_multi_frame_tiff(self):
        pages = [text_image([f'Page number {n}']) for n in (1, 2, 3)]
        path = self.path('pages.tif')
        pages[0].save(path, format='TIFF', save_all=True, append_images=pages[1:])
        proc, result, _ = self.run_cli(path)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual([f['frame'] for f in result['frames']], [1, 2, 3])
        self.assertFalse(result['truncatedFrames'])
        for n, frame in zip((1, 2, 3), result['frames']):
            self.assertIn(f'Page number {n}', frame['text'])
        # --pages selects 1-based frames.
        proc, result, _ = self.run_cli(path, '--pages', '2')
        self.assertEqual([f['frame'] for f in result['frames']], [2])
        self.assertIn('Page number 2', result['frames'][0]['text'])

    @unittest.skipUnless(PDFTOPPM, 'pdftoppm not installed')
    def test_pdf(self):
        pages = [text_image([f'Quarterly report page {n}'], size=(1240, 1754)) for n in (1, 2)]
        path = self.path('doc.pdf')
        pages[0].save(path, format='PDF', save_all=True, append_images=pages[1:], resolution=150)
        proc, result, _ = self.run_cli(path, '--pdftoppm', PDFTOPPM, '--pages', '2', kind='pdf')
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual([f['frame'] for f in result['frames']], [2])
        frame = result['frames'][0]
        self.assertIn('Quarterly report page 2', frame['text'])
        self.assertLessEqual(max(frame['width'], frame['height']), 2000)

    def test_escalation_images(self):
        path = self.save(text_image(['Escalate this page']), 'esc.png')
        images = self.path('images')
        os.mkdir(images)
        proc, result, _ = self.run_cli(path, '--image-dir', images, '--escalate-recognisers', 'multi')
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(result['frames'][0]['image'], 'frame-0001.png')
        with Image.open(os.path.join(images, 'frame-0001.png')) as written:
            self.assertEqual(written.size, (result['frames'][0]['width'], result['frames'][0]['height']))
        # A non-empty image dir is refused.
        proc, _, _ = self.run_cli(path, '--image-dir', images)
        self.assert_refused(proc, 2, 'usage', 'image-dir-not-empty')

    def test_blank_page(self):
        path = self.save(Image.new('RGB', (800, 600), 'white'), 'blank.png')
        images = self.path('images')
        os.mkdir(images)
        proc, result, _ = self.run_cli(path, '--image-dir', images)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        frame = result['frames'][0]
        self.assertEqual(frame['text'], '')
        self.assertIsNone(frame['meanConfidence'])
        self.assertIsNone(frame['image'])  # blank pages are not escalated

    def test_long_edge_capped(self):
        image = text_image(['Large scan with text'], size=(5000, 3000), font_size=160)
        path = self.save(image, 'large.png')
        proc, result, _ = self.run_cli(path)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        frame = result['frames'][0]
        self.assertEqual((frame['sourceWidth'], frame['sourceHeight']), (5000, 3000))
        self.assertLessEqual(frame['width'], 2000)
        self.assertLessEqual(frame['height'], 2000)
        self.assertIn('Large scan with text', frame['text'])

    def test_self_test(self):
        proc = subprocess.run([PYTHON, '-I', SCRIPT, '--self-test', '--models', MODELS, '--manifest', MANIFEST],
                              capture_output=True, text=True, timeout=120)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        payload = json.loads(proc.stdout)
        self.assertTrue(payload['ok'])
        self.assertEqual(len(payload['models']), 8)


@needs_models
class EngineConfigTest(OcrCliCase):
    def test_cls_off_and_never_loaded(self):
        code = f'''
import json
args = o.parse_args(['--models', {MODELS!r}, '--manifest', {MANIFEST!r}])
manifest = o.load_manifest(args.manifest)
det, recs = o.verify_job_models(args, manifest, ['multi'])
rt = o.import_ocr_runtime(1)
engines = o.OcrEngines(rt, det, recs, 1, 2000)
engine = engines.engine('multi')
import numpy as np
engines.detect(np.full((200, 400, 3), 255, dtype=np.uint8), 'multi')
cfg = engine.cfg
print(json.dumps({{
  'use_cls': bool(cfg.Global.use_cls), 'engine_use_cls': bool(engine.use_cls),
  'text_cls': engine.text_cls is not None,
  'intra': cfg.EngineConfig.onnxruntime.intra_op_num_threads,
  'inter': cfg.EngineConfig.onnxruntime.inter_op_num_threads,
  'rec_path': str(cfg.Rec.model_path), 'det_path': str(cfg.Det.model_path),
}}))
'''
        proc = self.run_snippet(code)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        state = json.loads(proc.stdout.strip().splitlines()[-1])
        self.assertFalse(state['use_cls'])
        self.assertFalse(state['engine_use_cls'])
        self.assertFalse(state['text_cls'])
        self.assertEqual((state['intra'], state['inter']), (1, 1))
        self.assertTrue(state['rec_path'].startswith('/proc/self/fd/') or state['rec_path'].endswith('.onnx'))


@needs_models
class NoNetworkTest(OcrCliCase):
    def test_missing_model_is_refused_not_downloaded(self):
        models = self.model_copy()
        os.unlink(os.path.join(models, 'PP-OCRv6_rec_small.onnx'))
        path = self.write('in.png', png_bomb(10, 10))
        proc, _, _ = self.run_cli(path, models=models)
        payload = self.assert_refused(proc, 3, 'model-refused', 'missing')
        self.assertEqual(payload['model'], 'pp-ocrv6-rec-small')
        self.assertEqual(len(proc.stderr.strip().splitlines()), 1)
        for marker in ('socket', 'download', 'http', 'Traceback'):
            self.assertNotIn(marker, proc.stderr)

    def test_download_entry_points_raise(self):
        code = '''
import socket
rt = o.import_ocr_runtime(1)
from rapidocr.utils.download_file import DownloadFile, DownloadFileInput
import logging
outcomes = []
try:
    DownloadFile.run(DownloadFileInput(file_url='https://example.com/x.onnx', save_path='/nonexistent/x', logger=logging.getLogger()))
    outcomes.append('downloaded')
except o.ModelRefused as error:
    outcomes.append(error.payload['reason'])
for attempt in (lambda: socket.socket(), lambda: socket.create_connection(('example.com', 443)),
                lambda: socket.getaddrinfo('example.com', 443)):
    try:
        attempt()
        outcomes.append('connected')
    except OSError:
        outcomes.append('blocked')
import requests
try:
    requests.get('https://example.com')
    outcomes.append('fetched')
except o.ModelRefused:
    outcomes.append('refused')
print(','.join(outcomes))
'''
        proc = self.run_snippet(code)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(proc.stdout.strip(), 'download-attempted,blocked,blocked,blocked,refused')


@needs_models
class ModelIntegrityTest(OcrCliCase):
    def setUp(self):
        super().setUp()
        self.input = self.write('in.png', png_bomb(10, 10))

    def test_flipped_byte(self):
        models = self.model_copy()
        target = os.path.join(models, 'PP-OCRv6_det_small.onnx')
        with open(target, 'rb') as handle:
            data = bytearray(handle.read())
        data[len(data) // 2] ^= 0x01
        os.unlink(target)  # break the hard link before writing
        with open(target, 'wb') as handle:
            handle.write(bytes(data))
        proc, _, _ = self.run_cli(self.input, models=models)
        payload = self.assert_refused(proc, 3, 'model-refused', 'sha256-mismatch')
        self.assertEqual(payload['model'], 'pp-ocrv6-det-small')

    def test_symlinked_model(self):
        models = self.model_copy()
        target = os.path.join(models, 'PP-OCRv6_rec_small.onnx')
        os.unlink(target)
        os.symlink(os.path.join(MODELS, 'PP-OCRv6_rec_small.onnx'), target)
        proc, _, _ = self.run_cli(self.input, models=models)
        self.assert_refused(proc, 3, 'model-refused', 'not-regular-file')

    def test_manifest_size_mismatch(self):
        manifest = read_json(MANIFEST)
        manifest['models'][1]['bytes'] += 1
        path = self.path('manifest.json')
        write_json(path, manifest)
        proc, _, _ = self.run_cli(self.input, manifest=path)
        self.assert_refused(proc, 3, 'model-refused', 'size-mismatch')

    def test_manifest_path_traversal(self):
        manifest = read_json(MANIFEST)
        manifest['models'][0]['file'] = '../PP-OCRv6_det_small.onnx'
        path = self.path('manifest.json')
        write_json(path, manifest)
        proc, _, _ = self.run_cli(self.input, manifest=path)
        self.assert_refused(proc, 3, 'model-refused', 'manifest-invalid')

    def test_self_test_refuses(self):
        models = self.model_copy()
        os.unlink(os.path.join(models, 'th_PP-OCRv5_rec_mobile.onnx'))
        proc = subprocess.run([PYTHON, '-I', SCRIPT, '--self-test', '--models', models, '--manifest', MANIFEST],
                              capture_output=True, text=True, timeout=120)
        self.assert_refused(proc, 3, 'model-refused', 'missing')


@needs_models
class MaliciousInputTest(OcrCliCase):
    def test_png_decompression_bomb_over_side_limit(self):
        path = self.write('bomb.png', png_bomb(60000, 60000))
        proc, _, elapsed = self.run_cli(path)
        # Pillow's bomb check at open() fires before our side-length check.
        payload = self.assert_refused(proc, 4, 'input-refused')
        self.assertIn(payload['reason'], ('too-many-pixels', 'dimensions-out-of-range'))
        self.assertLess(elapsed, 15)

    def test_png_decompression_bomb_over_pixel_limit(self):
        for size in ((20000, 20000), (8000, 7000)):  # past 2x MAX_IMAGE_PIXELS, then just past it
            path = self.write('bomb.png', png_bomb(*size))
            proc, _, _ = self.run_cli(path)
            self.assert_refused(proc, 4, 'input-refused', 'too-many-pixels')

    def test_jpeg_huge_declared_dimensions(self):
        path = self.write('huge.jpg', jpeg_with_dimensions(29000, 29000))
        proc, _, elapsed = self.run_cli(path)
        self.assert_refused(proc, 4, 'input-refused', 'too-many-pixels')
        self.assertLess(elapsed, 15)
        path = self.write('wide.jpg', jpeg_with_dimensions(65000, 16))
        proc, _, _ = self.run_cli(path)
        self.assert_refused(proc, 4, 'input-refused', 'dimensions-out-of-range')

    def test_tiff_frame_bomb_is_bounded(self):
        frames = [Image.new('L', (8, 8), 255) for _ in range(3000)]
        path = self.path('many.tif')
        frames[0].save(path, format='TIFF', save_all=True, append_images=frames[1:])
        proc, result, elapsed = self.run_cli(path, '--max-frames', '64')
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(len(result['frames']), 64)
        self.assertTrue(result['truncatedFrames'])
        self.assertLess(elapsed, 30)
        self.assertLess(result['peakRssKb'], 1_500_000)

    def test_tiff_ifd_loop(self):
        path = self.path('loop.tif')
        tiff_ifd_loop(path)
        proc, result, elapsed = self.run_cli(path)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(len(result['frames']), 2)
        self.assertFalse(result['truncatedFrames'])
        self.assertLess(elapsed, 30)

    def test_truncated_png(self):
        buffer = io.BytesIO()
        Image.effect_noise((800, 800), 64).convert('RGB').save(buffer, format='PNG')
        path = self.write('trunc.png', buffer.getvalue()[: len(buffer.getvalue()) // 2])
        proc, _, _ = self.run_cli(path)
        self.assert_refused(proc, 4, 'input-refused', 'decode-failed')

    def test_truncated_jpeg(self):
        buffer = io.BytesIO()
        Image.effect_noise((800, 800), 64).convert('RGB').save(buffer, format='JPEG')
        path = self.write('trunc.jpg', buffer.getvalue()[: len(buffer.getvalue()) // 2])
        proc, _, _ = self.run_cli(path)
        self.assert_refused(proc, 4, 'input-refused', 'decode-failed')

    def test_pdf_bytes_as_image(self):
        path = self.write('doc.pdf', b'%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n')
        proc, _, _ = self.run_cli(path)
        self.assert_refused(proc, 4, 'input-refused', 'unsupported-format')

    def test_eps(self):
        eps = b'%!PS-Adobe-3.0 EPSF-3.0\n%%BoundingBox: 0 0 100 100\nshowpage\n%%EOF\n'
        path = self.write('x.eps', eps)
        proc, _, _ = self.run_cli(path)
        self.assert_refused(proc, 4, 'input-refused', 'unsupported-format')

    def test_symlink_input(self):
        real = self.save(Image.new('RGB', (64, 64), 'white'), 'real.png')
        link = self.path('link.png')
        os.symlink(real, link)
        proc, _, _ = self.run_cli(link)
        self.assert_refused(proc, 4, 'input-refused', 'input-not-regular-file')

    def test_oversize_input(self):
        path = self.save(Image.new('RGB', (64, 64), 'white'), 'small.png')
        proc, _, _ = self.run_cli(path, '--max-input-bytes', '16')
        self.assert_refused(proc, 4, 'input-refused', 'input-too-large')


if __name__ == '__main__':
    unittest.main()
