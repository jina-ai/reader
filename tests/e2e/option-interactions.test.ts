/**
 * E2E tests for compound option interactions and edge cases.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { crawl } from '../helpers/client';

describe('withGeneratedAlt forces retainImages to all_p', () => {
    it('images with alt show markdown image format', async () => {
        const res = await crawl({ withGeneratedAlt: true, respondWith: 'markdown' });
        assert.strictEqual(res.status, 200);
        const content: string = res.body.data.content;
        assert.match(content, /\!\[/);
    });

    it('overrides retainImages: none to all_p', async () => {
        const res = await crawl({ withGeneratedAlt: true, retainImages: 'none', respondWith: 'markdown' });
        assert.strictEqual(res.status, 200);
        assert.match(res.body.data.content, /\!\[/);
    });
});

describe('retainLinks: gpt-oss forces withLinksSummary', () => {
    it('automatically includes links summary', async () => {
        const res = await crawl({ retainLinks: 'gpt-oss', respondWith: 'markdown' });
        assert.strictEqual(res.status, 200);
        assert.notStrictEqual(res.body.data.links, undefined);
    });

    it('uses citation format in content', async () => {
        const res = await crawl({ retainLinks: 'gpt-oss', respondWith: 'markdown' });
        const content: string = res.body.data.content;
        assert.match(content, /\u3010\d+\u2020/); // 【N†
    });
});

describe.skip('engine aliases', () => {
    it('engine: vlm is accepted (maps to browser + vlm)', async () => {
        const res = await crawl({ engine: 'vlm', respondWith: 'markdown' });
        assert.ok([200].includes(res.status));
    });

    it('engine: readerlm-v2 is accepted (maps to auto + readerlm-v2)', async () => {
        const res = await crawl({ engine: 'readerlm-v2', respondWith: 'markdown' });
        assert.ok([200].includes(res.status));
    });
});

describe('respondWith validation', () => {
    it('rejects lm + content combination', async () => {
        const res = await crawl({ respondWith: 'readerlm-v2+content' });
        assert.strictEqual(res.status, 400);
    });
});

describe('multiple options combined', () => {
    it('targetSelector + retainImages + markdown options together', async () => {
        const res = await crawl({
            targetSelector: '#main-content',
            retainImages: 'all',
            markdown: { headingStyle: 'atx', bulletListMarker: '-' },
            respondWith: 'markdown',
        });
        assert.strictEqual(res.status, 200);
        const content: string = res.body.data.content;
        assert.match(content, /^#{1,3} /m);
        assert.match(content, /^- /m);
        assert.match(content, /!\[/);
        assert.doesNotMatch(content, /Related articles sidebar/i);
    });

    it('removeSelector + withLinksSummary + markdownChunking together', async () => {
        const res = await crawl({
            removeSelector: '.ads',
            withLinksSummary: true,
            markdownChunking: 'simple',
            respondWith: 'markdown',
        });
        assert.strictEqual(res.status, 200);
        assert.ok(!res.body.data.content.includes('Buy our product'));
        assert.notStrictEqual(res.body.data.links, undefined);
        assert.ok(Array.isArray(res.body.data.chunks));
    });

    it('keepImgDataUrl + withImagesSummary together', async () => {
        const res = await crawl({
            keepImgDataUrl: true,
            withImagesSummary: true,
            respondWith: 'markdown',
        });
        assert.strictEqual(res.status, 200);
        assert.ok(res.body.data.content.includes('data:image/png;base64,'));
        assert.notStrictEqual(res.body.data.images, undefined);
    });

    it('noCache + tokenBudget together', async () => {
        const res = await crawl({ noCache: true, tokenBudget: 100000, respondWith: 'markdown' });
        assert.strictEqual(res.status, 200);
        assert.notStrictEqual(res.body.data.content, undefined);
    });
});
