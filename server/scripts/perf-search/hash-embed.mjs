// Deterministic feature-hashing text embedding (384-d, L2-normalised): unigrams + bigrams, signed hashing, sublinear tf.
// Stand-in for a remote embedding model so the search path can be profiled on a CPU-starved shared host.
import { createHash } from "node:crypto";
export const DIM = 384;
const h = (s) => createHash("md5").update(s).digest();
const cache = new Map();
function slot(tok) { let v = cache.get(tok); if (!v) { const b = h(tok); v = [b.readUInt32LE(0) % DIM, b[4] & 1 ? 1 : -1]; if (cache.size < 2e6) cache.set(tok, v); } return v; }
export function hashEmbed(text) {
  const words = text.toLowerCase().match(/[a-z0-9][a-z0-9_.-]*/g) ?? [];
  const tf = new Map();
  for (let i = 0; i < words.length; i++) {
    tf.set(words[i], (tf.get(words[i]) ?? 0) + 1);
    if (i + 1 < words.length) tf.set(words[i] + " " + words[i + 1], (tf.get(words[i] + " " + words[i + 1]) ?? 0) + 0.5);
  }
  const v = new Float64Array(DIM);
  for (const [t, c] of tf) { const [s, sg] = slot(t); v[s] += sg * (1 + Math.log(c)); }
  let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1;
  return Array.from(v, (x) => x / n);
}
