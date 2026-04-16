/**
 * E2E tests for browser-related crawler options:
 *   timeout / viewport / engine / respondTiming
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { crawl, crawlWithHeaders } from '../helpers/client';

describe('timeout', () => {
    it('accepts timeout within valid range (1-180)', async () => {
        const res = await crawl({ timeout: 30 });
        assert.strictEqual(res.status, 200);
        assert.notStrictEqual(res.body.data.content, undefined);
    });

    it('accepts maximum timeout of 180', async () => {
        const res = await crawl({ timeout: 180 });
        assert.strictEqual(res.status, 200);
    });

    it('X-Timeout header is accepted', async () => {
        const res = await crawlWithHeaders({ 'X-Timeout': '60' });
        assert.strictEqual(res.status, 200);
    });
});

describe('viewport', () => {
    it('accepts viewport with width and height', async () => {
        const res = await crawl({ viewport: { width: 1920, height: 1080 } });
        assert.strictEqual(res.status, 200);
        assert.notStrictEqual(res.body.data.content, undefined);
    });

    it('accepts viewport with mobile configuration', async () => {
        const res = await crawl({
            viewport: { width: 375, height: 812, isMobile: true, hasTouch: true },
        });
        assert.strictEqual(res.status, 200);
    });

    it('accepts viewport with deviceScaleFactor', async () => {
        const res = await crawl({
            viewport: { width: 1280, height: 720, deviceScaleFactor: 2 },
        });
        assert.strictEqual(res.status, 200);
    });
});

describe('engine', () => {
    it('engine: auto is accepted', async () => {
        const res = await crawl({ engine: 'auto' });
        assert.strictEqual(res.status, 200);
    });

    it('engine: browser is accepted', async () => {
        const res = await crawl({ engine: 'browser' });
        assert.strictEqual(res.status, 200);
    });

    it('engine: curl is accepted', async () => {
        const res = await crawl({ engine: 'curl' });
        assert.strictEqual(res.status, 200);
    });

    it('X-Engine header is accepted', async () => {
        const res = await crawlWithHeaders({ 'X-Engine': 'auto' });
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

    it('respondTiming: resource-idle is accepted', async () => {
        const res = await crawl({ respondTiming: 'resource-idle' });
        assert.strictEqual(res.status, 200);
    });

    it('X-Respond-Timing header is accepted', async () => {
        const res = await crawlWithHeaders({ 'X-Respond-Timing': 'html' });
        assert.strictEqual(res.status, 200);
    });
});
