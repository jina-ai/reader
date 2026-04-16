/**
 * Tests for CrawlerOptions DTO methods.
 * These are pure logic tests — no server, no network.
 *
 * Imports from the compiled build/ output to avoid coupling
 * the test framework to TypeScript compilation of project source.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import 'reflect-metadata';
import { CrawlerOptions, RESPOND_TIMING, CONTENT_FORMAT } from '../../build/dto/crawler-options';
import { RPC_CALL_ENVIRONMENT } from 'civkit/civ-rpc';

function makeOpts(overrides: Partial<CrawlerOptions> = {}): CrawlerOptions {
    return Object.assign(CrawlerOptions.from({}), overrides) as CrawlerOptions;
}

function makeSnapshot(overrides: Record<string, any> = {}): any {
    return {
        title: 'Test',
        href: 'https://example.com/',
        html: '<html><body><h1>Test</h1></body></html>',
        text: 'Test',
        ...overrides,
    };
}

// ── presumedRespondTiming ────────────────────────────────────────────────────

describe('CrawlerOptions.presumedRespondTiming', () => {
    it('returns explicit respondTiming when set', () => {
        const opts = makeOpts({ respondTiming: RESPOND_TIMING.NETWORK_IDLE });
        assert.strictEqual(opts.presumedRespondTiming, RESPOND_TIMING.NETWORK_IDLE);
    });

    it('returns NETWORK_IDLE when timeout >= 20', () => {
        const opts = makeOpts({ timeout: 30 });
        assert.strictEqual(opts.presumedRespondTiming, RESPOND_TIMING.NETWORK_IDLE);
    });

    it('returns NETWORK_IDLE when withIframe is set', () => {
        const opts = makeOpts({ withIframe: true });
        assert.strictEqual(opts.presumedRespondTiming, RESPOND_TIMING.NETWORK_IDLE);
    });

    it('returns MEDIA_IDLE for screenshot/pageshot respondWith', () => {
        const opts = makeOpts({ respondWith: 'screenshot' });
        assert.strictEqual(opts.presumedRespondTiming, RESPOND_TIMING.MEDIA_IDLE);
    });

    it('returns MEDIA_IDLE for vlm respondWith', () => {
        const opts = makeOpts({ respondWith: 'vlm' });
        assert.strictEqual(opts.presumedRespondTiming, RESPOND_TIMING.MEDIA_IDLE);
    });

    it('defaults to RESOURCE_IDLE for normal content', () => {
        const opts = makeOpts({ respondWith: 'markdown' });
        assert.strictEqual(opts.presumedRespondTiming, RESPOND_TIMING.RESOURCE_IDLE);
    });
});

// ── isCacheQueryApplicable ───────────────────────────────────────────────────

describe('CrawlerOptions.isCacheQueryApplicable', () => {
    it('returns true by default', () => {
        assert.strictEqual(makeOpts().isCacheQueryApplicable(), true);
    });

    it('returns false when noCache is true', () => {
        assert.strictEqual(makeOpts({ noCache: true }).isCacheQueryApplicable(), false);
    });

    it('returns false when cacheTolerance is 0', () => {
        assert.strictEqual(makeOpts({ cacheTolerance: 0 }).isCacheQueryApplicable(), false);
    });

    it('returns false when setCookies are present', () => {
        const opts = makeOpts({ setCookies: [{ name: 'session', value: 'abc' }] });
        assert.strictEqual(opts.isCacheQueryApplicable(), false);
    });

    it('returns false when injectPageScript is set', () => {
        const opts = makeOpts({ injectPageScript: ['console.log(1)'] });
        assert.strictEqual(opts.isCacheQueryApplicable(), false);
    });

    it('returns false when viewport is set', () => {
        const opts = makeOpts({ viewport: { width: 1280, height: 800 } as any });
        assert.strictEqual(opts.isCacheQueryApplicable(), false);
    });

    it('returns false when instruction is set', () => {
        const opts = makeOpts({ instruction: 'summarise this' });
        assert.strictEqual(opts.isCacheQueryApplicable(), false);
    });

    it('returns false when removeOverlay is true', () => {
        const opts = makeOpts({ removeOverlay: true });
        assert.strictEqual(opts.isCacheQueryApplicable(), false);
    });
});

// ── browserIsNotRequired ─────────────────────────────────────────────────────

describe('CrawlerOptions.browserIsNotRequired', () => {
    it('returns true for plain content/markdown', () => {
        assert.strictEqual(makeOpts({ respondWith: 'markdown' }).browserIsNotRequired(), true);
    });

    it('returns false when respondTiming is resource-idle', () => {
        const opts = makeOpts({ respondTiming: RESPOND_TIMING.RESOURCE_IDLE });
        assert.strictEqual(opts.browserIsNotRequired(), false);
    });

    it('returns false when screenshot is requested', () => {
        assert.strictEqual(makeOpts({ respondWith: 'screenshot' }).browserIsNotRequired(), false);
    });

    it('returns false when pageshot is requested', () => {
        assert.strictEqual(makeOpts({ respondWith: 'pageshot' }).browserIsNotRequired(), false);
    });

    it('returns false when injectPageScript is set', () => {
        assert.strictEqual(makeOpts({ injectPageScript: ['alert(1)'] }).browserIsNotRequired(), false);
    });

    it('returns false when waitForSelector is set', () => {
        assert.strictEqual(makeOpts({ waitForSelector: ['.loaded'] }).browserIsNotRequired(), false);
    });

    it('returns false when withIframe is set', () => {
        assert.strictEqual(makeOpts({ withIframe: true }).browserIsNotRequired(), false);
    });

    it('returns false when withShadowDom is set', () => {
        assert.strictEqual(makeOpts({ withShadowDom: true }).browserIsNotRequired(), false);
    });

    it('returns false when viewport is set', () => {
        assert.strictEqual(makeOpts({ viewport: { width: 375, height: 812 } as any }).browserIsNotRequired(), false);
    });

    it('returns false when html is provided (needs puppeteer for rendering)', () => {
        assert.strictEqual(makeOpts({ html: '<html/>' }).browserIsNotRequired(), false);
    });
});

// ── readabilityRequired ───────────────────────────────────────────────────────

describe('CrawlerOptions.readabilityRequired', () => {
    it('returns true for content format', () => {
        assert.strictEqual(makeOpts({ respondWith: 'content' }).readabilityRequired(), true);
    });

    it('returns true when respondWith is empty/default', () => {
        assert.strictEqual(makeOpts().readabilityRequired(), true);
    });

    it('returns false for html-only format', () => {
        assert.strictEqual(makeOpts({ respondWith: 'html' }).readabilityRequired(), false);
    });

    it('returns false for text-only format', () => {
        assert.strictEqual(makeOpts({ respondWith: 'text' }).readabilityRequired(), false);
    });
});

// ── isRequestingCompoundContentFormat ────────────────────────────────────────

describe('CrawlerOptions.isRequestingCompoundContentFormat', () => {
    it('returns false for single known format', () => {
        assert.strictEqual(makeOpts({ respondWith: 'markdown' }).isRequestingCompoundContentFormat(), false);
        assert.strictEqual(makeOpts({ respondWith: 'html' }).isRequestingCompoundContentFormat(), false);
    });

    it('returns true for combined formats like markdown+html', () => {
        assert.strictEqual(makeOpts({ respondWith: 'markdown+html' }).isRequestingCompoundContentFormat(), true);
    });
});

// ── isSnapshotAcceptableForEarlyResponse ─────────────────────────────────────

describe('CrawlerOptions.isSnapshotAcceptableForEarlyResponse', () => {
    it('returns false when waitForSelector is present', () => {
        const opts = makeOpts({ waitForSelector: ['.loaded'] });
        assert.strictEqual(opts.isSnapshotAcceptableForEarlyResponse(makeSnapshot()), false);
    });

    it('returns false for network-idle timing (needs full load)', () => {
        const opts = makeOpts({ respondTiming: RESPOND_TIMING.NETWORK_IDLE });
        assert.strictEqual(opts.isSnapshotAcceptableForEarlyResponse(makeSnapshot()), false);
    });

    it('returns false for lm format', () => {
        const opts = makeOpts({ respondWith: CONTENT_FORMAT.READER_LM });
        assert.strictEqual(opts.isSnapshotAcceptableForEarlyResponse(makeSnapshot()), false);
    });

    it('returns true for html timing with html present', () => {
        const opts = makeOpts({ respondTiming: RESPOND_TIMING.HTML });
        assert.strictEqual(opts.isSnapshotAcceptableForEarlyResponse(makeSnapshot({ html: '<html/>' })), true);
    });

    it('returns true for visible-content timing when parsed content exists', () => {
        const opts = makeOpts({ respondTiming: RESPOND_TIMING.VISIBLE_CONTENT });
        const snapshot = makeSnapshot({ parsed: { content: '<p>hello</p>' } });
        assert.strictEqual(opts.isSnapshotAcceptableForEarlyResponse(snapshot), true);
    });
});

// ── CrawlerOptions.from() header parsing ─────────────────────────────────────

describe('CrawlerOptions.from() header parsing', () => {
    function fromWithHeaders(headers: Record<string, string>): CrawlerOptions {
        const lowerHeaders = Object.fromEntries(
            Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])
        );
        const mockCtx = {
            get: (h: string) => lowerHeaders[h.toLowerCase()] ?? '',
            headers: lowerHeaders,
        };
        const input = Object.create({});
        Reflect.set(input, RPC_CALL_ENVIRONMENT, mockCtx);
        return CrawlerOptions.from(input) as CrawlerOptions;
    }

    it('parses X-Respond-With header', () => {
        const opts = fromWithHeaders({ 'x-respond-with': 'html' });
        assert.strictEqual(opts.respondWith, 'html');
    });

    it('parses X-Retain-Images header', () => {
        const opts = fromWithHeaders({ 'x-retain-images': 'none' });
        assert.strictEqual(opts.retainImages, 'none');
    });

    it('parses X-Retain-Links header', () => {
        const opts = fromWithHeaders({ 'x-retain-links': 'text' });
        assert.strictEqual(opts.retainLinks, 'text');
    });

    it('parses X-No-Cache header', () => {
        const opts = fromWithHeaders({ 'x-no-cache': '1' });
        assert.strictEqual(opts.noCache, true);
        assert.strictEqual(opts.cacheTolerance, 0);
    });

    it('parses X-Cache-Tolerance header and converts to ms', () => {
        const opts = fromWithHeaders({ 'x-cache-tolerance': '3600' });
        assert.strictEqual(opts.cacheTolerance, 3600 * 1000);
    });

    it('parses X-Timeout header', () => {
        const opts = fromWithHeaders({ 'x-timeout': '30' });
        assert.strictEqual(opts.timeout, 30);
    });

    it('clamps X-Timeout to 180', () => {
        const opts = fromWithHeaders({ 'x-timeout': '999' });
        assert.strictEqual(opts.timeout, 180);
    });

    it('parses X-Remove-Selector header (comma-separated)', () => {
        const opts = fromWithHeaders({ 'x-remove-selector': '.ads, footer' });
        assert.deepStrictEqual(opts.removeSelector, ['.ads', 'footer']);
    });

    it('parses X-Target-Selector and copies to waitForSelector', () => {
        const opts = fromWithHeaders({ 'x-target-selector': '#content' });
        assert.deepStrictEqual(opts.targetSelector, ['#content']);
        assert.deepStrictEqual(opts.waitForSelector, ['#content']);
    });

    it('gpt-oss retain-links implies withLinksSummary: gpt-oss', () => {
        const opts = fromWithHeaders({ 'x-retain-links': 'gpt-oss' });
        assert.strictEqual(opts.retainLinks, 'gpt-oss');
        assert.strictEqual(opts.withLinksSummary, 'gpt-oss');
    });

    it('engine: vlm maps to browser engine + vlm respondWith', () => {
        const opts = fromWithHeaders({ 'x-engine': 'vlm' });
        assert.strictEqual(opts.engine, 'browser');
        assert.strictEqual(opts.respondWith, CONTENT_FORMAT.VLM);
    });

    it('rejects lm+content combination', () => {
        assert.throws(() => {
            fromWithHeaders({ 'x-respond-with': 'readerlm-v2+content' });
        });
    });
});
