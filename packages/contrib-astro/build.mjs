import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** Index rendered Astro Node standalone pages through DocSlurp's public API. */
/**
 * `workspace`: the workspace ID, slug or name to index into. A name that matches
 * no workspace is created on the first build; later builds find it by name.
 */
export default function docslurpDocsIndex({ routes, apiKey, apiUrl = 'https://docslurp.io', workspace = 'DocSlurp documentation', site = 'https://docslurp.io', renderEnv = {}, pipeline }) {
  let root;
  return {
    name: '@docslurp/contrib-astro/docs-index',
    hooks: {
      'astro:config:done': ({ config }) => { root = config.root; },
      'astro:build:done': async ({ dir, logger }) => {
        const entry = new URL('../server/entry.mjs', dir);
        const output = new URL('.docslurp/docs-index.json', root);
        // Isolate server imports and startup state from Astro's build process.
        await new Promise((resolve, reject) => {
          const child = spawn(process.execPath, [fileURLToPath(new URL('./index-docs.mjs', import.meta.url)), '--entry', fileURLToPath(entry), '--output', fileURLToPath(output), '--public-config', fileURLToPath(new URL('docslurp-docs-search.json', dir))], {
            cwd: fileURLToPath(root), stdio: 'inherit',
            env: { ...process.env, ...renderEnv, ASTRO_NODE_AUTOSTART: 'disabled', DOCSLURP_API_KEY: apiKey ?? '', DOCSLURP_DOCS_INDEX_OPTIONS: JSON.stringify({ routes, apiUrl, workspace, site, ...(pipeline ? { pipeline } : {}) }) },
          });
          child.on('error', reject);
          child.on('exit', code => code === 0 ? resolve() : reject(new Error(`DocSlurp docs indexing exited with ${code}`)));
        });
        logger.info(apiKey ? 'Docs submitted to DocSlurp; indexing completed.' : 'Docs corpus built. No DOCSLURP_API_KEY: remote indexing skipped.');
      },
    },
  };
}
