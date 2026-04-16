/**
 * E2E tests for request-level crawler options:
 *   userAgent / locale / referer / setCookies / proxyUrl / proxy / customHeader / robotsTxt
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { crawl, crawlWithHeaders } from '../helpers/client';

describe('userAgent', () => {
    it('accepts custom userAgent in body', async () => {
        const res = await crawl({ userAgent: 'CustomBot/1.0' });
        assert.strictEqual(res.status, 200);
        assert.notStrictEqual(res.body.data.content, undefined);
    });

    it('X-User-Agent header is accepted', async () => {
        const res = await crawlWithHeaders({ 'X-User-Agent': 'CustomBot/1.0' });
        assert.strictEqual(res.status, 200);
    });
});

describe('locale', () => {
    it('accepts locale in body', async () => {
        const res = await crawl({ locale: 'en-US' });
        assert.strictEqual(res.status, 200);
    });

    it('X-Locale header is accepted', async () => {
        const res = await crawlWithHeaders({ 'X-Locale': 'ja-JP' });
        assert.strictEqual(res.status, 200);
    });
});

describe('referer', () => {
    it('accepts referer in body', async () => {
        const res = await crawl({ referer: 'https://google.com' });
        assert.strictEqual(res.status, 200);
    });

    it('X-Referer header is accepted', async () => {
        const res = await crawlWithHeaders({ 'X-Referer': 'https://google.com' });
        assert.strictEqual(res.status, 200);
    });
});

describe('setCookies', () => {
    it('accepts cookies array in body', async () => {
        const res = await crawl({
            setCookies: ['session=abc123; Path=/; Domain=example.com'],
        });
        assert.strictEqual(res.status, 200);
        assert.notStrictEqual(res.body.data.content, undefined);
    });

    it('X-Set-Cookie header is accepted', async () => {
        const res = await crawlWithHeaders({
            'X-Set-Cookie': 'session=abc123; Path=/; Domain=example.com',
        });
        assert.strictEqual(res.status, 200);
    });
});

describe('proxyUrl', () => {
    it('accepts proxyUrl in body', async () => {
        const res = await crawl({ proxyUrl: 'http://proxy.example.com:8080' });
        assert.strictEqual(res.status, 200);
    });

    it('X-Proxy-Url header is accepted', async () => {
        const res = await crawlWithHeaders({
            'X-Proxy-Url': 'socks5://proxy.example.com:1080',
        });
        assert.strictEqual(res.status, 200);
    });
});

describe('proxy', () => {
    it('accepts proxy flag in body', async () => {
        const res = await crawl({ proxy: 'us' });
        assert.strictEqual(res.status, 200);
    });

    it('X-Proxy header is accepted', async () => {
        const res = await crawlWithHeaders({ 'X-Proxy': 'de' });
        assert.strictEqual(res.status, 200);
    });
});

describe('customHeader', () => {
    it('accepts customHeader dict in body', async () => {
        const res = await crawl({
            customHeader: { 'X-Custom-Test': 'hello' },
        });
        assert.strictEqual(res.status, 200);
        assert.notStrictEqual(res.body.data.content, undefined);
    });
});

describe('robotsTxt', () => {
    it('accepts robotsTxt in body', async () => {
        const res = await crawl({ robotsTxt: 'Googlebot' });
        assert.strictEqual(res.status, 200);
    });

    it('X-Robots-Txt header is accepted', async () => {
        const res = await crawlWithHeaders({ 'X-Robots-Txt': 'Googlebot' });
        assert.strictEqual(res.status, 200);
    });
});
