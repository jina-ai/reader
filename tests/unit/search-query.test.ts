/**
 * Unit tests for parseSearchQuery.
 * No server or network required.
 */
import 'reflect-metadata';
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parseSearchQuery } from '../../build/utils/search-query.js';

function makeParams(q: string): { q: string } {
    return { q };
}

describe('parseSearchQuery – plain query passthrough', () => {
    it('returns an empty query string for an empty input', () => {
        const { query } = parseSearchQuery(makeParams(''));
        assert.strictEqual(query, '');
    });

    it('passes through a simple word query unchanged', () => {
        const { query } = parseSearchQuery(makeParams('hello world'));
        assert.strictEqual(query, 'hello world');
    });

    it('passes through a query with no operators', () => {
        const { query } = parseSearchQuery(makeParams('web crawling techniques'));
        assert.strictEqual(query, 'web crawling techniques');
    });

    it('trims leading/trailing whitespace', () => {
        const { query } = parseSearchQuery(makeParams('  hello  '));
        assert.strictEqual(query, 'hello');
    });
});

describe('parseSearchQuery – site: operator', () => {
    it('strips site: token from the query text', () => {
        const { query } = parseSearchQuery(makeParams('web crawling site:example.com'));
        assert.ok(!query.includes('site:'));
    });

    it('bare domain (e.g. example.com) is classified under tld path', () => {
        // tld-extract returns the full registered domain as the "domain" key,
        // making it equal to the input, so mapDomainQuery classifies it as tld
        const { queryMixins } = parseSearchQuery(makeParams('hello site:example.com'));
        assert.ok(Array.isArray(queryMixins.filter));
        const tldFilter = queryMixins.filter!.find((f: any) => f?.in?.path === 'tld');
        assert.ok(tldFilter, 'expected a tld filter entry for a bare domain');
        assert.deepStrictEqual(tldFilter.in.value, ['example.com']);
    });

    it('subdomain (e.g. www.example.com) is classified under domain path', () => {
        const { queryMixins } = parseSearchQuery(makeParams('hello site:www.example.com'));
        assert.ok(Array.isArray(queryMixins.filter));
        const domainFilter = queryMixins.filter!.find((f: any) => f?.in?.path === 'domain');
        assert.ok(domainFilter, 'expected a domain filter entry for a subdomain');
        assert.deepStrictEqual(domainFilter.in.value, ['www.example.com']);
    });

    it('handles multiple site: operators in the same query', () => {
        const { queryMixins } = parseSearchQuery(makeParams('hello site:foo.com site:bar.com'));
        assert.ok(Array.isArray(queryMixins.filter));
        // Both foo.com and bar.com are bare domains → tld path
        const tldFilter = queryMixins.filter!.find((f: any) => f?.in?.path === 'tld');
        assert.ok(tldFilter, 'expected a tld filter');
        assert.deepStrictEqual(tldFilter.in.value, ['foo.com', 'bar.com']);
    });

    it('uses tld path when the site value is a bare TLD', () => {
        const { queryMixins } = parseSearchQuery(makeParams('news site:com'));
        const tldFilter = queryMixins.filter!.find((f: any) => f?.in?.path === 'tld');
        assert.ok(tldFilter, 'expected a tld filter entry');
    });
});

describe('parseSearchQuery – -site: operator', () => {
    it('strips -site: token from the query text', () => {
        const { query } = parseSearchQuery(makeParams('web crawling -site:spam.com'));
        assert.ok(!query.includes('-site:'));
    });

    it('populates queryMixins.mustNot with the excluded domain', () => {
        const { queryMixins } = parseSearchQuery(makeParams('hello -site:spam.com'));
        assert.ok(Array.isArray(queryMixins.mustNot));
        const excluded = queryMixins.mustNot!.find((f: any) => f?.equals?.value === 'spam.com');
        assert.ok(excluded, 'expected spam.com in mustNot');
    });

    it('handles multiple -site: operators', () => {
        const { queryMixins } = parseSearchQuery(makeParams('hello -site:a.com -site:b.com'));
        const values = queryMixins.mustNot!.map((f: any) => f?.equals?.value);
        assert.deepStrictEqual(values.sort(), ['a.com', 'b.com']);
    });
});

describe('parseSearchQuery – mixed operators', () => {
    it('keeps query text while extracting both site: and -site:', () => {
        const { query, queryMixins } = parseSearchQuery(
            // Use subdomain to get a domain-path filter entry
            makeParams('machine learning site:www.arxiv.org -site:spam.com'),
        );
        assert.ok(query.includes('machine'));
        assert.ok(query.includes('learning'));
        assert.ok(!query.includes('site:'));
        const domainFilter = queryMixins.filter!.find((f: any) => f?.in?.path === 'domain');
        assert.deepStrictEqual(domainFilter?.in?.value, ['www.arxiv.org']);
        const excluded = queryMixins.mustNot!.find((f: any) => f?.equals?.value === 'spam.com');
        assert.ok(excluded);
    });

    it('returns empty queryMixins when no operators are present', () => {
        const { queryMixins } = parseSearchQuery(makeParams('just a plain query'));
        assert.strictEqual(queryMixins.filter, undefined);
        assert.strictEqual(queryMixins.mustNot, undefined);
    });
});
