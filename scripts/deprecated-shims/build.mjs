#!/usr/bin/env node
// Generates the "final shim release" packages for npm names retired by the package consolidation.
// Each shim re-exports from its replacement and carries a deprecation notice, so existing
// installs keep working while users migrate. Nothing here publishes: review the output, then
// follow docs/releases.md ("Retired package names").
//
//   node scripts/deprecated-shims/build.mjs <outDir> [version]
//
// <outDir> must not exist yet. The version defaults to the shared release version.
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));

const searchCompat = (client, factory) => ({
  replacement: `@docslurp/contrib-search-compat/${client}`,
  dependency: "@docslurp/contrib-search-compat",
  js: `export * from "@docslurp/contrib-search-compat/${client}";\nexport { default } from "@docslurp/contrib-search-compat/${client}";\n`,
  dts: `export * from "@docslurp/contrib-search-compat/${client}";\nexport { default } from "@docslurp/contrib-search-compat/${client}";\n`,
  description: `Deprecated: use @docslurp/contrib-search-compat/${client} (${factory}).`,
});

export const shims = {
  "@docslurp/compat-algolia": searchCompat("algolia", "docslurpAlgoliaClient"),
  "@docslurp/compat-meilisearch": searchCompat("meilisearch", "createDocSlurpMeilisearchClient"),
  "@docslurp/compat-typesense": searchCompat("typesense", "createDocSlurpTypesenseClient"),
  "@docslurp/compat-pagefind": searchCompat("pagefind", "createDocSlurpPagefind"),
  "@docslurp/compat-algolia-server": {
    replacement: "@docslurp/contrib-algolia-server",
    dependency: "@docslurp/contrib-algolia-server",
    js: 'export * from "@docslurp/contrib-algolia-server";\nexport { default } from "@docslurp/contrib-algolia-server";\n',
    dts: 'export * from "@docslurp/contrib-algolia-server";\nexport { default } from "@docslurp/contrib-algolia-server";\n',
    description: "Deprecated: use @docslurp/contrib-algolia-server.",
  },
  "@docslurp/embed-sdk": {
    replacement: "@docslurp/sdk/embed",
    dependency: "@docslurp/sdk",
    peers: { react: "^19.0.0", "react-dom": "^19.0.0" },
    js: 'export * from "@docslurp/sdk/embed";\nexport { default } from "@docslurp/sdk/embed";\n',
    dts: 'export * from "@docslurp/sdk/embed";\nexport { default } from "@docslurp/sdk/embed";\n',
    description: "Deprecated: use @docslurp/sdk/embed.",
  },
  "@docslurp/astro": {
    replacement: "@docslurp/contrib-astro",
    dependency: "@docslurp/contrib-astro",
    exports: { ".": "./DocSlurpSearch.astro", "./build": "./build.mjs" },
    files: {
      "DocSlurpSearch.astro": "---\nimport DocSlurpSearch from '@docslurp/contrib-astro';\n---\n<DocSlurpSearch {...Astro.props} />\n",
      "build.mjs": "export { default } from '@docslurp/contrib-astro/build';\n",
    },
    description: "Deprecated: use @docslurp/contrib-astro.",
  },
};

export function buildShims(outDir, version) {
  if (existsSync(outDir)) throw new Error(`${outDir} already exists; choose a new directory`);
  for (const [name, shim] of Object.entries(shims)) {
    const dir = join(outDir, name.split("/")[1]);
    mkdirSync(dir, { recursive: true });
    const manifest = {
      name,
      version,
      description: shim.description,
      license: "MIT",
      type: "module",
      ...(shim.exports
        ? { exports: shim.exports, files: Object.keys(shim.files) }
        : {
            sideEffects: false,
            main: "index.js",
            types: "index.d.ts",
            exports: { ".": { types: "./index.d.ts", import: "./index.js" } },
            files: ["index.js", "index.d.ts"],
          }),
      dependencies: { [shim.dependency]: `^${version}` },
      ...(shim.peers ? { peerDependencies: shim.peers } : {}),
      publishConfig: { access: "public" },
    };
    manifest.files.push("README.md");
    writeFileSync(join(dir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    if (shim.exports) for (const [file, content] of Object.entries(shim.files)) writeFileSync(join(dir, file), content);
    else {
      writeFileSync(join(dir, "index.js"), shim.js);
      writeFileSync(join(dir, "index.d.ts"), shim.dts);
    }
    writeFileSync(join(dir, "README.md"), `# ${name} (deprecated)\n\nThis package moved to \`${shim.replacement}\`. It now only re-exports from there; install the new name and update your imports.\n\nSee https://docslurp.io/docs/packages for the current packages.\n`);
  }
  return Object.keys(shims);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [outDir, version] = process.argv.slice(2);
  if (!outDir) throw new Error("Usage: node scripts/deprecated-shims/build.mjs <outDir> [version]");
  const sharedVersion = version ?? JSON.parse(readFileSync(join(root, "packages/sdk/package.json"), "utf8")).version;
  console.log(`Wrote shims for ${buildShims(resolve(outDir), sharedVersion).join(", ")} at ${sharedVersion} in ${outDir}`);
}
