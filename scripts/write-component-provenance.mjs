#!/usr/bin/env node
// Records where the third-party native components in a worker image come from, inside the image:
//   /usr/share/licenses/<name>/   license texts and PROVENANCE.json (public repository, pinned commit, source, files)
//   <sbom>                        an SPDX 2.3 document listing every component and its installed files with sha256
// Doppler is recorded when the image was built with it (DOCSLURP_DOPPLER=1, worker/doppler.json). An optional native PDF engine is recorded when its
// vendor manifest is installed; with DOCSLURP_NATIVE_PDF_INSTALLED=1 its manifest must name a public repository and a
// commit, or the build fails (a component without provenance never ships).
//
//   node scripts/write-component-provenance.mjs --doppler worker/doppler.json --doppler-prefix /usr/local \
//     [--engine-manifest /app/vendor-artifacts/native-pdf/manifest.json --engine-dir <installed package dir>] \
//     [--licenses /usr/share/licenses] [--sbom /usr/share/doc/docslurp/sbom/native-components.spdx.json]
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, copyFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const COMMIT = /^[0-9a-f]{40}$/;
const PUBLIC_REPO = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/;

function filesUnder(root, filter) {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      const info = statSync(full);
      if (info.isDirectory()) walk(full);
      else if (info.isFile() && filter(full)) out.push(full);
    }
  };
  if (existsSync(root)) walk(root);
  return out.sort();
}

export function dopplerComponent(pin, prefix) {
  if (!PUBLIC_REPO.test(pin.repository) || !COMMIT.test(pin.commit)) throw new Error("worker/doppler.json needs a public repository URL and a 40-hex commit");
  const tools = ["pdftotext", "pdftohtml", "pdfinfo", "pdfimages", "pdftoppm", "pdfseparate", "pdfunite", "pdfattach", "pdfdetach", "pdffonts", "pdftops", "doppler-md", "pdftomarkdown"];
  const files = [
    ...tools.map((tool) => path.join(prefix, "bin", tool)).filter(existsSync),
    ...filesUnder(path.join(prefix, "lib"), (file) => /libpoppler\.so/.test(path.basename(file))),
  ];
  return {
    name: "doppler", label: pin.name ?? "Doppler", license: pin.license, repository: pin.repository, commit: pin.commit,
    version: `git+${pin.commit.slice(0, 12)}`,
    source: { url: pin.source.url, sha256: pin.source.sha256, note: `corresponding source: ${pin.repository}/tree/${pin.commit} (also the pinned source tarball)` },
    built: "from the pinned public source in the image build; installed as separate executables, not linked into DocSlurp code",
    licenseFiles: [path.join(prefix, "share/doc/doppler/COPYING"), path.join(prefix, "share/doc/doppler/COPYING3")],
    files,
  };
}

