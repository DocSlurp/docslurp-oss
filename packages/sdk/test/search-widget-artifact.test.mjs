import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';
test('WordPress ships the exact built SDK widget with one registration call',async()=>{
  const source=await readFile(new URL('../dist/search-widget.js',import.meta.url),'utf8');
  const plugin=await readFile(new URL('../../../packages/contrib-wordpress/docslurp-search/search-widget.js',import.meta.url),'utf8');
  assert.equal(plugin,source+'\ndefineDocSlurpSearch();\n');
});
