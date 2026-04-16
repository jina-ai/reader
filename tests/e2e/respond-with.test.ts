/**
 * E2E tests for the `respondWith` crawler option.
 *
 * Covers: content, markdown, html, text formats.
 * Uses the `html` body param to skip network crawling entirely.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { crawl, getAgent, SAMPLE_HTML } from '../helpers/client';

describe('respondWith: default (content)', () => {
    it('returns a formatted markdown-like content field', async () => {
        const res = await crawl({});
        assert.strictEqual(res.status, 200);
        assert.notStrictEqual(res.body.data, undefined);
        const data = res.body.data;
        assert.notStrictEqual(data.content, undefined);
        assert.strictEqual(typeof data.content, 'string');
        assert.ok(data.content.length > 0);
    });

    it('includes the page title', async () => {
        const res = await crawl({});
        assert.ok(res.body.data.title.includes('Web Crawling Guide'));
    });

    it('includes the url', async () => {
        const res = await crawl({});
        assert.ok(res.body.data.url.includes('example.com'));
    });
});

describe('respondWith: markdown', () => {
    it('returns markdown-formatted content', async () => {
        const res = await crawl({ respondWith: 'markdown' });
        assert.strictEqual(res.status, 200);
        const data = res.body.data;
        assert.notStrictEqual(data.content, undefined);
        // markdown should contain heading markers
        assert.match(data.content, /#{1,6} /);
    });

    it('preserves headings from the fixture HTML', async () => {
        const res = await crawl({ respondWith: 'markdown' });
        assert.match(res.body.data.content, /Section One|Section Two|Section Three/);
    });
});

describe('respondWith: html', () => {
    it('returns the raw html field', async () => {
        const res = await crawl({ respondWith: 'html' });
        assert.strictEqual(res.status, 200);
        const data = res.body.data;
        assert.notStrictEqual(data.html, undefined);
        assert.match(data.html, /<html|<body|<article/i);
    });

    it('does not return markdown content field when responding with html', async () => {
        const res = await crawl({ respondWith: 'html' });
        assert.strictEqual(res.body.data.content, undefined);
    });
});

describe('respondWith: text', () => {
    it('returns a plain text field', async () => {
        const res = await crawl({ respondWith: 'text' });
        assert.strictEqual(res.status, 200);
        const data = res.body.data;
        assert.notStrictEqual(data.text, undefined);
        assert.strictEqual(typeof data.text, 'string');
    });

    it('text field has no HTML tags', async () => {
        const res = await crawl({ respondWith: 'text' });
        assert.doesNotMatch(res.body.data.text, /<[a-z]+[\s>]/i);
    });
});

describe('respondWith: compound formats', () => {
    it('responds with event-stream for compound formats', async () => {
        const res = await getAgent()
            .post('/')
            .set('Accept', 'text/event-stream')
            .set('Content-Type', 'application/json')
            .send({ html: SAMPLE_HTML, url: 'https://example.com/test', respondWith: 'markdown+html' });
        assert.strictEqual(res.status, 200);
        assert.match(res.headers['content-type'], /event-stream/);
    });
});
