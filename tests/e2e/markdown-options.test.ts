/**
 * E2E tests for markdown formatting options (the `markdown` sub-object)
 * and the `noGfm` flag.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { crawl, crawlWithHeaders } from '../helpers/client';

describe('markdown.headingStyle', () => {
    it('atx style produces # prefixed headings', async () => {
        const res = await crawl({ markdown: { headingStyle: 'atx' }, respondWith: 'markdown' });
        assert.strictEqual(res.status, 200);
        assert.match(res.body.data.content, /^#{1,3} /m);
    });

    it('setext style produces underlined headings for h1/h2', async () => {
        const res = await crawl({ markdown: { headingStyle: 'setext' }, respondWith: 'markdown' });
        assert.strictEqual(res.status, 200);
        assert.match(res.body.data.content, /^[=-]+$/m);
    });

    it('X-Md-Heading-Style header works for atx', async () => {
        const res = await crawlWithHeaders({ 'X-Md-Heading-Style': 'atx' }, { respondWith: 'markdown' });
        assert.strictEqual(res.status, 200);
        assert.match(res.body.data.content, /^#{1,3} /m);
    });
});

describe('markdown.bulletListMarker', () => {
    it('- marker produces dash list items', async () => {
        const res = await crawl({ markdown: { bulletListMarker: '-' }, respondWith: 'markdown' });
        assert.strictEqual(res.status, 200);
        assert.match(res.body.data.content, /^- /m);
    });

    it('* marker produces asterisk list items', async () => {
        const res = await crawl({ markdown: { bulletListMarker: '*' }, respondWith: 'markdown' });
        assert.strictEqual(res.status, 200);
        assert.match(res.body.data.content, /^\* /m);
    });

    it('+ marker produces plus list items', async () => {
        const res = await crawl({ markdown: { bulletListMarker: '+' }, respondWith: 'markdown' });
        assert.strictEqual(res.status, 200);
        assert.match(res.body.data.content, /^\+ /m);
    });

    it('X-Md-Bullet-List-Marker header is respected', async () => {
        const res = await crawlWithHeaders({ 'X-Md-Bullet-List-Marker': '*' }, { respondWith: 'markdown' });
        assert.match(res.body.data.content, /^\* /m);
    });
});

describe('markdown.emDelimiter', () => {
    it('_ delimiter wraps emphasis with underscores', async () => {
        const res = await crawl({ markdown: { emDelimiter: '_' }, respondWith: 'markdown' });
        assert.strictEqual(res.status, 200);
        assert.match(res.body.data.content, /_[^_]+_/);
    });

    it('* delimiter wraps emphasis with asterisks', async () => {
        const res = await crawl({ markdown: { emDelimiter: '*' }, respondWith: 'markdown' });
        assert.strictEqual(res.status, 200);
        assert.match(res.body.data.content, /\*[^*]+\*/);
    });
});

describe('markdown.strongDelimiter', () => {
    it('** wraps bold text with double asterisks', async () => {
        const res = await crawl({ markdown: { strongDelimiter: '**' }, respondWith: 'markdown' });
        assert.strictEqual(res.status, 200);
        assert.match(res.body.data.content, /\*\*[^*]+\*\*/);
    });

    it('__ wraps bold text with double underscores', async () => {
        const res = await crawl({ markdown: { strongDelimiter: '__' }, respondWith: 'markdown' });
        assert.strictEqual(res.status, 200);
        assert.match(res.body.data.content, /__[^_]+__/);
    });
});

describe('markdown.linkStyle', () => {
    it('inlined keeps [text](url) syntax', async () => {
        const res = await crawl({ markdown: { linkStyle: 'inlined' }, respondWith: 'markdown' });
        assert.strictEqual(res.status, 200);
        assert.match(res.body.data.content, /\[.*?\]\(https?:\/\//);
    });

    it('discarded removes links entirely', async () => {
        const res = await crawl({ markdown: { linkStyle: 'discarded' }, respondWith: 'markdown' });
        assert.strictEqual(res.status, 200);
        assert.doesNotMatch(res.body.data.content, /(?<!!)\[.*?\]\(https?:\/\//);
    });
});

describe('noGfm flag', () => {
    it('false (default) enables GFM extensions', async () => {
        const res = await crawl({ noGfm: false, respondWith: 'markdown' });
        assert.strictEqual(res.status, 200);
        assert.match(res.body.data.content, /web crawling/i);
    });

    it('true disables GFM, content still has text', async () => {
        const res = await crawl({ noGfm: true, respondWith: 'markdown' });
        assert.strictEqual(res.status, 200);
        assert.match(res.body.data.content, /web crawling/i);
    });

    it('X-No-Gfm header disables GFM', async () => {
        const res = await crawlWithHeaders({ 'X-No-Gfm': 'true' }, { respondWith: 'markdown' });
        assert.strictEqual(res.status, 200);
        assert.notStrictEqual(res.body.data.content, undefined);
    });
});

describe('multiple markdown options combined', () => {
    it('applies all specified options together', async () => {
        const res = await crawl({
            markdown: {
                headingStyle: 'atx',
                bulletListMarker: '*',
                strongDelimiter: '__',
                emDelimiter: '_',
            },
            respondWith: 'markdown',
        });
        assert.strictEqual(res.status, 200);
        const content: string = res.body.data.content;
        assert.match(content, /^#{1,3} /m);
        assert.match(content, /^\* /m);
        assert.match(content, /__[^_]+__/);
    });
});
