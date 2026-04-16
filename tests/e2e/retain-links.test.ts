/**
 * E2E tests for the `retainLinks` crawler option.
 *
 * Modes: all | none | text | gpt-oss
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { crawl, crawlWithHeaders } from '../helpers/client';

describe('retainLinks: all (default)', () => {
    it('keeps markdown link syntax in content', async () => {
        const res = await crawl({ retainLinks: 'all', respondWith: 'markdown' });
        assert.strictEqual(res.status, 200);
        assert.match(res.body.data.content, /\[.*?\]\(https?:\/\//);
    });

    it('includes the link hrefs from the fixture', async () => {
        const res = await crawl({ retainLinks: 'all', respondWith: 'markdown' });
        const content: string = res.body.data.content;
        assert.match(content, /example\.com\/crawling|example\.org\/robots/);
    });
});

describe('retainLinks: none', () => {
    it('removes hyperlinks from content', async () => {
        const res = await crawl({ retainLinks: 'none', respondWith: 'markdown' });
        assert.strictEqual(res.status, 200);
        const content: string = res.body.data.content;
        assert.doesNotMatch(content, /(?<!!)\[.*?\]\(https?:\/\//);
    });

    it('still contains non-link text content', async () => {
        const res = await crawl({ retainLinks: 'none', respondWith: 'markdown' });
        assert.match(res.body.data.content, /web crawling|fetching pages/i);
    });
});

describe('retainLinks: text', () => {
    it('replaces links with their anchor text only (no href)', async () => {
        const res = await crawl({ retainLinks: 'text', respondWith: 'markdown' });
        assert.strictEqual(res.status, 200);
        const content: string = res.body.data.content;
        assert.doesNotMatch(content, /(?<!!)\[.*?\]\(https?:\/\//);
    });
});

describe('retainLinks: gpt-oss', () => {
    it('converts links to citation format', async () => {
        const res = await crawl({ retainLinks: 'gpt-oss', respondWith: 'markdown' });
        assert.strictEqual(res.status, 200);
        const content: string = res.body.data.content;
        assert.match(content, /【\d+†/);
    });

    it('does not use standard markdown link syntax for hyperlinks', async () => {
        const res = await crawl({ retainLinks: 'gpt-oss', respondWith: 'markdown' });
        assert.doesNotMatch(res.body.data.content, /(?<!!)\[.*?\]\(https?:\/\//);
    });

    it('populates the links summary automatically', async () => {
        const res = await crawl({ retainLinks: 'gpt-oss', respondWith: 'markdown' });
        assert.notStrictEqual(res.body.data.links, undefined);
    });
});

describe('retainLinks via X-Retain-Links header', () => {
    it('header overrides body param', async () => {
        const res = await crawlWithHeaders(
            { 'X-Retain-Links': 'none' },
            { respondWith: 'markdown' },
        );
        assert.strictEqual(res.status, 200);
        assert.doesNotMatch(res.body.data.content, /(?<!!)\[.*?\]\(https?:\/\//);
    });
});
