import { singleton } from 'tsyringe';
import {
    assignTransferProtocolMeta, RPCHost, RPCReflection, AssertionFailureError, assignMeta, RawString,
    DownstreamServiceFailureError,
    AuthenticationRequiredError,
} from 'civkit/civ-rpc';
import { marshalErrorLike } from 'civkit/lang';
import { objHashMd5B64Of } from 'civkit/hash';
import _ from 'lodash';

import { CrawlerHost, ExtraScrappingOptions } from './crawler';
import { CrawlerOptions, RESPOND_TIMING } from '../dto/crawler-options';
import { SnapshotFormatter, FormattedPage as RealFormattedPage } from '../services/snapshot-formatter';
import { GoogleSearchExplicitOperatorsDto } from '../services/serper-search';

import { GlobalLogger } from '../services/logger';
import { AsyncLocalContext } from '../services/async-context';
import { Context, Ctx, Method, Param, RPCReflect } from '../services/registry';
import { InputServerEventStream, OutputServerEventStream } from '../lib/transform-server-event-stream';

import { SerperBingSearchService, SerperGoogleSearchService } from '../services/serp/serper';
import { consumeAsyncGenerator, delayGenerator, finalYield, raceAsyncGenerators, timeoutGenerator, toAsyncGenerator } from '../utils/misc';
import { SerperSearchQueryParams, WORLD_COUNTRIES, WORLD_LANGUAGES } from '../3rd-party/serper-search';
import { WebSearchEntry } from '../services/serp/compat';
import { CommonGoogleSERP } from '../services/serp/common-serp';
import { GoogleSERP, GoogleSERPOldFashion } from '../services/serp/google';
import { EnvConfig } from '../services/envconfig';
import { Readable } from 'stream';
import { once } from 'events';
import { Defer } from 'civkit/defer';
import { BingSERP } from '../services/serp/bing';
import { BraveSearchService } from '../services/serp/brave';
import { bcp47ToIso639_3 } from '../utils/languages';
import { parseSearchQuery } from '../utils/search-query';
import { JSDomControl } from '../services/jsdom';
import { delay } from 'civkit/timeout';
import { BaseAuthDTO } from '../dto/base-auth';
import { SERPResult } from '../db/models';
import { StorageLayer } from '../db/noop-storage';
import { AUTH_DTO_CLS } from '../config';

const WORLD_COUNTRY_CODES = Object.keys(WORLD_COUNTRIES).map((x) => x.toLowerCase());

interface FormattedPage extends RealFormattedPage {
    favicon?: string;
    date?: string;
}

@singleton()
export class SearcherHost extends RPCHost {
    logger = this.globalLogger.child({ service: this.constructor.name });

    cacheRetentionMs = 1000 * 3600 * 24 * 7;
    cacheValidMs = 1000 * 3600;
    pageCacheToleranceMs = 1000 * 3600 * 24;

    reasonableDelayMs = 25_000;

    targetResultCount = 6;

    constructor(
        protected globalLogger: GlobalLogger,
        protected envConfig: EnvConfig,
        protected threadLocal: AsyncLocalContext,
        protected crawler: CrawlerHost,
        protected snapshotFormatter: SnapshotFormatter,
        protected jsdomControl: JSDomControl,
        protected serperGoogle: SerperGoogleSearchService,
        protected serperBing: SerperBingSearchService,
        protected commonGoogleSerp: CommonGoogleSERP,
        protected googleSERP: GoogleSERP,
        protected googleSERPOld: GoogleSERPOldFashion,
        protected bingSERP: BingSERP,
        protected braveSearch: BraveSearchService,
        protected storageLayer: StorageLayer,
    ) {
        super(...arguments);
    }

    override async init() {
        await this.dependencyReady();

        this.emit('ready');
    }

