/**
 * E2E tests for summary-related crawler options:
 *   withLinksSummary  – append a links section to the response
 *   withImagesSummary – append an images section to the response
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { crawl, crawlWithHeaders } from '../helpers/client';

describe('withLinksSummary: false (default)', () => {
    it('does not return a links field', async () => {
        const res = await crawl({ respondWith: 'markdown' });
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.data.links, undefined);
    });
});

describe('withLinksSummary: true', () => {
    it('returns a links object on the response', async () => {
        const res = await crawl({ withLinksSummary: true, respondWith: 'markdown' });
        assert.strictEqual(res.status, 200);
        assert.notStrictEqual(res.body.data.links, undefined);
    });

    it('links object contains hrefs from the page', async () => {
        const res = await crawl({ withLinksSummary: true, respondWith: 'markdown' });
        const links: Record<string, string> = res.body.data.links;
        const allHrefs = Object.values(links);
        const hasExampleLink = allHrefs.some((href) => href.includes('example.com') || href.includes('example.org'));
        assert.ok(hasExampleLink);
    });

    it('excludes javascript: and file: hrefs', async () => {
        const res = await crawl({ withLinksSummary: true, respondWith: 'markdown' });
        const links: Record<string, string> = res.body.data.links;
        const allHrefs = Object.values(links);
        assert.ok(allHrefs.every((h) => !h.startsWith('javascript:') && !h.startsWith('file:')));
    });
});

describe('withLinksSummary: all', () => {
    it('returns all links including navigation links', async () => {
        const res = await crawl({ withLinksSummary: 'all', respondWith: 'markdown' });
        assert.strictEqual(res.status, 200);
        assert.notStrictEqual(res.body.data.links, undefined);
    });
});

describe('withLinksSummary via X-With-Links-Summary header', () => {
    it('header enables links summary', async () => {
        const res = await crawlWithHeaders(
            { 'X-With-Links-Summary': 'true' },
            { respondWith: 'markdown' },
        );
        assert.strictEqual(res.status, 200);
        assert.notStrictEqual(res.body.data.links, undefined);
    });
});

describe('withImagesSummary: false (default)', () => {
    it('does not return an images field', async () => {
        const res = await crawl({ respondWith: 'markdown' });
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.data.images, undefined);
    });
});

describe('withImagesSummary: true', () => {
    it('returns an images object on the response', async () => {
        const res = await crawl({ withImagesSummary: true, respondWith: 'markdown' });
        assert.strictEqual(res.status, 200);
        assert.notStrictEqual(res.body.data.images, undefined);
    });

    it('images object includes image srcs from the fixture', async () => {
        const res = await crawl({ withImagesSummary: true, respondWith: 'markdown' });
        const images: Record<string, string> = res.body.data.images;
        const allSrcs = Object.values(images);
        const hasExampleImg = allSrcs.some((src) => src.includes('example.com'));
        assert.ok(hasExampleImg);
    });

    it('image keys contain alt text when available', async () => {
        const res = await crawl({ withImagesSummary: true, respondWith: 'markdown' });
        const images: Record<string, string> = res.body.data.images;
        const allKeys = Object.keys(images);
        const hasAltKey = allKeys.some((k) => k.includes('spider crawling') || k.includes('Network diagram'));
        assert.ok(hasAltKey);
    });
});

describe('withImagesSummary via X-With-Images-Summary header', () => {
    it('header enables images summary', async () => {
        const res = await crawlWithHeaders(
            { 'X-With-Images-Summary': 'true' },
            { respondWith: 'markdown' },
        );
        assert.strictEqual(res.status, 200);
        assert.notStrictEqual(res.body.data.images, undefined);
    });
});

describe('withLinksSummary + withImagesSummary combined', () => {
    it('returns both links and images fields', async () => {
        const res = await crawl({ withLinksSummary: true, withImagesSummary: true, respondWith: 'markdown' });
        assert.strictEqual(res.status, 200);
        assert.notStrictEqual(res.body.data.links, undefined);
        assert.notStrictEqual(res.body.data.images, undefined);
    });
});