export function engineComponent(manifest, packageDir) {
  for (const field of ["package", "version", "repository", "commit", "license"]) {
    if (typeof manifest[field] !== "string" || !manifest[field]) throw new Error(`native engine manifest lacks ${field}: provenance is required to ship it`);
  }
  if (!PUBLIC_REPO.test(manifest.repository) || !COMMIT.test(manifest.commit)) throw new Error("native engine manifest needs a public repository URL and a 40-hex commit");
  return {
    name: manifest.package.replace(/^@/, "").replace(/\//g, "-"), label: manifest.package, license: manifest.license,
    repository: manifest.repository, commit: manifest.commit, version: manifest.version,
    source: { url: `${manifest.repository}/tree/${manifest.commit}`, tarball: manifest.tarball, sha256: manifest.sha256, note: manifest.reproducible ?? null },
    built: manifest.built ?? "installed from the pinned tarball",
    licenseFiles: [path.join(packageDir, "LICENSE")],
    files: filesUnder(packageDir, (file) => /\.(node|js|json)$/.test(file)),
  };
}

function spdx(components, created) {
  return {
    spdxVersion: "SPDX-2.3", dataLicense: "CC0-1.0", SPDXID: "SPDXRef-DOCUMENT",
    name: "docslurp-worker-native-components", documentNamespace: `https://github.com/DocSlurp/docslurp-oss/sbom/native-components/${created}`,
    creationInfo: { created, creators: ["Tool: docslurp scripts/write-component-provenance.mjs"] },
    packages: components.map((component) => ({
      SPDXID: `SPDXRef-${component.name}`, name: component.label, versionInfo: component.version,
      downloadLocation: `git+${component.repository}.git@${component.commit}`, homepage: component.repository,
      licenseConcluded: component.license, licenseDeclared: component.license, copyrightText: "NOASSERTION",
      filesAnalyzed: false, sourceInfo: `${component.built}; ${component.source.note ?? component.source.url}`,
      externalRefs: [{ referenceCategory: "PACKAGE-MANAGER", referenceType: "purl", referenceLocator: `pkg:github/${component.repository.split("/").slice(-2).join("/")}@${component.commit}` }],
      ...(component.source.sha256 ? { checksums: [{ algorithm: "SHA256", checksumValue: component.source.sha256 }] } : {}),
    })),
    files: components.flatMap((component) => component.files.map((file, index) => ({
      SPDXID: `SPDXRef-${component.name}-file-${index}`, fileName: file, checksums: [{ algorithm: "SHA256", checksumValue: sha256(file) }],
      licenseConcluded: component.license, copyrightText: "NOASSERTION",
    }))),
    relationships: components.flatMap((component) => component.files.map((_, index) => ({
      spdxElementId: `SPDXRef-${component.name}`, relationshipType: "CONTAINS", relatedSpdxElement: `SPDXRef-${component.name}-file-${index}`,
    }))),
  };
}

export function writeProvenance({ components, licensesDir, sbomPath, created = new Date().toISOString().replace(/\.\d+Z$/, "Z") }) {
  for (const component of components) {
    const dir = path.join(licensesDir, component.name);
    mkdirSync(dir, { recursive: true });
    for (const file of component.licenseFiles) {
      if (!existsSync(file)) throw new Error(`${component.label}: license file missing: ${file}`);
      copyFileSync(file, path.join(dir, path.basename(file)));
    }
    const { licenseFiles: _license, ...record } = component;
    writeFileSync(path.join(dir, "PROVENANCE.json"), `${JSON.stringify({ ...record, files: component.files.map((file) => ({ path: file, sha256: sha256(file) })) }, null, 2)}\n`);
  }
  mkdirSync(path.dirname(sbomPath), { recursive: true });
  writeFileSync(sbomPath, `${JSON.stringify(spdx(components, created), null, 2)}\n`);
}

function main(argv) {
  const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const components = [];
  const dopplerPin = arg("--doppler");
  if (dopplerPin) components.push(dopplerComponent(JSON.parse(readFileSync(dopplerPin, "utf8")), arg("--doppler-prefix") ?? "/usr/local"));
  const engineManifest = arg("--engine-manifest");
  const engineInstalled = process.env.DOCSLURP_NATIVE_PDF_INSTALLED === "1";
  const manifest = engineManifest && existsSync(engineManifest) ? JSON.parse(readFileSync(engineManifest, "utf8")) : null;
  const engineDir = manifest ? arg("--engine-dir") ?? path.join(path.dirname(engineManifest), "node_modules", String(manifest.package ?? "")) : null;
  if (manifest && engineDir && existsSync(engineDir)) {
    components.push(engineComponent(manifest, engineDir));
  } else if (engineInstalled) {
    throw new Error("DOCSLURP_NATIVE_PDF_INSTALLED=1 but the engine manifest or package directory is missing");
  }
  writeProvenance({
    components,
    licensesDir: arg("--licenses") ?? "/usr/share/licenses",
    sbomPath: arg("--sbom") ?? "/usr/share/doc/docslurp/sbom/native-components.spdx.json",
  });
  for (const component of components) console.log(`[provenance] ${component.label} ${component.repository}@${component.commit} ${component.license} files=${component.files.length}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch (error) { console.error(`[provenance] ${error.message}`); process.exitCode = 1; }
}
