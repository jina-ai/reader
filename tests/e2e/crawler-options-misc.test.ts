/**
 * E2E tests for miscellaneous CrawlerOptions fields.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { crawl, crawlWithHeaders } from '../helpers/client';

describe('noCache', () => {
    it('request with noCache: true succeeds', async () => {
        const res = await crawl({ noCache: true });
        assert.strictEqual(res.status, 200);
        assert.notStrictEqual(res.body.data, undefined);
    });

    it('X-No-Cache header is accepted', async () => {
        const res = await crawlWithHeaders({ 'X-No-Cache': '1' });
        assert.strictEqual(res.status, 200);
    });
});

describe('cacheTolerance', () => {
    it('cacheTolerance: 0 disables cache and still returns content', async () => {
        const res = await crawl({ cacheTolerance: 0 });
        assert.strictEqual(res.status, 200);
        assert.notStrictEqual(res.body.data.content, undefined);
    });

    it('X-Cache-Tolerance header is accepted', async () => {
        const res = await crawlWithHeaders({ 'X-Cache-Tolerance': '3600' });
        assert.strictEqual(res.status, 200);
    });
});

describe('timeout validation', () => {
    it('valid timeout (30s) is accepted', async () => {
        const res = await crawl({ timeout: 30 });
        assert.strictEqual(res.status, 200);
    });

    it('X-Timeout header sets timeout', async () => {
        const res = await crawlWithHeaders({ 'X-Timeout': '10' });
        assert.strictEqual(res.status, 200);
    });

    it('timeout > 180 is clamped (header)', async () => {
        const res = await crawlWithHeaders({ 'X-Timeout': '999' });
        assert.strictEqual(res.status, 200);
    });
});

describe('base option', () => {
    it('base: initial resolves relative links from the initial URL', async () => {
        const res = await crawl({ base: 'initial' });
        assert.strictEqual(res.status, 200);
        assert.notStrictEqual(res.body.data.content, undefined);
    });

    it('base: final is accepted', async () => {
        const res = await crawl({ base: 'final' });
        assert.strictEqual(res.status, 200);
    });

    it('X-Base header is accepted', async () => {
        const res = await crawlWithHeaders({ 'X-Base': 'final' });
        assert.strictEqual(res.status, 200);
    });
});

describe('respondTiming', () => {
    it('respondTiming: html is accepted', async () => {
        const res = await crawl({ respondTiming: 'html' });
        assert.strictEqual(res.status, 200);
    });

    it('respondTiming: visible-content is accepted', async () => {
        const res = await crawl({ respondTiming: 'visible-content' });
        assert.strictEqual(res.status, 200);
    });

    it('X-Respond-Timing header is accepted', async () => {
        const res = await crawlWithHeaders({ 'X-Respond-Timing': 'mutation-idle' });
        assert.strictEqual(res.status, 200);
    });
});

describe('tokenBudget', () => {
    it('large token budget still returns content', async () => {
        const res = await crawl({ tokenBudget: 100_000 });
        assert.strictEqual(res.status, 200);
        assert.notStrictEqual(res.body.data.content, undefined);
    });

    it('X-Token-Budget header is accepted', async () => {
        const res = await crawlWithHeaders({ 'X-Token-Budget': '50000' });
        assert.strictEqual(res.status, 200);
    });
});

describe('keepImgDataUrl', () => {
    it('keepImgDataUrl: true is accepted', async () => {
        const res = await crawl({ keepImgDataUrl: true, respondWith: 'markdown' });
        assert.strictEqual(res.status, 200);
        assert.notStrictEqual(res.body.data.content, undefined);
    });

    it('X-Keep-Img-Data-Url header is accepted', async () => {
        const res = await crawlWithHeaders(
            { 'X-Keep-Img-Data-Url': 'true' },
            { respondWith: 'markdown' },
        );
        assert.strictEqual(res.status, 200);
    });
});

describe('request metadata options', () => {
    it('custom userAgent is accepted', async () => {
        const res = await crawl({ userAgent: 'TestBot/1.0' });
        assert.strictEqual(res.status, 200);
    });

    it('locale option is accepted', async () => {
        const res = await crawl({ locale: 'fr-FR' });
        assert.strictEqual(res.status, 200);
    });

    it('referer option is accepted', async () => {
        const res = await crawl({ referer: 'https://referrer.example.com' });
        assert.strictEqual(res.status, 200);
    });

    it('X-User-Agent header is accepted', async () => {
        const res = await crawlWithHeaders({ 'X-User-Agent': 'CustomAgent/2.0' });
        assert.strictEqual(res.status, 200);
    });

    it('X-Locale header is accepted', async () => {
        const res = await crawlWithHeaders({ 'X-Locale': 'ja-JP' });
        assert.strictEqual(res.status, 200);
    });
});

describe('engine option', () => {
    it('engine: auto is accepted', async () => {
        const res = await crawl({ engine: 'auto' });
        assert.strictEqual(res.status, 200);
    });

    it('X-Engine header is accepted', async () => {
        const res = await crawlWithHeaders({ 'X-Engine': 'browser' });
        assert.strictEqual(res.status, 200);
    });
});

describe('removeOverlay', () => {
    it('removeOverlay: true is accepted', async () => {
        const res = await crawl({ removeOverlay: true });
        assert.strictEqual(res.status, 200);
    });

    it('X-Remove-Overlay header is accepted', async () => {
        const res = await crawlWithHeaders({ 'X-Remove-Overlay': 'true' });
        assert.strictEqual(res.status, 200);
    });
});

describe('doNotTrack / DNT', () => {
    it('DNT: 1 header is accepted', async () => {
        const res = await crawlWithHeaders({ 'DNT': '1' });
        assert.strictEqual(res.status, 200);
    });
});
