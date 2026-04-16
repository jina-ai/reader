/**
 * E2E tests for selector-based crawler options:
 *   targetSelector  – return only the matched element's content
 *   removeSelector  – strip matching elements before formatting
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { crawl, crawlWithHeaders } from '../helpers/client';

describe('targetSelector', () => {
    it('returns only the targeted element content', async () => {
        const res = await crawl({ targetSelector: '#main-content', respondWith: 'markdown' });
        assert.strictEqual(res.status, 200);
        const content: string = res.body.data.content;
        assert.match(content, /Web Crawling Guide|Section One/i);
    });

    it('excludes elements outside the target', async () => {
        const res = await crawl({ targetSelector: '#main-content', respondWith: 'markdown' });
        const content: string = res.body.data.content;
        assert.doesNotMatch(content, /Related articles sidebar/i);
        assert.doesNotMatch(content, /Copyright 2024/i);
    });

    it('narrows to a specific section', async () => {
        const res = await crawl({ targetSelector: '.sidebar', respondWith: 'markdown' });
        assert.strictEqual(res.status, 200);
        const content: string = res.body.data.content;
        assert.match(content, /sidebar|Related articles/i);
        assert.doesNotMatch(content, /Section One: Basics/);
    });
});

describe('removeSelector', () => {
    it('strips matching elements from output', async () => {
        const res = await crawl({ removeSelector: '.ads', respondWith: 'markdown' });
        assert.strictEqual(res.status, 200);
        const content: string = res.body.data.content;
        assert.doesNotMatch(content, /Buy our product/i);
    });

    it('keeps the rest of the page intact', async () => {
        const res = await crawl({ removeSelector: '.ads', respondWith: 'markdown' });
        const content: string = res.body.data.content;
        assert.match(content, /Web Crawling Guide|Section One/i);
    });

    it('can remove multiple selectors', async () => {
        const res = await crawl({ removeSelector: ['.ads', '.sidebar', '#site-nav'], respondWith: 'markdown' });
        assert.strictEqual(res.status, 200);
        const content: string = res.body.data.content;
        assert.doesNotMatch(content, /Buy our product/i);
        assert.doesNotMatch(content, /Related articles sidebar/i);
        assert.match(content, /Web Crawling Guide/i);
    });
});

describe('removeSelector via X-Remove-Selector header', () => {
    it('strips element specified in header', async () => {
        const res = await crawlWithHeaders(
            { 'X-Remove-Selector': '.ads, footer' },
            { respondWith: 'markdown' },
        );
        assert.strictEqual(res.status, 200);
        assert.doesNotMatch(res.body.data.content, /Buy our product/i);
        assert.doesNotMatch(res.body.data.content, /Copyright 2024/i);
    });
});

describe('targetSelector via X-Target-Selector header', () => {
    it('narrows output to the header-specified selector', async () => {
        const res = await crawlWithHeaders(
            { 'X-Target-Selector': '#main-content' },
            { respondWith: 'markdown' },
        );
        assert.strictEqual(res.status, 200);
        assert.doesNotMatch(res.body.data.content, /Related articles sidebar/i);
        assert.match(res.body.data.content, /Section One|Section Two/i);
    });
});

describe('combined targetSelector + removeSelector', () => {
    it('first targets then removes within the target', async () => {
        const res = await crawl({
            targetSelector: '#main-content',
            removeSelector: 'h2',
            respondWith: 'markdown',
        });
        assert.strictEqual(res.status, 200);
        const content: string = res.body.data.content;
        assert.match(content, /web crawling|fetching pages/i);
        assert.doesNotMatch(content, /Section One|Section Two/);
    });
});