    @Method({
        name: 'searchIndex',
        ext: {
            http: {
                action: ['get', 'post'],
                path: '/search'
            }
        },
        tags: ['search'],
        returnType: [String, OutputServerEventStream],
    })
    @Method({
        ext: {
            http: {
                action: ['get', 'post'],
                path: '::q'
            }
        },
        tags: ['search'],
        returnType: [String, OutputServerEventStream, RawString],
    })
    async search(
        @RPCReflect() rpcReflect: RPCReflection,
        @Ctx() ctx: Context,
        @Param({ type: AUTH_DTO_CLS }) auth: BaseAuthDTO,
        crawlerOptions: CrawlerOptions,
        searchExplicitOperators: GoogleSearchExplicitOperatorsDto,
        @Param('type', { type: new Set(['web', 'images', 'news']), default: 'web' })
        variant: 'web' | 'images' | 'news',
        @Param('count', { validate: (v: number) => v >= 0 && v <= 20 })
        @Param('num', { validate: (v: number) => v >= 0 && v <= 20 })
        count: number = 10,
        @Param('provider', { type: new Set(['google', 'bing', 'brave', 'reader']) })
        @Param('engine', { type: new Set(['google', 'bing', 'brave', 'reader']) })
        searchEngine?: 'google' | 'bing' | 'brave' | 'reader',
        @Param('gl', { validate: (v: string) => WORLD_COUNTRY_CODES.includes(v?.toLowerCase()) }) gl?: string,
        @Param('hl', { validate: (v: string) => WORLD_LANGUAGES.some(l => l.code === v) }) hl?: string,
        @Param('location') location?: string,
        @Param('page') page?: number,
        @Param('fallback', { type: Boolean, default: false }) fallback?: boolean,
        @Param('q') q?: string,
        @Param('nfpr') nfpr?: boolean,
    ) {
        // Return content by default
        const crawlWithoutContent = crawlerOptions.respondWith.includes('no-content');
        const withFavicon = Boolean(ctx.get('X-With-Favicons'));
        this.threadLocal.set('collect-favicon', withFavicon);
        crawlerOptions.respondTiming ??= RESPOND_TIMING.VISIBLE_CONTENT;

        let chargeAmount = 0;
        const noSlashPath = decodeURIComponent(ctx.path).slice(1);
        if (!noSlashPath && !q) {
            const index = await this.crawler.getIndex(auth);
            if (!auth.isInternal && !auth.bearerToken) {
                index.note = 'Authentication is required to use this endpoint. Please provide a valid API key via Authorization header.';
            }
            if (!ctx.accepts('text/plain') && (ctx.accepts('text/json') || ctx.accepts('application/json'))) {

                return index;
            }

            return assignTransferProtocolMeta(`${index}`,
                { contentType: 'text/plain', envelope: null }
            );
        }

        const {
            uid,
            reportOptions,
            reportUsage,
            isAnonymous,
        } = await this.storageLayer.rateLimit(ctx, rpcReflect, auth as any);

        if (isAnonymous && !auth.isInternal) {
            throw new AuthenticationRequiredError('Authentication is required to use this endpoint. Please provide a valid API key via Authorization header.');
        }

        rpcReflect.finally(() => {
            reportOptions?.(crawlerOptions.customizedProps());
            reportUsage?.(chargeAmount, 'reader-search');
        });

        delete crawlerOptions.html;
        delete crawlerOptions.file;
        delete crawlerOptions.pdf;

        const crawlOpts = await this.crawler.configure(crawlerOptions);
        crawlOpts.eligibleForPageIndex = true;
        const searchQuery = searchExplicitOperators.addTo(q || noSlashPath);

        this.logger.info(`Accepting request from ${uid || ctx.ip}`, { opts: crawlerOptions, searchQuery });

        let chargeAmountScaler = 1;
        if (searchEngine === 'bing') {
            this.threadLocal.set('bing-preferred', true);
            chargeAmountScaler = 3;
        }

        if (variant !== 'web') {
            chargeAmountScaler = 5;
        }

        const searchParams = {
            variant,
            provider: searchEngine,
            q: searchQuery,
            num: count,
            gl,
            hl,
            location,
            page,
            nfpr,
        };
        const timeoutMs = crawlOpts.timeoutMs || this.reasonableDelayMs;
        const t0 = performance.now();

        let localSearchIterator: AsyncGenerator<FormattedPage[], void, undefined> | undefined;
        let localResultsPromise: Promise<FormattedPage[] | undefined> | undefined;
        let isDelayDemanding = false;
        let it;
        let results: FormattedPage[];
        if (searchEngine === 'reader') {
            this.logger.debug(`Preparing local cache search`, { timeoutMs });
            localSearchIterator = this.readerLocalSearch(searchParams, crawlOpts, crawlerOptions);
            localResultsPromise = localSearchIterator.next().then((r) => r.value!);
            results = await localResultsPromise || [];
            it = localSearchIterator;
        } else if (variant === 'web' && !crawlerOptions.noCache) {
            const cachedSearchIterator = this.cachedSearch(searchParams, crawlOpts, crawlerOptions);
            localSearchIterator = this.readerLocalSearch(searchParams, crawlOpts, crawlerOptions);
            let raceIsOver = false;
            if (timeoutMs <= 5000) {
                localResultsPromise = localSearchIterator.next().then((r) => r.value!);
                isDelayDemanding = true;
                this.logger.debug(`Preparing local cache search`, { timeoutMs });
            } else {
                localResultsPromise = delay(timeoutMs - 5000).then(() => {
                    if (raceIsOver) {
                        localSearchIterator?.return();
                        return;
                    }
                    this.logger.debug(`Preparing local cache search`, { timeoutMs });
                    return localSearchIterator!.next();
                }).then((r) => r?.value || undefined);
            }
            const liveResults = cachedSearchIterator.next().then((r) => r.value!);
            const t0 = performance.now();
            const r = await Promise.race([
                delay(timeoutMs)
                    .then(() => localResultsPromise)
                    .then((r) => ({ results: r, it: localSearchIterator! }))
                    .catch((err) => {
                        this.logger.warn(`Error happened during consumption of local search generator`, { err });
                        return liveResults.then((r) => ({ results: r, it: cachedSearchIterator }));
                    }),
                liveResults.then((r) => ({ results: r, it: cachedSearchIterator }))
            ]).finally(() => raceIsOver = true);

            it = r.it;
            const dt = performance.now() - t0;
            if (it === localSearchIterator) {
                this.logger.debug(`Local search won the race after ${dt.toFixed(1)}ms`, { timeoutMs });
                delete crawlerOptions.timeout;
                delete crawlOpts.timeoutMs;
                consumeAsyncGenerator(cachedSearchIterator).catch((err) => {
                    this.logger.warn(`Error happened during consumption of live search generator`, { err });
                });
            } else {
                this.logger.debug(`Cached search won the race after ${dt.toFixed(1)}ms`, { timeoutMs });
            }
            results = r.results || [];
        } else {
            it = this.cachedSearch(searchParams, crawlOpts, crawlerOptions);
            results = (await it.next()).value;
        }

        if (!results?.length && fallback) {
            this.logger.debug(`No results found, falling back to local search`, { searchQuery, timeoutMs });
            const localResults = await localResultsPromise;
            if (localResults?.length) {
                results = localResults;
                it = localSearchIterator!;
                this.logger.debug(`Fallback to local search results`, { resultsNum: results.length, searchQuery });
            }
        }

        if (!results?.length) {
            throw new AssertionFailureError(`No search results available for query ${searchQuery}`);
        }

        let lastScrapped: any[] | undefined;


        if (!crawlerOptions.respondWith.includes('no-content') &&
            ['html', 'text', 'shot', 'markdown', 'content'].some((x) => crawlerOptions.respondWith.includes(x))
        ) {
            for (const x of results) {
                x.content ??= '';
            }
        }

        if (crawlWithoutContent || count === 0) {
            if (localSearchIterator) {
                localSearchIterator.return();
            }
            delete crawlerOptions.timeout;
            delete crawlOpts.timeoutMs;

            if (isDelayDemanding) {
                consumeAsyncGenerator(it);
            } else {
                it.return();
            }

            it = toAsyncGenerator(results);
        } else if (localSearchIterator && it !== localSearchIterator && (!page || page <= 1)) {
            const dt = performance.now() - t0;
            it = raceAsyncGenerators(it, delayGenerator(timeoutMs - dt, localSearchIterator));
        } else {
            const dt = performance.now() - t0;
            it = raceAsyncGenerators(it, timeoutGenerator(Math.max(timeoutMs - dt, 2000)));
        }

        if (!ctx.accepts('text/plain') && ctx.accepts('text/event-stream')) {
            const sseStream = new OutputServerEventStream();
            rpcReflect.return(sseStream);
            try {
                for await (const scrapped of it) {
                    if (!scrapped) {
                        continue;
                    }
                    if (rpcReflect.signal.aborted) {
                        break;
                    }

                    chargeAmount = this.assignChargeAmount(scrapped, count, chargeAmountScaler);
                    lastScrapped = scrapped.slice(0, count);

                    sseStream.write({
                        event: 'data',
                        data: scrapped,
                    });
                }
            } catch (err: any) {
                this.logger.error(`Failed to collect search result for query ${searchQuery}`,
                    { err: marshalErrorLike(err) }
                );
                sseStream.write({
                    event: 'error',
                    data: marshalErrorLike(err),
                });
            }

            sseStream.end();

            return sseStream;
        }

        if (!ctx.accepts('text/plain') && (ctx.accepts('text/json') || ctx.accepts('application/json'))) {
            for await (const scrapped of it) {
                lastScrapped = scrapped;
                if (rpcReflect.signal.aborted) {
                    break;
                }

                if (!lastScrapped || !this.searchResultsQualified(lastScrapped, count)) {
                    continue;
                }

                await this.assignGeneralMixin(lastScrapped, count);
                chargeAmount = this.assignChargeAmount(lastScrapped, count, chargeAmountScaler);

                return lastScrapped;
            }

            if (!lastScrapped) {
                throw new AssertionFailureError(`No content available for query ${searchQuery}`);
            }

            await this.assignGeneralMixin(lastScrapped, count);
            chargeAmount = this.assignChargeAmount(lastScrapped, count, chargeAmountScaler);

            return lastScrapped;
        }

        for await (const scrapped of it) {
            lastScrapped = scrapped;
            if (rpcReflect.signal.aborted) {
                break;
            }

            if (!lastScrapped || !this.searchResultsQualified(lastScrapped, count)) {
                continue;
            }

            await this.assignGeneralMixin(lastScrapped, count);
            chargeAmount = this.assignChargeAmount(lastScrapped, count, chargeAmountScaler);

            return assignTransferProtocolMeta(`${lastScrapped}`, { contentType: 'text/plain', envelope: null });
        }

        if (!lastScrapped) {
            throw new AssertionFailureError(`No content available for query ${searchQuery}`);
        }

        await this.assignGeneralMixin(lastScrapped, count);
        chargeAmount = this.assignChargeAmount(lastScrapped, count, chargeAmountScaler);

        return assignTransferProtocolMeta(`${lastScrapped}`, { contentType: 'text/plain', envelope: null });
    }

