#!/usr/bin/env node
// Fetches the optional runtime assets of the native PDF engine into one directory:
//   <out>/ocr-models  PP-OCRv6 small detector + recognizer (RTen) and dictionary, Apache-2.0 (~30 MB)
//   <out>/fonts       Noto Sans/Serif CJK JP/KR/SC/TC subset fonts, SIL OFL 1.1 (~42 MB)
// Every source archive and every extracted file is pinned by sha256; any mismatch fails.
// The worker points the engine at them via NATIVE_PDF_OCR_MODEL_DIR / NATIVE_PDF_FONTS_DIR.
//
//   node scripts/fetch-native-pdf-assets.mjs --out DIR [--ocr-models=1] [--cjk-fonts=1] [--cache DIR]
//
// A set is fetched when its flag is 1/true, skipped when the flag is absent or empty (so a Docker build
// arg can pass straight through), and any other value is an error. <out> is always created, so an image
// can COPY it unconditionally; with no set selected it stays empty.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { inflateRawSync } from "node:zlib";

/**
 * Pins. The OCR models are pylopdf-ocr-models 0.1.0 (RTen conversions of the RapidOCR PP-OCRv6 small ONNX
 * files, model copyright Baidu, Apache-2.0); the fonts are the noto-cjk SubsetOTF files as packaged by
 * pylopdf-fonts-* 0.1.1. Per-file hashes match the engine's documented runtime assets.
 */
export const NATIVE_PDF_ASSET_SETS = {
  "ocr-models": {
    dir: "ocr-models",
    archives: [
      {
        url: "https://files.pythonhosted.org/packages/eb/2f/600942fa646d4005cf7d3fc5ace072ba852f04f14bf5d4b63dc98743c94c/pylopdf_ocr_models-0.1.0-py3-none-any.whl",
        sha256: "067acc9a39ca0dc7dd2b059c2180f9afa44c101a63d56c944b0b9c340d0c906d",
        files: {
          "pylopdf_ocr_models/PP-OCRv6_det_small.rten": "57c5778be784d7aace438a4ea1926864a7b5fd3d49c8e577799f8a83e8dcb022",
          "pylopdf_ocr_models/PP-OCRv6_rec_small.rten": "b6eef947901c5ff0bf6ee62d8b46f58b1423666f0ae0c87b2f42127502925f8f",
          "pylopdf_ocr_models/ppocrv6_dict.txt": "b5f2bfe2bdd9448429e3e82b51c789775d9b42f2403d082b00662eb77e401c5d",
        },
        notices: {
          "pylopdf_ocr_models-0.1.0.dist-info/licenses/LICENSE": "LICENSE-Apache-2.0.txt",
          "pylopdf_ocr_models-0.1.0.dist-info/licenses/NOTICE": "NOTICE.txt",
        },
      },
    ],
  },
  "cjk-fonts": {
    dir: "fonts",
    archives: [
      {
        url: "https://files.pythonhosted.org/packages/2e/41/af779ef8ead28efbf0086e7b4a9f5dfaba5d5bdad5e6b4e822b354e1dd64/pylopdf_fonts_jp-0.1.1-py3-none-any.whl",
        sha256: "7fd33378751d0fd2c4a87824c11e0e0cc55350150d8da4c1e5ae90925c0a1cf5",
        files: {
          "pylopdf_fonts_jp/NotoSansJP-Regular.otf": "dff723ba59d57d136764a04b9b2d03205544f7cd785a711442d6d2d085ac5073",
          "pylopdf_fonts_jp/NotoSerifJP-Regular.otf": "2c9a12dbd4f2408c4610c7ee84a108b62d7236c3775baed618c64d9cb44b2f04",
        },
        notices: { "pylopdf_fonts_jp-0.1.1.dist-info/licenses/LICENSE": "LICENSE-OFL-1.1.txt" },
      },
      {
        url: "https://files.pythonhosted.org/packages/0a/07/47240827f268d47058024cbd0e0abff7aa8bc19c62e8ad6c6d7f6fc83169/pylopdf_fonts_ko-0.1.1-py3-none-any.whl",
        sha256: "a31ece5cf71d2869f9221f95ab120d341de6028338aa074ad969611e54e40e57",
        files: {
          "pylopdf_fonts_ko/NotoSansKR-Regular.otf": "69975a0ac8472717870aefeab0a4d52739308d90856b9955313b2ad5e0148d68",
          "pylopdf_fonts_ko/NotoSerifKR-Regular.otf": "5ea012e15cb7eacc1f680aee1703f3b164791b1443ea3e52b65080cca5d179cf",
        },
        notices: {},
      },
      {
        url: "https://files.pythonhosted.org/packages/16/cc/acdc4681981f1484de20fe445bb28b588fd453a824c1d5626a9c2fd0f2d5/pylopdf_fonts_zh_cn-0.1.1-py3-none-any.whl",
        sha256: "e2661ef3790cbe0f0f6aa5338b6859b7cd288ee75bc88cd4239c62cd025d4fb3",
        files: {
          "pylopdf_fonts_zh_cn/NotoSansSC-Regular.otf": "faa6c9df652116dde789d351359f3d7e5d2285a2b2a1f04a2d7244df706d5ea9",
          "pylopdf_fonts_zh_cn/NotoSerifSC-Regular.otf": "e8f396decc1f0963a016a989c3d8852e863d1350996f573860a80767c83a1cd3",
        },
        notices: {},
      },
      {
        url: "https://files.pythonhosted.org/packages/d8/4b/5bb5810755a63891e7ec2bb9cb46115eaca788612148136292eddebffc33/pylopdf_fonts_zh_tw-0.1.1-py3-none-any.whl",
        sha256: "8b8acabf814f8d4f6cf0773614031be50c3b1020302397c4904726e099c0afde",
        files: {
          "pylopdf_fonts_zh_tw/NotoSansTC-Regular.otf": "5bab0cb3c1cf89dde07c4a95a4054b195afbcfe784d69d75c340780712237537",
          "pylopdf_fonts_zh_tw/NotoSerifTC-Regular.otf": "63515eb0622d589a2f4062e8757c598b3da3bffd053f69abd181c210158ef10c",
        },
        notices: {},
      },
    ],
  },
};

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Extracts the named entries of a zip archive (stored or deflated), read through its central directory. */
export function unzipEntries(zip, names) {
  const wanted = new Set(names);
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65557); i -= 1) {
    if (zip.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a zip archive (no end of central directory)");
  const count = zip.readUInt16LE(eocd + 10);
  let at = zip.readUInt32LE(eocd + 16);
  const out = new Map();
  for (let n = 0; n < count; n += 1) {
    if (zip.readUInt32LE(at) !== 0x02014b50) throw new Error("corrupt zip central directory");
    const method = zip.readUInt16LE(at + 10);
    const compressedSize = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    const localOffset = zip.readUInt32LE(at + 42);
    const name = zip.toString("utf8", at + 46, at + 46 + nameLength);
    at += 46 + nameLength + extraLength + commentLength;
    if (!wanted.has(name)) continue;
    if (zip.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`corrupt zip local header for ${name}`);
    const dataStart = localOffset + 30 + zip.readUInt16LE(localOffset + 26) + zip.readUInt16LE(localOffset + 28);
    const data = zip.subarray(dataStart, dataStart + compressedSize);
    if (method === 0) out.set(name, Buffer.from(data));
    else if (method === 8) out.set(name, inflateRawSync(data));
    else throw new Error(`unsupported zip compression method ${method} for ${name}`);
  }
  const missing = names.filter((name) => !out.has(name));
  if (missing.length > 0) throw new Error(`archive is missing ${missing.join(", ")}`);
  return out;
}

async function download(archive, cacheDir) {
  const cached = cacheDir ? path.join(cacheDir, `${archive.sha256}.zip`) : null;
  if (cached && existsSync(cached)) {
    const bytes = await readFile(cached);
    if (sha256(bytes) === archive.sha256) return bytes;
  }
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(archive.url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      const actual = sha256(bytes);
      if (actual !== archive.sha256) {
        throw Object.assign(new Error(`sha256 mismatch for ${archive.url}: expected ${archive.sha256}, got ${actual}`), { fatal: true });
      }
      if (cached) {
        await mkdir(cacheDir, { recursive: true });
        await writeFile(`${cached}.tmp`, bytes);
        await rename(`${cached}.tmp`, cached);
      }
      return bytes;
    } catch (error) {
      if (error.fatal) throw error;
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
    }
  }
  throw new Error(`download failed for ${archive.url}: ${lastError?.message ?? lastError}`);
}

