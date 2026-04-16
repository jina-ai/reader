/**
 * E2E tests for the `tokenBudget` crawler option.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { crawl, crawlWithHeaders } from '../helpers/client';

describe('tokenBudget: large (passes)', () => {
    it('returns content normally with a generous budget', async () => {
        const res = await crawl({ tokenBudget: 100000, respondWith: 'markdown' });
        assert.strictEqual(res.status, 200);
        assert.notStrictEqual(res.body.data.content, undefined);
        assert.ok(res.body.data.content.length > 0);
    });
});

describe('tokenBudget: tiny (rejected)', () => {
    it('returns 409 BudgetExceededError for budget of 1', async () => {
        const res = await crawl({ tokenBudget: 1, respondWith: 'markdown' });
        assert.strictEqual(res.status, 409);
        assert.strictEqual(res.body.name, 'BudgetExceededError');
        assert.match(res.body.message, /budget.*exceeded/i);
    });

    it('error message includes the budget value', async () => {
        const res = await crawl({ tokenBudget: 1, respondWith: 'markdown' });
        assert.ok(res.body.message.includes('1'));
    });
});

describe('tokenBudget: not set', () => {
    it('returns content without budget enforcement', async () => {
        const res = await crawl({ respondWith: 'markdown' });
        assert.strictEqual(res.status, 200);
        assert.notStrictEqual(res.body.data.content, undefined);
    });
});

describe('tokenBudget via X-Token-Budget header', () => {
    it('header enforces token budget', async () => {
        const res = await crawlWithHeaders(
            { 'X-Token-Budget': '1' },
            { respondWith: 'markdown' },
        );
        assert.strictEqual(res.status, 409);
        assert.strictEqual(res.body.name, 'BudgetExceededError');
    });

    it('large budget via header passes', async () => {
        const res = await crawlWithHeaders(
            { 'X-Token-Budget': '100000' },
            { respondWith: 'markdown' },
        );
        assert.strictEqual(res.status, 200);
        assert.notStrictEqual(res.body.data.content, undefined);
    });
});