    async *fetchSearchResults(
        mode: string | 'markdown' | 'html' | 'text' | 'screenshot' | 'favicon' | 'content',
        searchResults?: FormattedPage[],
        options?: ExtraScrappingOptions,
        crawlerOptions?: CrawlerOptions,
        count?: number,
    ) {
        if (!searchResults) {
            return;
        }
        const urls = searchResults.map((x) => new URL(x.url!));

        if (crawlerOptions) {
            let offloaded = false;
            for await (const x of this.offloadScrapMany(urls, crawlerOptions, options)) {
                offloaded = true;
                for (const [i, v] of x.entries()) {
                    if (v) {
                        Object.assign(searchResults[i], v);
                    }
                }
                yield this.reOrganizeSearchResults(searchResults, count);
            }
            if (offloaded) {
                return;
            }
        }

        const snapshotMap = new WeakMap();
        for await (const scrapped of this.crawler.scrapMany(urls, options, crawlerOptions)) {
            const mapped = scrapped.map((x, i) => {
                if (!x) {
                    return {};
                }
                if (snapshotMap.has(x)) {
                    return snapshotMap.get(x);
                }
                return this.snapshotFormatter.formatSnapshot(mode, x, urls[i]).then((r) => {
                    snapshotMap.set(x, r);

                    return r;
                }).catch((err) => {
                    this.logger.error(`Failed to format snapshot for ${urls[i].href}`, { err: marshalErrorLike(err) });

                    return {};
                });
            });

            const resultArray = await Promise.all(mapped) as FormattedPage[];
            for (const [i, v] of resultArray.entries()) {
                if (v) {
                    Object.assign(searchResults[i], v);
                }
            }

            yield this.reOrganizeSearchResults(searchResults, count);
        }
    }

