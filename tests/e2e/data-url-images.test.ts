/**
 * E2E tests for the `keepImgDataUrl` crawler option.
 *
 * Controls whether data: URL images are kept as-is or converted to blob: URLs.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { crawl, crawlWithHeaders } from '../helpers/client';

describe('keepImgDataUrl: false (default)', () => {
    it('converts data: URL images to blob: URLs', async () => {
        const res = await crawl({ respondWith: 'markdown' });
        assert.strictEqual(res.status, 200);
        const content: string = res.body.data.content;
        assert.match(content, /!\[Image \d+: Tiny pixel\]\(blob:/);
        assert.ok(!content.includes('data:image/png;base64,'));
    });

    it('still includes the alt text for the data URL image', async () => {
        const res = await crawl({ respondWith: 'markdown' });
        assert.ok(res.body.data.content.includes('Tiny pixel'));
    });
});

describe('keepImgDataUrl: true', () => {
    it('preserves data: URL in markdown image reference', async () => {
        const res = await crawl({ keepImgDataUrl: true, respondWith: 'markdown' });
        assert.strictEqual(res.status, 200);
        const content: string = res.body.data.content;
        assert.ok(content.includes('data:image/png;base64,iVBOR'));
    });

    it('keeps alt text for data URL images', async () => {
        const res = await crawl({ keepImgDataUrl: true, respondWith: 'markdown' });
        assert.ok(res.body.data.content.includes('Tiny pixel'));
    });

    it('does not affect non-data-URL images', async () => {
        const res = await crawl({ keepImgDataUrl: true, respondWith: 'markdown' });
        const content: string = res.body.data.content;
        assert.ok(content.includes('https://example.com/spider.png'));
        assert.ok(content.includes('https://example.com/network.jpg'));
    });
});

describe('keepImgDataUrl via X-Keep-Img-Data-Url header', () => {
    it('header enables data URL preservation', async () => {
        const res = await crawlWithHeaders(
            { 'X-Keep-Img-Data-Url': 'true' },
            { respondWith: 'markdown' },
        );
        assert.strictEqual(res.status, 200);
        assert.ok(res.body.data.content.includes('data:image/png;base64,'));
    });
});

describe('keepImgDataUrl interaction with retainImages', () => {
    it('retainImages: none hides data URL images regardless', async () => {
        const res = await crawl({ keepImgDataUrl: true, retainImages: 'none', respondWith: 'markdown' });
        assert.strictEqual(res.status, 200);
        assert.ok(!res.body.data.content.includes('data:image'));
        assert.doesNotMatch(res.body.data.content, /!\[/);
    });

    it('retainImages: alt shows only alt text for data URL images', async () => {
        const res = await crawl({ keepImgDataUrl: true, retainImages: 'alt', respondWith: 'markdown' });
        assert.strictEqual(res.status, 200);
        const content: string = res.body.data.content;
        assert.match(content, /\(Image \d+:.*Tiny pixel/i);
        assert.ok(!content.includes('data:image/png;base64,'));
    });
});
