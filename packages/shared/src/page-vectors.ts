// Pure helpers for Visual Pages: sign-bit + int8 page vectors. No dependencies.

const POPCOUNT = (() => {
  const table = new Uint8Array(256);
  for (let i = 1; i < 256; i++) table[i] = (table[i >> 1] ?? 0) + (i & 1);
  return table;
})();

/** Bit i set when v[i] >= 0, MSB-first within each byte. */
export function packSignBits(vector: ArrayLike<number>): Uint8Array {
  const out = new Uint8Array(Math.ceil(vector.length / 8));
  for (let i = 0; i < vector.length; i++) {
    if ((vector[i] as number) >= 0) out[i >> 3] = (out[i >> 3] as number) | (0x80 >> (i & 7));
  }
  return out;
}

/** Symmetric int8 quantization; `scale = max|v| / 127` (dequantize: value * scale). */
export function quantizeInt8(vector: ArrayLike<number>): { values: Int8Array; scale: number } {
  let max = 0;
  for (let i = 0; i < vector.length; i++) {
    const a = Math.abs(vector[i] as number);
    if (a > max) max = a;
  }
  const scale = max / 127;
  const values = new Int8Array(vector.length);
  if (scale > 0) {
    // Round half away from zero so +x and -x quantize symmetrically.
    for (let i = 0; i < vector.length; i++) {
      const q = (vector[i] as number) / scale;
      values[i] = q < 0 ? -Math.round(-q) : Math.round(q);
    }
  }
  return { values, scale };
}

export function l2Normalize(vector: ArrayLike<number>): Float32Array {
  let sum = 0;
  for (let i = 0; i < vector.length; i++) sum += (vector[i] as number) ** 2;
  const norm = Math.sqrt(sum);
  const out = new Float32Array(vector.length);
  if (norm > 0) for (let i = 0; i < vector.length; i++) out[i] = (vector[i] as number) / norm;
  return out;
}

/**
 * Bounded max-heap top-k keeping the smallest keys. Returns ascending by key
 * (ties by index). Allocation-free while scanning: only the heap arrays.
 */
class SmallestK {
  readonly keys: Float64Array;
  readonly idx: Int32Array;
  size = 0;
  constructor(readonly k: number) {
    this.keys = new Float64Array(k);
    this.idx = new Int32Array(k);
  }
  /** Current worst accepted key, or Infinity while not full. */
  get threshold(): number {
    return this.size < this.k ? Infinity : (this.keys[0] as number);
  }
  push(key: number, index: number): void {
    if (this.k === 0) return;
    const { keys, idx } = this;
    if (this.size < this.k) {
      let i = this.size++;
      while (i > 0) {
        const parent = (i - 1) >> 1;
        if ((keys[parent] as number) >= key) break;
        keys[i] = keys[parent] as number;
        idx[i] = idx[parent] as number;
        i = parent;
      }
      keys[i] = key;
      idx[i] = index;
      return;
    }
    if (key >= (keys[0] as number)) return;
    let i = 0;
    for (;;) {
      let child = 2 * i + 1;
      if (child >= this.size) break;
      if (child + 1 < this.size && (keys[child + 1] as number) > (keys[child] as number)) child++;
      if ((keys[child] as number) <= key) break;
      keys[i] = keys[child] as number;
      idx[i] = idx[child] as number;
      i = child;
    }
    keys[i] = key;
    idx[i] = index;
  }
  sorted(): Array<{ index: number; key: number }> {
    const out: Array<{ index: number; key: number }> = [];
    for (let i = 0; i < this.size; i++) out.push({ index: this.idx[i] as number, key: this.keys[i] as number });
    out.sort((a, b) => a.key - b.key || a.index - b.index);
    return out;
  }
}

/** Exact Hamming top-k (smallest distance first) over packed sign-bit vectors. */
export function hammingTopK(
  query: Uint8Array,
  corpus: Uint8Array,
  bytesPerVector: number,
  k: number,
): Array<{ index: number; distance: number }> {
  const count = Math.floor(corpus.length / bytesPerVector);
  const heap = new SmallestK(Math.min(k, count));
  const table = POPCOUNT;
  for (let n = 0; n < count; n++) {
    const base = n * bytesPerVector;
    const limit = heap.threshold;
    let distance = 0;
    for (let b = 0; b < bytesPerVector; b++) {
      distance += table[(corpus[base + b] as number) ^ (query[b] as number)] as number;
      if (distance >= limit) break;
    }
    if (distance < limit) heap.push(distance, n);
  }
  return heap.sorted().map((e) => ({ index: e.index, distance: e.key }));
}

/** Score float query against sign-bit corpus: sum of q[i] * (bit ? +1 : -1). Higher is better. */
export function asymmetricBitScoreTopK(
  query: Float32Array,
  corpus: Uint8Array,
  dims: number,
  k: number,
): Array<{ index: number; score: number }> {
  const bytes = Math.ceil(dims / 8);
  const count = Math.floor(corpus.length / bytes);
  const heap = new SmallestK(Math.min(k, count));
  for (let n = 0; n < count; n++) {
    const base = n * bytes;
    let score = 0;
    for (let i = 0; i < dims; i++) {
      const bit = ((corpus[base + (i >> 3)] as number) >> (7 - (i & 7))) & 1;
      score += bit ? (query[i] as number) : -(query[i] as number);
    }
    heap.push(-score, n);
  }
  return heap.sorted().map((e) => ({ index: e.index, score: -e.key }));
}

/** Cosine rescore of candidates against the int8 corpus; best first. */
export function int8Rescore(
  query: Float32Array,
  candidates: Array<{ index: number }>,
  int8Corpus: Int8Array,
  scales: Float32Array,
  dims: number,
): Array<{ index: number; score: number }> {
  let qNorm = 0;
  for (let i = 0; i < dims; i++) qNorm += (query[i] as number) ** 2;
  qNorm = Math.sqrt(qNorm) || 1;
  const out: Array<{ index: number; score: number }> = [];
  for (const { index } of candidates) {
    const base = index * dims;
    let dot = 0;
    let norm = 0;
    for (let i = 0; i < dims; i++) {
      const v = int8Corpus[base + i] as number;
      dot += (query[i] as number) * v;
      norm += v * v;
    }
    // scale cancels in cosine; kept in the signature so callers can swap to dot-product scoring.
    void scales;
    out.push({ index, score: dot / (qNorm * (Math.sqrt(norm) || 1)) });
  }
  return out.sort((a, b) => b.score - a.score || a.index - b.index);
}