    async *offloadScrapMany(urls: URL[], crawlerOptions: CrawlerOptions, scrappingOptions?: ExtraScrappingOptions) {
        if (!process.env.JINA_CRAWLER_OFFLOAD_ORIGIN) {
            return undefined;
        }
        this.logger.debug(`Offloading ${urls.length} URLs to internal crawler API`, { urls });

        const results = new Array(urls.length);
        let nextDeferred = Defer<any>();
        const abortCtrl = new AbortController();
        const allJobs = urls.map(async (x, i) => {
            try {
                const cacheIt = this.crawler.queryCache(x, this.pageCacheToleranceMs);
                const cacheMeta = await finalYield(cacheIt);
                if (cacheMeta?.isFresh) {
                    const snapshot = cacheMeta.snapshot;
                    const patchedSnapshot = await this.jsdomControl.narrowSnapshot(snapshot, scrappingOptions);
                    if (!patchedSnapshot) {
                        return undefined;
                    }
                    const finalSnapshot = await this.snapshotFormatter.formatSnapshot(
                        crawlerOptions.respondWith,
                        patchedSnapshot,
                        new URL(patchedSnapshot.href)
                    );
                    results[i] = finalSnapshot;
                    return;
                }

                const r = await fetch(`${process.env.JINA_CRAWLER_OFFLOAD_ORIGIN}/`, {
                    method: 'POST',
                    headers: {
                        'Accept': 'text/event-stream',
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        ...crawlerOptions,
                        url: x.href,
                        proxy: 'none',
                    }),
                    signal: abortCtrl.signal,
                });

                if (r.status !== 200) {
                    const err = await r.json();
                    this.logger.warn(`Failed to offload scrap for ${x.href}, status: ${r.status}`, { status: r.status });
                    throw new DownstreamServiceFailureError({
                        message: `Failed to offload scrap for ${x.href}, status: ${r.status}`,
                        cause: err,
                    });
                }

                const streamNormalized = Readable.fromWeb(r.body as any);
                const parsed = streamNormalized.pipe(new InputServerEventStream());
                streamNormalized.on('error', (err) => parsed.destroy(err));
                parsed.on('error', () => 'dont crash anything');

                parsed.on('data', (event) => {
                    if (event.error) {
                        const err = new DownstreamServiceFailureError({
                            message: `Failed to offload scrap for ${x.href}`,
                            cause: event.error,
                        });

                        parsed.destroy(err);
                        return;
                    }
                    if (event.data && typeof event.data === 'object') {
                        results[i] = event.data;
                        nextDeferred.resolve();
                        nextDeferred = Defer<any>();
                    }
                });

                await once(parsed, 'end');
            } catch (err: any) {
                if (err?.name === 'AbortError') {
                    return;
                }
                this.logger.warn(`Failed to offload scrap for ${x.href}`, { err });
            }
        });
        let done;
        Promise.allSettled(allJobs).then(() => {
            done = true;
            nextDeferred.resolve();
        });

