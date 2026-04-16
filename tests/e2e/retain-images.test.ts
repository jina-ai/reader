/**
 * E2E tests for the `retainImages` crawler option.
 *
 * Modes: none | alt | all | all_p | alt_p
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { crawl, crawlWithHeaders } from '../helpers/client';

describe('retainImages: all (default)', () => {
    it('includes markdown image syntax in content', async () => {
        const res = await crawl({ retainImages: 'all', respondWith: 'markdown' });
        assert.strictEqual(res.status, 200);
        assert.match(res.body.data.content, /!\[.*?\]\(https:\/\/example\.com\//);
    });

    it('includes images that have alt text', async () => {
        const res = await crawl({ retainImages: 'all', respondWith: 'markdown' });
        assert.match(res.body.data.content, /spider\.png/);
        assert.match(res.body.data.content, /network\.jpg/);
    });
});

describe('retainImages: none', () => {
    it('removes all images from content', async () => {
        const res = await crawl({ retainImages: 'none', respondWith: 'markdown' });
        assert.strictEqual(res.status, 200);
        assert.doesNotMatch(res.body.data.content, /\!\[/);
        assert.doesNotMatch(res.body.data.content, /spider\.png/);
        assert.doesNotMatch(res.body.data.content, /network\.jpg/);
    });

    it('still returns normal text content', async () => {
        const res = await crawl({ retainImages: 'none', respondWith: 'markdown' });
        assert.match(res.body.data.content, /crawling|web/i);
    });
});

describe('retainImages: alt', () => {
    it('replaces images that have alt with "(Image N: alt text)" text', async () => {
        const res = await crawl({ retainImages: 'alt', respondWith: 'markdown' });
        assert.strictEqual(res.status, 200);
        assert.match(res.body.data.content, /\(Image \d+:.*spider crawling|Image \d+:.*Network diagram/i);
    });

    it('omits images without alt text', async () => {
        const res = await crawl({ retainImages: 'alt', respondWith: 'markdown' });
        assert.doesNotMatch(res.body.data.content, /noalt\.png/);
    });

    it('does not produce markdown image links', async () => {
        const res = await crawl({ retainImages: 'alt', respondWith: 'markdown' });
        assert.doesNotMatch(res.body.data.content, /!\[.*?\]\(http/);
    });
});

describe('retainImages: all_p (all images, preserve alt text)', () => {
    it('includes all images including those without alt', async () => {
        const res = await crawl({ retainImages: 'all_p', respondWith: 'markdown' });
        assert.strictEqual(res.status, 200);
        assert.match(res.body.data.content, /spider\.png|noalt\.png/);
    });

    it('includes image markdown syntax', async () => {
        const res = await crawl({ retainImages: 'all_p', respondWith: 'markdown' });
        assert.match(res.body.data.content, /!\[/);
    });
});

describe('retainImages: alt_p (alt text only, even for images without alt)', () => {
    it('does not include raw image URLs', async () => {
        const res = await crawl({ retainImages: 'alt_p', respondWith: 'markdown' });
        assert.strictEqual(res.status, 200);
        assert.doesNotMatch(res.body.data.content, /!\[.*?\]\(http/);
        assert.doesNotMatch(res.body.data.content, /spider\.png/);
    });

    it('includes alt text inline for images that have it', async () => {
        const res = await crawl({ retainImages: 'alt_p', respondWith: 'markdown' });
        assert.match(res.body.data.content, /\(Image \d+:/);
    });
});

describe('retainImages via X-Retain-Images header', () => {
    it('respects header override for none mode', async () => {
        const res = await crawlWithHeaders(
            { 'X-Retain-Images': 'none' },
            { respondWith: 'markdown' },
        );
        assert.strictEqual(res.status, 200);
        assert.doesNotMatch(res.body.data.content, /!\[/);
    });
});
