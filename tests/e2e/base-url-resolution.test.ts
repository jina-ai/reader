/**
 * E2E tests for the `base` crawler option.
 *
 * Controls how relative URLs are resolved in the output.
 * Modes: 'initial' (default) | 'final'
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { crawl, crawlWithHeaders } from '../helpers/client';

describe('base: initial (default)', () => {
    it('resolves absolute-path relative URLs to the initial origin', async () => {
        const res = await crawl({ respondWith: 'markdown' });
        assert.strictEqual(res.status, 200);
        const content: string = res.body.data.content;
        assert.ok(content.includes('https://example.com/home'));
        assert.ok(content.includes('https://example.com/about'));
        assert.ok(content.includes('https://example.com/privacy'));
    });

    it('resolves path-relative URLs against the initial URL', async () => {
        const res = await crawl({ respondWith: 'markdown' });
        const content: string = res.body.data.content;
        assert.ok(content.includes('https://example.com/guide/advanced'));
        assert.ok(content.includes('https://example.com/sibling-page'));
    });

    it('preserves fully-qualified URLs as-is', async () => {
        const res = await crawl({ respondWith: 'markdown' });
        const content: string = res.body.data.content;
        assert.ok(content.includes('https://example.com/crawling'));
        assert.ok(content.includes('https://example.org/robots'));
    });
});

describe('base: initial (explicit)', () => {
    it('produces the same result as default', async () => {
        const defaultRes = await crawl({ respondWith: 'markdown' });
        const explicitRes = await crawl({ base: 'initial', respondWith: 'markdown' });
        assert.strictEqual(explicitRes.status, 200);
        assert.strictEqual(explicitRes.body.data.content, defaultRes.body.data.content);
    });
});

describe('base: final', () => {
    it('is accepted and returns content', async () => {
        const res = await crawl({ base: 'final', respondWith: 'markdown' });
        assert.strictEqual(res.status, 200);
        assert.notStrictEqual(res.body.data.content, undefined);
        assert.ok(res.body.data.content.length > 0);
    });

    it('uses the snapshot href (blob digest) as base, not the nominal URL', async () => {
        const res = await crawl({ base: 'final', respondWith: 'markdown' });
        const content: string = res.body.data.content;
        assert.ok(content.includes('/home'));
        assert.ok(content.includes('/guide/advanced'));
    });

    it('produces different output from base: initial for relative URLs', async () => {
        const initialRes = await crawl({ base: 'initial', respondWith: 'markdown' });
        const finalRes = await crawl({ base: 'final', respondWith: 'markdown' });
        assert.ok(initialRes.body.data.content.includes('https://example.com/home'));
        assert.ok(!finalRes.body.data.content.includes('https://example.com/home'));
    });
});

describe('base via X-Base header', () => {
    it('X-Base: initial header resolves relative URLs', async () => {
        const res = await crawlWithHeaders(
            { 'X-Base': 'initial' },
            { respondWith: 'markdown' },
        );
        assert.strictEqual(res.status, 200);
        assert.ok(res.body.data.content.includes('https://example.com/guide/advanced'));
    });

    it('X-Base: final header is accepted', async () => {
        const res = await crawlWithHeaders(
            { 'X-Base': 'final' },
            { respondWith: 'markdown' },
        );
        assert.strictEqual(res.status, 200);
    });
});