        yield results;
        try {
            do {
                const r = await nextDeferred.promise.catch(() => 'dont crash anything');
                if (typeof r === 'string') {
                    continue;
                }
                yield results;
            } while (!done);
            yield results;
        } finally {
            abortCtrl.abort();
            this.logger.debug(`Offloaded scrap for ${urls.length} URLs done`, { urls });
        }

    }

    reOrganizeSearchResults(searchResults: FormattedPage[], count?: number) {
        const targetResultCount = count || this.targetResultCount;
        const [qualifiedPages, unqualifiedPages] = _.partition(searchResults, (x) => this.pageQualified(x));
        const acceptSet = new Set(qualifiedPages);

        const n = targetResultCount - qualifiedPages.length;
        for (const x of unqualifiedPages.slice(0, n >= 0 ? n : 0)) {
            acceptSet.add(x);
        }

        const filtered = searchResults.filter((x) => acceptSet.has(x)).slice(0, targetResultCount);

        const resultArray = filtered;

        resultArray.toString = searchResults.toString;

        return resultArray;
    }

    assignChargeAmount(formatted: FormattedPage[], num: number, scaler: number) {
        let contentCharge = 0;
        for (const x of formatted) {
            const itemAmount = this.crawler.assignChargeAmount(x) || 0;

            if (!itemAmount) {
                continue;
            }

            contentCharge += itemAmount;
        }

        const numCharge = Math.ceil(formatted.length / 10) * 10000 * scaler;

        let final = Math.max(contentCharge, numCharge);

        if (final > 2_000_000) {
            // We decided it's not quite fair to charge above 2M tokens even though the pages contains more.
            final = 2_000_000;
        }

        if (final === numCharge) {
            for (const x of formatted) {
                x.usage = { tokens: Math.ceil(numCharge / formatted.length) };
            }
        }

        const metadata: Record<string, any> = { usage: { tokens: final } };

        assignMeta(formatted, metadata);
        assignTransferProtocolMeta(formatted, { headers: { 'X-Usage-Tokens': final.toString() } });

        return final;
    }

    pageQualified(formattedPage: FormattedPage) {
        return formattedPage.title &&
            formattedPage.content ||
            formattedPage.screenshotUrl ||
            formattedPage.pageshotUrl ||
            formattedPage.text ||
            formattedPage.html;
    }

    searchResultsQualified(results: FormattedPage[], targetResultCount = this.targetResultCount) {
        return _.every(results, (x) => this.pageQualified(x)) && results.length >= targetResultCount;
    }

    async getFavicon(domain: string) {
        const url = `https://www.google.com/s2/favicons?sz=32&domain_url=${domain}`;

        try {
            const response = await fetch(url);
            if (!response.ok) {
                return '';
            }
            const ab = await response.arrayBuffer();
            const buffer = Buffer.from(ab);
            const base64 = buffer.toString('base64');
            return `data:image/png;base64,${base64}`;
        } catch (error: any) {
            this.logger.warn(`Failed to get favicon base64 string`, { err: marshalErrorLike(error) });
            return '';
        }
    }

    * iterProviders(preference?: string) {
        if (preference === 'bing') {
            if (this.envConfig.SERPER_SEARCH_API_KEY) {
                yield this.serperBing;
            }
            yield this.bingSERP;
            return;
        }

        if (preference === 'google') {
            yield this.googleSERP;
            if (this.envConfig.SERPER_SEARCH_API_KEY) {
                yield this.serperGoogle;
            }
            yield this.commonGoogleSerp;

            return;
        }

        if (preference === 'brave') {
            if (this.envConfig.BRAVE_SEARCH_API_KEY) {
                yield this.braveSearch;
            }
            return;
        }

        if (this.envConfig.SERPER_SEARCH_API_KEY) {
            yield this.serperGoogle;
        }
        yield this.googleSERP;
        if (this.envConfig.BRAVE_SEARCH_API_KEY) {
            yield this.braveSearch;
        }
        yield this.bingSERP;
        yield this.commonGoogleSerp;
    }

    async *cachedSearch(query: Record<string, any> & { variant: 'web' | 'news' | 'images'; }, scrappingOptions: ExtraScrappingOptions, crawlerOptions: CrawlerOptions) {
        const queryDigest = objHashMd5B64Of(query);
        const variant = query.variant || 'web';
        const provider = query.provider;
        Reflect.deleteProperty(query, 'provider');
        let cache;
        let results;
        let cacheUsed = false;
        if (!crawlerOptions.noCache) {
            cache = await this.storageLayer.findSERPResult({ queryDigest });
            if (cache) {
                const age = Date.now() - cache.createdAt.valueOf();
                const stale = cache.createdAt.valueOf() < (Date.now() - this.cacheValidMs);
                this.logger.info(`${stale ? 'Stale cache exists' : 'Cache hit'} for search query "${query.q}", normalized digest: ${queryDigest}, ${age}ms old`, {
                    query, digest: queryDigest, age, stale
                });

                if (!stale && Array.isArray(cache.response)) {
                    results = cache.response.filter((x) => x.link).map((x) => this.mapSearchEntryToPartialFormattedPage(x));
                    cacheUsed = true;
                    yield results;
                }
            }
        }

        if (!results) {
            try {
                let r: WebSearchEntry[] | undefined;
                let lastError;
                outerLoop:
                for (const client of this.iterProviders(provider)) {
                    const t0 = Date.now();
                    let func;
                    switch (variant) {
                        case 'images': {
                            func = Reflect.get(client, 'imageSearch');
                            break;
                        }
                        case 'news': {
                            func = Reflect.get(client, 'newsSearch');
                            break;
                        }
                        case 'web':
                        default: {
                            func = Reflect.get(client, 'webSearch');
                            break;
                        }
                    }
                    if (!func) {
                        continue;
                    }
                    try {
                        r = await Reflect.apply(func, client, [query]);
                        const dt = Date.now() - t0;
                        this.logger.info(`Search took ${dt}ms, ${client.constructor.name}(${variant})`, { searchDt: dt, variant, client: client.constructor.name });
                        break outerLoop;
                    } catch (err) {
                        lastError = err;
                        const dt = Date.now() - t0;
                        this.logger.warn(`Failed to do ${variant} search using ${client.constructor.name}`, { err, variant, searchDt: dt, });
                    }
                }

                if (r?.length) {
                    const nowDate = new Date();
                    const record = SERPResult.from({
                        query,
                        queryDigest,
                        response: r,
                        createdAt: nowDate,
                        expireAt: new Date(nowDate.valueOf() + this.cacheRetentionMs)
                    });
                    Reflect.deleteProperty(record, '_id');
                    this.storageLayer.storeSERPResult(record).catch((err) => {
                        this.logger.warn(`Failed to save serp search result`, { err });
                    });
                    if (variant === 'web') {
                        r.map((x) => {
                            this.storageLayer.indexWebSearchEntry(x, {
                                geolocation: query.gl?.toLowerCase(),
                                language: bcp47ToIso639_3(query.hl),
                            }).catch((err) => {
                                this.logger.warn(`Failed to index SERP result`, { err });
                            });
                        });
                    }
                } else if (lastError) {
                    throw lastError;
                } else if (!r) {
                    throw new AssertionFailureError(`No provider can do ${variant} search atm.`);
                }

                results = r.map((x) => this.mapSearchEntryToPartialFormattedPage(x));
                yield results;
            } catch (err: any) {
                if (cache) {
                    this.logger.warn(`Failed to fetch search result, but a stale cache is available. falling back to stale cache`, { err: marshalErrorLike(err) });

                    cacheUsed = true;
                    yield cache.response as any;
                } else {
                    throw err;
                }

            }
        }

        if (cacheUsed && crawlerOptions.respondWith?.includes('no-content')) {
            yield results;
            return;
        }

        yield* this.fetchSearchResults(crawlerOptions.respondWith, results, scrappingOptions,
            CrawlerOptions.from({ ...crawlerOptions, cacheTolerance: crawlerOptions.cacheTolerance ?? this.pageCacheToleranceMs }),
            query.num,
        );
    }

    mapSearchEntryToPartialFormattedPage(input: WebSearchEntry): FormattedPage {
        const whitelistedProps = [
            'imageUrl', 'imageWidth', 'imageHeight', 'source', 'date', 'siteLinks'
        ];
        const result = {
            title: input.title,
            url: input.link,
            description: Reflect.get(input, 'snippet'),
            ..._.pick(input, whitelistedProps),
        };

        return result;
    }

    async assignGeneralMixin(results: FormattedPage[], num?: number) {
        const collectFavicon = this.threadLocal.get('collect-favicon');
        await Promise.allSettled(results.map(async (x) => {
            if (collectFavicon && x.url) {
                const url = new URL(x.url);
                Reflect.set(x, 'favicon', await this.getFavicon(url.origin));
            }
            x.content ??= '';

            Object.setPrototypeOf(x, searchResultProto);

            return x;
        }));
        if (num) {
            results.length = Math.min(results.length, num);
        }
        results.toString = function (this: FormattedPage[]) {
            let r = this.map((x, i) => x ? Reflect.apply(x.toString, x, [i]) : '').join('\n\n').trimEnd() + '\n';

            return r;
        };

        return results;
    }

    async *readerLocalSearch(inputQuery: SerperSearchQueryParams, scrappingOptions: ExtraScrappingOptions, crawlerOptions: CrawlerOptions) {
        const query = parseSearchQuery(inputQuery);
        this.logger.debug(`Running local search`, { inputQuery, query });
        const results = await this.storageLayer.searchLocalIndex(query.query, {
            queryMixins: query.queryMixins,
            num: inputQuery.num,
            lang: bcp47ToIso639_3(inputQuery.hl),
        });

        const mapped = results.map((x) => ({
            title: x.title,
            url: x.url,
            description: x.highlights?.map((x) => x.texts.map((y) => y.value)).flat().join(' ') || x.description,
            date: x.publishedAt ? `${x.publishedAt.toISOString()}` : undefined,
        })) as FormattedPage[];
        this.logger.debug(`Local search returned ${mapped.length} results`, { resultsNum: mapped.length, inputQuery });
        yield mapped;

        this.logger.debug(`Extracting local cache for full-text`, { resultsNum: mapped.length, inputQuery });
        const r = await Promise.allSettled(results.map((x, i) => {
            return this.storageLayer.readFile(`snapshots/${x._id}`).then(async (r) => {
                const snapshot = JSON.parse(r.toString());
                const patchedSnapshot = await this.jsdomControl.narrowSnapshot(snapshot, scrappingOptions);
                if (!patchedSnapshot) {
                    return undefined;
                }
                const finalSnapshot = await this.snapshotFormatter.formatSnapshot(
                    crawlerOptions.respondWith,
                    patchedSnapshot,
                    new URL(patchedSnapshot.href)
                );

                const lite = mapped[i] as any;
                const pageDescription = lite.description?.replaceAll(x.description || '', '') || '';
                finalSnapshot.description = `${x.description ? `${x.description}\n` : ''}${pageDescription}`;
                finalSnapshot.title ??= lite.title;
                // @ts-ignore
                finalSnapshot.source ??= lite.source;
                // @ts-ignore
                finalSnapshot.date ??= lite.date;

                return finalSnapshot;
            });
        }));

        this.logger.debug(`Done extracting reader local cache for full-text`, { resultsNum: mapped.length, inputQuery });

        yield r.map((x) => {
            if (x.status === 'fulfilled') {
                if (!x.value) {
                    return null;
                }
                return x.value;
            }
            this.logger.warn(`Failed to read snapshot`, { err: x.reason });

            return null;
        }).filter(Boolean) as FormattedPage[];
    }
}

