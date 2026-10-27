# Worker image and vendor bundles

How the production worker image stays well under Fly's image limit, and how the
heavy optional extractors (Unstructured) are installed on demand from
prebuilt, sha256-pinned bundles instead of runtime `pip install`.

## Fly limits that matter

| Limit | Value | Source |
| --- | --- | --- |
| Image size (Machines, non-GPU) | ~8 GB **uncompressed**; deploys fail with "Not enough space to unpack image, possibly exceeds maximum of 8GB uncompressed". GPU machines: up to 50 GB. | [Fly community: limit raised 2 GB to 8 GB](https://community.fly.io/t/docker-image-size-limit-raised-from-2gb-to-8gb/14749), [error report, 2025](https://community.fly.io/t/oracle-not-enough-space-to-unpack-image-possibly-exceeds-maximum-of-8gb-uncompressed/24049) |
| Writable root layer | 7.8 GB overlay upper layer, measured with `df -h /` on a `docslurp-worker` machine (2026-10-14). The image is the read-only lower layer. `/tmp`, `~/.cache` (the bge-m3 embedding model is about 560 MB) and unpacked vendor bundles all share this space. It is reset when the machine stops unless `persist_rootfs` is set. | [Fly community: A new way to RootFS](https://community.fly.io/t/a-new-way-to-rootfs/19196), `fly machine create --rootfs-size` ([docs](https://docs.fly.io/flyctl/machine-create)) |

Fly does not publish the 8 GB figure on a docs page. It comes from the announcement
and from the deploy error text. The CI image budget (below) is set well under it.

## What is in each image

| | `Dockerfile.lean` (production, `fly.worker.toml`) | `Dockerfile.full` (self-host `--profile full`) |
| --- | --- | --- |
| Node | worker-only production `node_modules` from `pnpm deploy`, pruned | same |
| System tools | poppler-utils + poppler-data (CJK CMaps), Tesseract (eng, deu, fra, spa, ara, chi_sim, chi_tra, ell, heb, hin, ita, jpn, kor, nld, pol, por, rus, tha, tur, ukr, vie), cwebp (lossless WebP page images), pandoc, ffmpeg, ClamAV, bubblewrap; fonts for non-embedded PDF fonts: URW base-35 and Liberation (metric-compatible Times/Helvetica/Courier and Arial/Times New Roman/Courier New), Noto core (Arabic, Hebrew, Thai, Devanagari, Greek, Cyrillic), Droid Sans Fallback (CJK) | adds LibreOffice, ocrmypdf, ghostscript, ImageMagick, qpdf, catdoc, unrtf; Noto CJK instead of Droid Sans Fallback |
| Python venv `/app/.venv` | base parsers: trafilatura, ebooklib, python-pptx, openpyxl, xlsx2csv, Pillow (wheel-only, read-only) | same, plus pip for the legacy first-boot install |
| Unstructured | vendor bundles, fetched on first use | vendor bundles, or the legacy first-boot pip install when no bundle source is configured |
| Kreuzberg, LiteParse, mammoth, LanceDB, transformers.js | in `node_modules` | same |
| Native PDF engine | optional, `DOCSLURP_NATIVE_PDF=1`; PDFs otherwise use Kreuzberg and Poppler (PyMuPDF/pymupdf4llm and the MuPDF `mupdf-tools` apt package were removed 2026-10-15: AGPL) | same |
| Runtime pip installs | off (`DOCSLURP_PYTHON_LAZY_INSTALL=false`) | on for the first-boot path only |

### Images without Tesseract data

Both images ship Tesseract and its 21 languages. On the lean image they add 107 MiB (the apt delta for
`tesseract-ocr` and the language packs, measured 2026-10-26; the image is 2,085 MiB uncompressed). The prerequisite
check fails the build, and a `lean` or `full` worker's startup, if any language is missing. Production therefore OCRs
images locally, in the parser sandbox, instead of sending them to vision. Image OCR uses English unless the
extractor config sets `ocr.language`, so text in other scripts may come out poor; `DOCSLURP_OCR=off` restores
vision-first routing. A self-built image or local setup without the language data falls back
as follows. Kreuzberg's bundled Tesseract otherwise looks for that data at the path of the machine that built it. The extractor planner therefore checks for `<lang>.traineddata` in
`TESSDATA_PREFIX` and Kreuzberg's system locations (`worker/src/extractors/ocr-capability.ts`) before offering
Kreuzberg for an image, and `DOCSLURP_OCR=off` forces that answer. With no OCR, or when Kreuzberg's OCR still
fails, an image continues with empty text so page triage and the vision stage read it (manifest and stage stats
record `textlessFallback`). If the workspace has vision fallback off, or its privacy mode forbids the vision
route, the document fails with the public message "This image can only be read with OCR or vision, and neither is
available for this workspace." and the raw cause stays in the stored error and logs. PDFs are unaffected: Kreuzberg
reads their text layer and does not OCR them by default; scanned pages reach vision through page triage.

### Measured sizes (local builds, 2026-10-14, linux/amd64)

"Uncompressed" is `du -sxm /` inside the image (what Fly unpacks). "Compressed" is
`docker save | gzip -6`, close to registry transfer size.

| Image | Uncompressed | Compressed |
| --- | --- | --- |
| lean, before (origin/main) | 4,935 MiB | 1,516 MiB |
| **lean, after** | **1,884 MiB** | **615 MiB** |
| lean with PyMuPDF removed (2026-10-15, `DOCSLURP_NATIVE_PDF=1`, measured against the same build with PyMuPDF: 1,897 to 1,832 MiB) | 1,832 MiB | 629 MB registry content (656 MB before) |
| production `docslurp-worker` today (measured on a machine) | ~4,280 MiB | 1,082 MiB (registry manifest) |
| full, before (origin/main) | 7,196 MiB, plus about 3.8 GB pip-installed onto the rootfs at first boot | 2,563 MiB |
| **full, after** (now also includes ffmpeg) | **2,552 MiB** | **873 MiB** |
| `docling` bundle | 1,743 MiB unpacked | 656 MiB `.tar.zst` |
| `unstructured` bundle | 2,085 MiB unpacked | 599 MiB `.tar.zst` |

Neither lean measurement includes baked ClamAV signatures (about 110 MB on the
production machine) or the private native PDF engine. Both sizes grow by the same
amount when those are included.

### Where the fat was

1. **The pnpm content store shipped in the image**, plus the workspace root's
   dependencies. `pnpm install --filter @docslurp/worker... --prod` in the
   runtime stage left `/root/.local/share/pnpm/store` (1.86 GB on the production
   machine) and installed `better-auth` with its prisma/effect/typescript tree
   (the root `package.json` depends on it). The worker never imports it. The
   builder now runs `pnpm deploy --prod --legacy` and copies only the result.
2. **Foreign native binaries and a duplicate ONNX Runtime.**
   `scripts/prune-worker-node-modules.mjs` removes onnxruntime-node builds for
   darwin, win32 and the other Linux architecture (about 240 MB), Temporal
   core-bridge builds for the other four platforms (about 110 MB), and LanceDB's
   unused optional `@huggingface/transformers@3`, which brings its own
   onnxruntime-node 1.19 and onnxruntime-web 1.21 (about 300 MB). It also drops
   CUDA/TensorRT providers if they are present, source maps, `.d.ts` files and
   Markdown docs. In the image build, `node_modules` goes from 1,872 MiB to 681 MiB
   after `pnpm deploy`.
3. **Python heavy stack.** A full `requirements.txt` install is 3.85 GB. The
   largest items: triton (891 MB, pulled in by `openai-whisper` via
   `unstructured[all-docs]` and useless on CPU), torch (708 MB), Python
   LanceDB + pyarrow (340 MB, unused because the worker writes LanceDB from Node),
   two OpenCV builds (270 MB), pypandoc's bundled pandoc (155 MB, a duplicate of
   apt pandoc), and chromadb/kubernetes. The bundles keep only what each extractor
   imports, use CPU-only torch, and leave out the audio extras.
4. **Duplicate models.** `docling-tools models download` fetches the layout model
   twice (safetensors and ONNX, 171 MB each), TableFormer "fast" and "accurate",
   and RapidOCR weights for both backends. The bundle keeps the copy each CLI
   default actually loads. An offline conversion in the bundle build proves it.
5. Smaller items: the native PDF tarball no longer lands in a layer, yarn and
   apt docs are removed, and the venv is wheel-only with no pip, tests or
   setuptools. Its bytecode is precompiled because the non-root user cannot write
   `__pycache__` and every parser call starts a fresh interpreter.

Not trimmed yet (candidates):
- Debian's ffmpeg pulls in mesa and LLVM (about 250 MB) through its hardware
  decode libraries. A static CPU-only ffmpeg build would remove that, but it is
  a supply-chain change.
- onnxruntime-web ships about 85 MB of WASM variants that the Node runtime never
  loads. transformers.js imports the package statically, so pruning it needs care.

## Vendor bundles

Docling was retired on 2026-10-21 because its Pillow <13 constraint prevented
security fixes. It is no longer installed, advertised, or selected by the worker.
Use Kreuzberg, native-pdf, or Poppler for PDF extraction. Historical Docling size
and timing measurements below describe the retired bundle. Only Unstructured
is supported by the current bundle manifest.


A bundle is a relocatable, content-addressed `.tar.zst` containing:

```text
site-packages/   wheel-only `--target` install, CPU torch, deduplicated against the
                 image's base venv, unchecked-hash bytecode (valid after unpack)
bin/<tool>       Python shims that put ../site-packages first on sys.path
models/          weights fetched at build time (the parser sandbox has no network)
```

Declared bundles (`worker/vendor-bundles.json`):

| Bundle | Provides | Notes |
| --- | --- | --- |
| `unstructured` | `unstructured`, `unstructured_inference` modules | document extras only (no whisper/triton) plus the default hi_res layout model |

### Trust and integrity

- **Trust root:** `worker/vendor-bundles.json` is baked into the image and pins
  each artifact's `sha256`, compressed `size` and `unpackedSize` per platform
  (`linux-x64-py3.13`). The object store only serves bytes. The worker
  downloads `<base>/<bundle>/<sha256>.tar.zst`, stops if the stream exceeds the
  pinned size, and deletes the archive if the size or digest differs. Only then
  does it unpack. A compromised bucket can cause a failure but cannot inject code.
- **Extraction** (`worker/src/tools/safe-tar.ts`) treats the archive as untrusted
  anyway. It writes only regular files, directories and relative symlinks that
  stay inside the bundle. It refuses absolute paths, `..`, symlinks that escape
  the bundle, writes through a symlink, hard links, devices and FIFOs, and
  duplicate entries. It opens files with `O_EXCL` and strips setuid, setgid,
  sticky and group/world write bits (files become 0644 or 0755). It caps total
  bytes at the pinned `unpackedSize` and entries at 400k, and verifies the
  checksum of every header.
- **Install:** download and unpack into a private staging directory, write a
  marker containing the sha256, then atomically `rename` into
  `<cache>/<bundle>-<sha16>`. A `mkdir` lock per sha serialises processes on a
  machine. Holders refresh it every 15 s, and a lock with no refresh for 2 min
  counts as stale. Errors other than `EEXIST` (`EACCES`, `EROFS`, `ENOENT`) fail
  immediately instead of polling: polling on such an error caused the lean
  worker stall in October 2026. The worker checks free disk space before it
  downloads.
- **Runtime:** the unpacked bundle is bind-mounted read-only into the bubblewrap
  parser sandbox. Its `site-packages` goes on `PYTHONPATH` and its manifest `env`
  is applied (for example `HF_HOME` and `HF_HUB_OFFLINE=1`). Manifest `env` may not
  set loader, interpreter or credential variables (`LD_*`, `PATH`, `PYTHON*`,
  `AWS_*`, `DOCSLURP_VENDOR_BUNDLE*`, `*TOKEN*`, `*SECRET*`, `*KEY*`).
- **Timeouts and failures:** each install has its own budget
  (`DOCSLURP_VENDOR_BUNDLE_TIMEOUT_MS`, default 10 min). A caller's step timeout
  only stops that caller waiting; later callers share the same download. A
  failure is reported as `vendor bundle "unstructured" unavailable: <reason>` on that
  extractor candidate, other extractors continue, and the failure is cached for
  5 minutes so each candidate does not download again.
- **Build supply chain:** bundles are built in `worker/Dockerfile.bundles` from
  the same digest-pinned base as the worker, with a pinned uv and wheels only.
  The exceptions are pure-Python packages a requirements file names in an
  `allow-sdist` line (currently `langdetect`). The build fails if
  `nvidia*`/`triton`/CUDA packages appear. Archive metadata is normalised
  (sorted entries, mtime 0, uid 0, pax) and bytecode records relative paths.
  Rebuilding later can still resolve newer wheels, so a pin always refers to one
  specific build.

### Flags

| Variable | Default | Meaning |
| --- | --- | --- |
| `DOCSLURP_VENDOR_BUNDLE_BASE_URL` | unset (bundles off) | `s3://docslurp-vendor-bundles[/prefix]` (private bucket, authenticated GetObject), `https://…` (public mirror), `file:///dir` (air-gapped or volume), or `http://` on loopback only |
| `DOCSLURP_VENDOR_BUNDLE_S3_ENDPOINT` / `_REGION` | unset | S3-compatible endpoint (must be `https://`) and region, e.g. `https://s3.us-west-004.backblazeb2.com` / `us-west-004`. Region is required for `s3://`. |
| `DOCSLURP_VENDOR_BUNDLE_S3_ACCESS_KEY_ID` / `_SECRET_ACCESS_KEY` | unset | Read-only key for the bucket. Set as Fly secrets, never in `fly.worker.toml`. Never passed to bundle env or sandboxed children, and redacted from logs. |
| `DOCSLURP_VENDOR_BUNDLE_PREFETCH` | unset | Comma list (`unstructured`). Installs those bundles one after another in the background at worker start (unpack takes about 95 s). Never blocks readiness; failures are logged and the on-demand path still works. |
| `DOCSLURP_VENDOR_BUNDLES` | `on` when a base URL is set | `off` disables every bundle; a comma list (`unstructured`) enables only those bundles. |
| `DOCSLURP_VENDOR_BUNDLE_DIR` | image: `/home/docslurp/.cache/docslurp/vendor-bundles`; otherwise `/data/docslurp/vendor-bundles` when `/data` is writable, else `~/.cache/docslurp/vendor-bundles` | Unpack location. It must be writable by the worker user and must not be under `/app`. |
| `DOCSLURP_VENDOR_BUNDLE_TIMEOUT_MS` | `600000` | Download plus unpack budget per install |
| `DOCSLURP_VENDOR_BUNDLE_PYTHON` | `3.13` | Python minor version in the platform key |
| `DOCSLURP_PYTHON_LAZY_INSTALL` | `false` in images, `true` elsewhere | Runtime `pip install` fallback. Leave it off in images. |

Local development is unchanged: with no base URL, bundles are off, and the local
venv plus lazy installs work as before.

### Measured install (local, `file://` source, 8-core host)

These ran in the final lean image through `CommandRunner`, as uid 10001 with
`cap-drop ALL`, the worker's seccomp profile, the bubblewrap sandbox and no
network:

| Bundle | Verified copy | Unpack | First call (cold) | Next process |
| --- | --- | --- | --- | --- |
| docling (656 MiB, 33,740 files) | 1.9 s | 10.8 s | `docling --to md`, 1-page form: 24.7 s including install | 11.8 s, no download |
| unstructured (599 MiB, 39,952 files) | 1.6 s | 12.3 s | `partition_pdf` fast: 19.9 s including install | |

Downloads from same-region Tigris should take seconds too; unpacking is
disk-bound. With both bundles unpacked, a machine uses about 4 GB of its 7.8 GB
writable layer, so enable only the bundles a deployment needs. A shared CPU-torch
base bundle (torch is about 680 MB in each) is a possible follow-up.

### Building, publishing, pinning

```sh
# local build (output: .scratch/bundles/<bundle>-<platform>.{tar.zst,json})
docker buildx build -f worker/Dockerfile.bundles --build-arg BUNDLE=unstructured \
  --target export --output type=local,dest=.scratch/bundles .
```

In CI, **Actions → Vendor Bundles** (`workflow_dispatch` only) builds a bundle,
verifies the archive against its entry, uploads the manifest entry as an
artifact and, with `publish=true`, uploads `<prefix>/<bundle>/<sha256>.tar.zst`
(immutable, `Cache-Control: immutable`). It never deploys. To pin the result:

```sh
node scripts/vendor-bundles/update-manifest.mjs --entry unstructured-linux-x64-py3.13.json
git commit -am "Pin unstructured vendor bundle <sha12>"
```

The next worker deploy ships the new pin. Old objects can stay in the bucket so
older images keep working.

### Private bucket (Backblaze B2)

Bundles live in the **private** B2 bucket `docslurp-vendor-bundles` (S3-compatible API,
endpoint `https://s3.us-west-004.backblazeb2.com`, region `us-west-004`). Objects are
`<prefix>/<bundle>/<sha256>.tar.zst`. The worker fetches them with `GetObject` signed
by a read-only key; the sha256 pin in `worker/vendor-bundles.json` still decides what is
trusted, so the bucket being private is about access control, not integrity. Anonymous
requests return 401.

One-time setup:

1. Create the private bucket `docslurp-vendor-bundles`.
2. **Write key** (publishing only): a B2 application key restricted to that bucket
   with `listFiles`, `readFiles`, `writeFiles`. Store it as GitHub Actions secrets
   `VENDOR_BUNDLES_AWS_ACCESS_KEY_ID` / `VENDOR_BUNDLES_AWS_SECRET_ACCESS_KEY`, with
   variables `VENDOR_BUNDLES_BUCKET=docslurp-vendor-bundles` and
   `VENDOR_BUNDLES_ENDPOINT=https://s3.us-west-004.backblazeb2.com` (optional
   `VENDOR_BUNDLES_REGION`, `VENDOR_BUNDLES_PREFIX`). Use the same values as
   `VENDOR_BUNDLES_*` environment variables for local publishing.
3. **Read key** (workers): a second application key restricted to that bucket with
   `readFiles` only. Set it as Fly secrets on `docslurp-worker`:
   `fly secrets set -a <worker-app> DOCSLURP_VENDOR_BUNDLE_S3_ACCESS_KEY_ID=... DOCSLURP_VENDOR_BUNDLE_S3_SECRET_ACCESS_KEY=...`.
   Non-secret settings (`DOCSLURP_VENDOR_BUNDLE_BASE_URL=s3://docslurp-vendor-bundles`,
   `..._S3_ENDPOINT`, `..._S3_REGION`) go in `fly.worker.toml` `[env]`.
4. Publish with **Actions → Vendor Bundles** (`publish=true`) or from a workstation:

   ```sh
   node scripts/vendor-bundles/publish.mjs --entry .scratch/bundles/unstructured-linux-x64-py3.13.json
   ```

   The script uses multipart upload, skips an object that already exists with the same
   size, and HEADs the size afterwards. Then pin the entry with `update-manifest.mjs`.
5. Deploy the worker (manual) after the pin is committed.

An opt-in live check, `DOCSLURP_LIVE_VENDOR_BUNDLE_TEST=1 pnpm --filter @docslurp/worker exec vitest run src/__tests__/vendor-bundles-live.test.ts`,
installs `unstructured` from the real bucket into a scratch cache and deletes it.

## CI checks

`worker-supply-chain.yml` builds every worker Dockerfile. The production (lean)
image must stay at or under 2.5 GiB. It also checks that runtime pip is off, that
`/app` and the venv are not writable by uid 10001, that the bundle cache is
writable, and that no pnpm store, pnpm or venv pip ships. The other images keep
the 6 GiB budget and the "no torch/chromadb baked" check.