export async function fetchAssetSet(name, outDir, { cacheDir } = {}) {
  const set = NATIVE_PDF_ASSET_SETS[name];
  const target = path.join(outDir, set.dir);
  await mkdir(target, { recursive: true });
  let bytesWritten = 0;
  for (const archive of set.archives) {
    const zip = await download(archive, cacheDir);
    const entries = unzipEntries(zip, [...Object.keys(archive.files), ...Object.keys(archive.notices)]);
    for (const [entry, expected] of Object.entries(archive.files)) {
      const bytes = entries.get(entry);
      const actual = sha256(bytes);
      if (actual !== expected) throw new Error(`sha256 mismatch for ${entry}: expected ${expected}, got ${actual}`);
      await writeFile(path.join(target, path.basename(entry)), bytes);
      bytesWritten += bytes.length;
    }
    for (const [entry, fileName] of Object.entries(archive.notices)) {
      await writeFile(path.join(target, fileName), entries.get(entry));
    }
  }
  return { name, dir: target, bytes: bytesWritten };
}

/** "1"/"true" → fetch, absent/"" → skip, anything else → error (a typo must not silently ship nothing). */
export function parseAssetFlag(name, value) {
  const normalized = (value ?? "").trim().toLowerCase();
  if (normalized === "") return false;
  if (normalized === "1" || normalized === "true") return true;
  throw new Error(`--${name} must be 1, true or empty, got ${JSON.stringify(value)}`);
}

async function main(argv) {
  const value = (flag) => {
    const inline = argv.find((arg) => arg.startsWith(`--${flag}=`));
    if (inline) return inline.slice(flag.length + 3);
    const i = argv.indexOf(`--${flag}`);
    if (i < 0) return undefined;
    const next = argv[i + 1];
    return next === undefined || next.startsWith("--") ? "1" : next;
  };
  const out = value("out");
  if (!out) {
    console.error("usage: fetch-native-pdf-assets.mjs --out DIR [--ocr-models=1] [--cjk-fonts=1] [--cache DIR]");
    process.exit(2);
  }
  const outDir = path.resolve(out);
  await mkdir(outDir, { recursive: true });
  const cache = value("cache");
  for (const name of Object.keys(NATIVE_PDF_ASSET_SETS)) {
    if (!parseAssetFlag(name, value(name))) continue;
    const result = await fetchAssetSet(name, outDir, { cacheDir: cache ? path.resolve(cache) : undefined });
    console.log(`[native-pdf] ${name}: ${(result.bytes / 1048576).toFixed(1)} MiB verified into ${result.dir}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`[native-pdf] asset fetch failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