const dataItems = [
    { key: 'title', label: 'Title' },
    { key: 'source', label: 'Source' },
    { key: 'url', label: 'URL Source' },
    { key: 'imageUrl', label: 'Image URL' },
    { key: 'description', label: 'Description' },
    { key: 'publishedTime', label: 'Published Time' },
    { key: 'imageWidth', label: 'Image Width' },
    { key: 'imageHeight', label: 'Image Height' },
    { key: 'date', label: 'Date' },
    { key: 'favicon', label: 'Favicon' },
];

const searchResultProto = {
    toString(this: FormattedPage, i?: number) {
        const chunks = [];
        for (const item of dataItems) {
            const v = Reflect.get(this, item.key);
            if (typeof v !== 'undefined') {
                if (i === undefined) {
                    chunks.push(`[${item.label}]: ${v}`);
                } else {
                    chunks.push(`[${i + 1}] ${item.label}: ${v}`);
                }
            }
        }

        const content = this.content || this.text;
        if (content) {
            chunks.push(`\n${content}`);
        }

        if (this.images) {
            const imageSummaryChunks = [`${i === undefined ? '' : `[${i + 1}] `}Images:`];
            for (const [k, v] of Object.entries(this.images)) {
                imageSummaryChunks.push(`- ![${k}](${v})`);
            }
            if (imageSummaryChunks.length === 1) {
                imageSummaryChunks.push('This page does not seem to contain any images.');
            }
            chunks.push(imageSummaryChunks.join('\n'));
        }
        if (this.links) {
            const linkSummaryChunks = [`${i === undefined ? '' : `[${i + 1}] `}Links/Buttons:`];
            if (Array.isArray(this.links)) {
                for (const [k, v] of this.links) {
                    linkSummaryChunks.push(`- [${k}](${v})`);
                }
            } else {
                for (const [k, v] of Object.entries(this.links)) {
                    linkSummaryChunks.push(`- [${k}](${v})`);
                }
            }
            if (linkSummaryChunks.length === 1) {
                linkSummaryChunks.push('This page does not seem to contain any buttons/links.');
            }
            chunks.push(linkSummaryChunks.join('\n'));
        }

        return chunks.join('\n');
    }
};
