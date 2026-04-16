/**
 * E2E tests for the `markdownChunking` crawler option.
 *
 * Modes: 'simple' | 'contextual'
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { crawl, crawlWithHeaders } from '../helpers/client';

describe('no markdownChunking (default)', () => {
    it('does not include chunks in response', async () => {
        const res = await crawl({ respondWith: 'markdown' });
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.data.chunks, undefined);
    });
});

describe('markdownChunking: simple', () => {
    it('returns a chunks array', async () => {
        const res = await crawl({ markdownChunking: 'simple', respondWith: 'markdown' });
        assert.strictEqual(res.status, 200);
        assert.ok(Array.isArray(res.body.data.chunks));
        assert.ok(res.body.data.chunks.length > 1);
    });

    it('chunks split by headings', async () => {
        const res = await crawl({ markdownChunking: 'simple', respondWith: 'markdown' });
        const chunks: string[] = res.body.data.chunks;
        const hasBasics = chunks.some((c) => c.includes('Section One'));
        const hasTables = chunks.some((c) => c.includes('Section Five'));
        assert.ok(hasBasics);
        assert.ok(hasTables);
    });

    it('all content sections are represented across chunks', async () => {
        const res = await crawl({ markdownChunking: 'simple', respondWith: 'markdown' });
        const allText = res.body.data.chunks.join('\n');
        assert.ok(allText.includes('Web Crawling Guide'));
        assert.ok(allText.includes('fetching pages'));
        assert.ok(allText.includes('Fetch HTML pages'));
    });

    it('each chunk is a non-empty string', async () => {
        const res = await crawl({ markdownChunking: 'simple', respondWith: 'markdown' });
        for (const chunk of res.body.data.chunks) {
            assert.strictEqual(typeof chunk, 'string');
            assert.ok(chunk.trim().length > 0);
        }
    });
});

describe('markdownChunking: contextual', () => {
    it('returns a chunks array', async () => {
        const res = await crawl({ markdownChunking: 'contextual', respondWith: 'markdown' });
        assert.strictEqual(res.status, 200);
        assert.ok(Array.isArray(res.body.data.chunks));
        assert.ok(res.body.data.chunks.length > 1);
    });

    it('chunks contain content from the page', async () => {
        const res = await crawl({ markdownChunking: 'contextual', respondWith: 'markdown' });
        const allText = res.body.data.chunks.join('\n');
        assert.ok(allText.includes('Web Crawling Guide'));
    });
});

describe('markdownChunking via X-Markdown-Chunking header', () => {
    it('header enables chunking', async () => {
        const res = await crawlWithHeaders(
            { 'X-Markdown-Chunking': 'simple' },
            { respondWith: 'markdown' },
        );
        assert.strictEqual(res.status, 200);
        assert.ok(Array.isArray(res.body.data.chunks));
        assert.ok(res.body.data.chunks.length > 1);
    });
});
