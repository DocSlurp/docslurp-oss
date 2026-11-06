import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { manifestModels } from './fetch-ocr-models.mjs';

const script = fileURLToPath(new URL('./fetch-ocr-models.mjs', import.meta.url));
const sha = (text) => createHash('sha256').update(text).digest('hex');
const base = 'https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.10.0/onnx';

function fixture(models, files) {
  const dir = mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'docslurp-ocr-models-'));
  const mirror = path.join(dir, 'mirror');
  mkdirSync(mirror);
  for (const [name, text] of Object.entries(files)) writeFileSync(path.join(mirror, name), text);
  writeFileSync(path.join(dir, 'ocr-models.json'), JSON.stringify({ models }));
  return dir;
}
const run = (dir) => spawnSync(process.execPath, [script, '--manifest', path.join(dir, 'ocr-models.json'), '--out', path.join(dir, 'out'), '--source-dir', path.join(dir, 'mirror')], { encoding: 'utf8' });

test('writes every pinned model after verifying its sha256', () => {
  const dir = fixture([
    { name: 'det', url: `${base}/det.onnx`, sha256: sha('det') },
    { name: 'rec', file: 'rec.onnx', url: `${base}/x/rec.onnx`, sha256: sha('rec'), size: 3 },
  ], { 'det.onnx': 'det', 'rec.onnx': 'rec' });
  try {
    const result = run(dir);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(path.join(dir, 'out', 'det.onnx'), 'utf8'), 'det');
    assert.equal(readFileSync(path.join(dir, 'out', 'rec.onnx'), 'utf8'), 'rec');
    assert.match(result.stdout, /verified 2 models/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('fails on a sha256 mismatch and writes nothing', () => {
  const dir = fixture([
    { name: 'det', url: `${base}/det.onnx`, sha256: sha('det') },
    { name: 'rec', url: `${base}/rec.onnx`, sha256: sha('rec') },
  ], { 'det.onnx': 'det', 'rec.onnx': 'tampered' });
  try {
    const result = run(dir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /sha256 mismatch for rec\.onnx/);
    assert.equal(existsSync(path.join(dir, 'out', 'det.onnx')), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('rejects unsafe file names, non-https urls, bad pins and duplicates', () => {
  assert.throws(() => manifestModels({ models: [{ file: '../x.onnx', url: `${base}/x.onnx`, sha256: sha('x') }] }), /unsafe file name/);
  assert.throws(() => manifestModels({ models: [{ file: 'a/b.onnx', url: `${base}/x.onnx`, sha256: sha('x') }] }), /unsafe file name/);
  assert.throws(() => manifestModels({ models: [{ url: 'http://example.com/x.onnx', sha256: sha('x') }] }), /https/);
  assert.throws(() => manifestModels({ models: [{ url: `${base}/x.onnx`, sha256: 'abc' }] }), /sha256/);
  assert.throws(() => manifestModels({ models: [{ url: `${base}/x.onnx`, sha256: sha('x') }, { url: `${base}/y/x.onnx`, sha256: sha('y') }] }), /listed twice/);
  assert.throws(() => manifestModels({ models: [] }), /no models/);
  assert.equal(manifestModels({ models: { det: { url: `${base}/det.onnx`, sha256: sha('d') } } })[0].file, 'det.onnx');
});
