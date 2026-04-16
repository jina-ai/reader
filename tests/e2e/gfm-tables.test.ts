/**
 * E2E tests for the `noGfm` option with the special 'table' string value.
 *
 * noGfm: false   -> GFM enabled, tables rendered as pipe tables
 * noGfm: true    -> GFM disabled entirely
 * noGfm: 'table' -> GFM enabled except tables kept as raw HTML
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { crawl, crawlWithHeaders } from '../helpers/client';

describe('noGfm: false (default) — GFM pipe table', () => {
    it('renders table with pipe separators', async () => {
        const res = await crawl({ noGfm: false, respondWith: 'markdown' });
        assert.strictEqual(res.status, 200);
        const content: string = res.body.data.content;
        assert.match(content, /\| Method \| Speed \| Accuracy \|/);
    });

    it('includes table data rows with pipes', async () => {
        const res = await crawl({ noGfm: false, respondWith: 'markdown' });
        const content: string = res.body.data.content;
        assert.match(content, /\| Browser \| Slow \| High \|/);
        assert.match(content, /\| Curl \| Fast \| Medium \|/);
    });

    it('includes separator row with dashes', async () => {
        const res = await crawl({ noGfm: false, respondWith: 'markdown' });
        assert.match(res.body.data.content, /\| ---/);
    });
});

describe('noGfm: "table" — tables as raw HTML, rest GFM', () => {
    it('keeps table as raw HTML tags', async () => {
        const res = await crawl({ noGfm: 'table', respondWith: 'markdown' });
        assert.strictEqual(res.status, 200);
        const content: string = res.body.data.content;
        assert.match(content, /<table/i);
        assert.match(content, /<tr/i);
        assert.match(content, /<td/i);
    });

    it('does not produce pipe table syntax', async () => {
        const res = await crawl({ noGfm: 'table', respondWith: 'markdown' });
        const content: string = res.body.data.content;
        assert.doesNotMatch(content, /\| Method \| Speed/);
    });

    it('still renders other markdown features normally', async () => {
        const res = await crawl({ noGfm: 'table', respondWith: 'markdown' });
        const content: string = res.body.data.content;
        assert.match(content, /^#{1,3} /m);
        assert.match(content, /Fetch HTML pages/);
        assert.match(content, /_fetching pages_/);
    });
});

describe('noGfm: true — GFM fully disabled', () => {
    it('renders content without GFM extensions', async () => {
        const res = await crawl({ noGfm: true, respondWith: 'markdown' });
        assert.strictEqual(res.status, 200);
        assert.notStrictEqual(res.body.data.content, undefined);
        assert.ok(res.body.data.content.length > 0);
    });
});

describe('noGfm via X-No-Gfm header', () => {
    it('X-No-Gfm: table keeps table as HTML', async () => {
        const res = await crawlWithHeaders(
            { 'X-No-Gfm': 'table' },
            { respondWith: 'markdown' },
        );
        assert.strictEqual(res.status, 200);
        assert.match(res.body.data.content, /<table/i);
        assert.doesNotMatch(res.body.data.content, /\| Method \| Speed/);
    });
});
