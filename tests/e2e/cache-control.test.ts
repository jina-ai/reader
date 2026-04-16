/**
 * E2E tests for cache control options:
 *   noCache / cacheTolerance / doNotTrack (DNT)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { crawl, crawlWithHeaders } from '../helpers/client';

describe('noCache', () => {
    it('noCache: false (default) returns content', async () => {
        const res = await crawl({ noCache: false });
        assert.strictEqual(res.status, 200);
        assert.notStrictEqual(res.body.data.content, undefined);
    });

    it('noCache: true returns content', async () => {
        const res = await crawl({ noCache: true });
        assert.strictEqual(res.status, 200);
        assert.notStrictEqual(res.body.data.content, undefined);
    });

    it('X-No-Cache header is accepted', async () => {
        const res = await crawlWithHeaders({ 'X-No-Cache': 'true' });
        assert.strictEqual(res.status, 200);
    });
});

describe('cacheTolerance', () => {
    it('accepts cacheTolerance as a number', async () => {
        const res = await crawl({ cacheTolerance: 3600 });
        assert.strictEqual(res.status, 200);
        assert.notStrictEqual(res.body.data.content, undefined);
    });

    it('cacheTolerance: 0 is accepted (equivalent to noCache)', async () => {
        const res = await crawl({ cacheTolerance: 0 });
        assert.strictEqual(res.status, 200);
    });

    it('X-Cache-Tolerance header is accepted', async () => {
        const res = await crawlWithHeaders({ 'X-Cache-Tolerance': '60' });
        assert.strictEqual(res.status, 200);
    });
});

describe('doNotTrack (DNT header)', () => {
    it('DNT: 1 is accepted and returns content', async () => {
        const res = await crawlWithHeaders({ 'DNT': '1' });
        assert.strictEqual(res.status, 200);
        assert.notStrictEqual(res.body.data.content, undefined);
    });

    it('DNT: 0 is accepted', async () => {
        const res = await crawlWithHeaders({ 'DNT': '0' });
        assert.strictEqual(res.status, 200);
    });
});
