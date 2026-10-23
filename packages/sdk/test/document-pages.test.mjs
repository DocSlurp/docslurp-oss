import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDocumentPreviewPages } from '../dist/index.js';

test('maps rendered pages with physical page numbers, signed URLs and manifest dimensions', () => {
  const pages = buildDocumentPreviewPages({ documentId: 'doc', artifacts: [
    { slot: 'doc:page-7', uri: 's3://bucket/page-7.png', url: 'https://test/page-7.png?signature=abc' },
    { slot: 'doc:page-2', uri: 's3://bucket/page-2.png', url: 'https://test/page-2.png' },
    { slot: 'other:page-1', uri: 's3://bucket/page-1.png', url: '/unrelated.png' },
    { slot: 'doc:markdown', uri: 's3://bucket/text.md', url: '/text.md' },
  ], manifest: { render: { pages: [{ pageNumber: 7, widthPx: 700, heightPx: 900 }] } } });
  assert.deepEqual(pages.map(page => page.pageNumber), [7, 2]);
  assert.equal(pages[0].widthPx, 700);
  assert.equal(pages[0].imageUrl, 'https://test/page-7.png?signature=abc');
});

test('keeps an unknown image page number unknown and deduplicates image URIs', () => {
  const pages = buildDocumentPreviewPages({ documentId: 'doc', artifacts: [
    { slot: 'doc:image', uri: 's3://bucket/photo.png', url: '/photo.png' },
    { slot: 'doc:image-copy', uri: 's3://bucket/photo.png', url: '/photo.png' },
  ], manifest: null });
  assert.equal(pages.length, 1);
  assert.equal(pages[0].pageNumber, null);
});

test('keeps quality cache identities out of page enumeration', () => {
  const pages = buildDocumentPreviewPages({ documentId: 'doc', artifacts: [
    { slot: 'doc:page-3', uri: 's3://bucket/v2-200dpi/page-3.png', url: '/reader.png' },
    { slot: 'doc:raster-v2-reader-page-3', uri: 's3://bucket/v2-200dpi/page-3.png', url: '/reader-copy.png' },
    { slot: 'doc:raster-v2-export-page-3', uri: 's3://bucket/v2-300dpi/page-3.png', url: '/export.png' },
  ], manifest: null });
  assert.equal(pages.length, 1);
  assert.equal(pages[0].pageNumber, 3);
  assert.equal(pages[0].imageUrl, '/reader.png');
});
