/**
 * E2E tests for additional markdown formatting options:
 *   markdown.hr                – custom horizontal rule text
 *   markdown.linkReferenceStyle – full | collapsed | shortcut | discarded
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { crawl, crawlWithHeaders } from '../helpers/client';

describe('markdown.hr', () => {
    it('default hr renders as * * *', async () => {
        const res = await crawl({ respondWith: 'markdown' });
        assert.strictEqual(res.status, 200);
        assert.ok(res.body.data.content.includes('* * *'));
    });

    it('custom hr text replaces default', async () => {
        const res = await crawl({ markdown: { hr: '---' }, respondWith: 'markdown' });
        assert.strictEqual(res.status, 200);
        const content: string = res.body.data.content;
        assert.ok(content.includes('---'));
        assert.ok(content.includes('Content before the rule.'));
        assert.ok(content.includes('Content after the rule.'));
    });

    it('another custom hr value works', async () => {
        const res = await crawl({ markdown: { hr: '***' }, respondWith: 'markdown' });
        assert.strictEqual(res.status, 200);
        assert.ok(res.body.data.content.includes('***'));
    });

    it('X-Md-Hr header is respected', async () => {
        const res = await crawlWithHeaders({ 'X-Md-Hr': '---' }, { respondWith: 'markdown' });
        assert.strictEqual(res.status, 200);
        assert.ok(res.body.data.content.includes('---'));
    });
});

describe('markdown.linkReferenceStyle (with linkStyle: referenced)', () => {
    it('full style produces [text][id] with reference definitions', async () => {
        const res = await crawl({ markdown: { linkStyle: 'referenced', linkReferenceStyle: 'full' }, respondWith: 'markdown' });
        assert.strictEqual(res.status, 200);
        const content: string = res.body.data.content;
        assert.match(content, /\[.*?\]\[\d+\]/);
        assert.match(content, /\[\d+\]: https?:\/\//);
    });

    it('collapsed style produces [text][] format', async () => {
        const res = await crawl({ markdown: { linkStyle: 'referenced', linkReferenceStyle: 'collapsed' }, respondWith: 'markdown' });
        assert.strictEqual(res.status, 200);
        const content: string = res.body.data.content;
        assert.match(content, /\[.*?\]\[\]/);
    });

    it('shortcut style produces [text] format', async () => {
        const res = await crawl({ markdown: { linkStyle: 'referenced', linkReferenceStyle: 'shortcut' }, respondWith: 'markdown' });
        assert.strictEqual(res.status, 200);
        const content: string = res.body.data.content;
        assert.match(content, /\[.*?\]: https?:\/\//);
    });

    it('X-Md-Link-Reference-Style header works', async () => {
        const res = await crawlWithHeaders({
            'X-Md-Link-Style': 'referenced',
            'X-Md-Link-Reference-Style': 'full',
        }, { respondWith: 'markdown' });
        assert.strictEqual(res.status, 200);
        assert.match(res.body.data.content, /\[\d+\]: https?:\/\//);
    });
});
