/**
 * E2E tests for DOM manipulation crawler options:
 *   withIframe / withShadowDom / removeOverlay
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { crawl, crawlWithHeaders } from '../helpers/client';

describe('withIframe', () => {
    it('withIframe: false (default) returns content', async () => {
        const res = await crawl({ withIframe: false });
        assert.strictEqual(res.status, 200);
        assert.notStrictEqual(res.body.data.content, undefined);
    });

    it('withIframe: true is accepted', async () => {
        const res = await crawl({ withIframe: true });
        assert.strictEqual(res.status, 200);
        assert.notStrictEqual(res.body.data.content, undefined);
    });

    it('withIframe: "quoted" is accepted', async () => {
        const res = await crawl({ withIframe: 'quoted' });
        assert.strictEqual(res.status, 200);
    });

    it('X-With-Iframe header is accepted', async () => {
        const res = await crawlWithHeaders({ 'X-With-Iframe': 'true' });
        assert.strictEqual(res.status, 200);
    });

    it('X-With-Iframe: quoted is accepted via header', async () => {
        const res = await crawlWithHeaders({ 'X-With-Iframe': 'quoted' });
        assert.strictEqual(res.status, 200);
    });
});

describe('withShadowDom', () => {
    it('withShadowDom: false (default) returns content', async () => {
        const res = await crawl({ withShadowDom: false });
        assert.strictEqual(res.status, 200);
        assert.notStrictEqual(res.body.data.content, undefined);
    });

    it('withShadowDom: true is accepted', async () => {
        const res = await crawl({ withShadowDom: true });
        assert.strictEqual(res.status, 200);
    });

    it('X-With-Shadow-Dom header is accepted', async () => {
        const res = await crawlWithHeaders({ 'X-With-Shadow-Dom': 'true' });
        assert.strictEqual(res.status, 200);
    });
});

describe('removeOverlay', () => {
    it('removeOverlay: false (default) returns content', async () => {
        const res = await crawl({ removeOverlay: false });
        assert.strictEqual(res.status, 200);
        assert.notStrictEqual(res.body.data.content, undefined);
    });

    it('removeOverlay: true is accepted', async () => {
        const res = await crawl({ removeOverlay: true });
        assert.strictEqual(res.status, 200);
    });

    it('X-Remove-Overlay header is accepted', async () => {
        const res = await crawlWithHeaders({ 'X-Remove-Overlay': 'true' });
        assert.strictEqual(res.status, 200);
    });

    it('X-Remove-Overlay: false disables overlay removal', async () => {
        const res = await crawlWithHeaders({ 'X-Remove-Overlay': 'false' });
        assert.strictEqual(res.status, 200);
    });
});
