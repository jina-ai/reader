import { singleton } from 'tsyringe';
import {
    assignTransferProtocolMeta, RPCHost, RPCReflection, AssertionFailureError, assignMeta, RawString,
} from 'civkit/civ-rpc';
import { marshalErrorLike } from 'civkit/lang';
import { objHashMd5B64Of } from 'civkit/hash';
import _ from 'lodash';

import { RateLimitControl, RateLimitDesc, RateLimitTriggeredError } from '../shared/services/rate-limit';

import { CrawlerHost, ExtraScrappingOptions } from './crawler';
import { CrawlerOptions, RESPOND_TIMING } from '../dto/crawler-options';
import { SnapshotFormatter, FormattedPage as RealFormattedPage } from '../services/snapshot-formatter';
import { GoogleSearchExplicitOperatorsDto } from '../services/serper-search';

import { GlobalLogger } from '../services/logger';
import { AsyncLocalContext } from '../services/async-context';
import { Context, Ctx, Method, Param, RPCReflect } from '../services/registry';
import { OutputServerEventStream } from '../lib/transform-server-event-stream';
import { JinaEmbeddingsAuthDTO } from '../dto/jina-embeddings-auth';
import { InsufficientBalanceError } from '../services/errors';

import { SerperBingSearchService, SerperGoogleSearchService } from '../services/serp/serper';
import { toAsyncGenerator } from '../utils/misc';
import type { JinaEmbeddingsTokenAccount } from '../shared/db/jina-embeddings-token-account';
import { LRUCache } from 'lru-cache';
import { API_CALL_STATUS } from '../shared/db/api-roll';
import { SERPResult } from '../db/searched';
import { SerperSearchQueryParams, WORLD_COUNTRIES, WORLD_LANGUAGES } from '../shared/3rd-party/serper-search';
import { WebSearchEntry } from '../services/serp/compat';
import { CommonGoogleSERP } from '../services/serp/common-serp';
import { GoogleSERP, GoogleSERPOldFashion } from '../services/serp/google';
import { InternalJinaSerpService } from '../services/serp/internal';

const WORLD_COUNTRY_CODES = Object.keys(WORLD_COUNTRIES).map((x) => x.toLowerCase());

interface FormattedPage extends RealFormattedPage {
    favicon?: string;
    date?: string;
}

type RateLimitCache = {
    blockedUntil?: Date;
    user?: JinaEmbeddingsTokenAccount;
};

@singleton()
export class SearcherHost extends RPCHost {
    logger = this.globalLogger.child({ service: this.constructor.name });

    cacheRetentionMs = 1000 * 3600 * 24 * 7;
    cacheValidMs = 1000 * 3600;
    pageCacheToleranceMs = 1000 * 3600 * 24;

    reasonableDelayMs = 15_000;

    targetResultCount = 5;

    highFreqKeyCache = new LRUCache<string, RateLimitCache>({
        max: 256,
        ttl: 60 * 60 * 1000,
        updateAgeOnGet: false,
        updateAgeOnHas: false,
    });

    batchedCaches: SERPResult[] = [];

    constructor(
        protected globalLogger: GlobalLogger,
        protected rateLimitControl: RateLimitControl,
        protected threadLocal: AsyncLocalContext,
        protected crawler: CrawlerHost,
        protected snapshotFormatter: SnapshotFormatter,
        protected serperGoogle: SerperGoogleSearchService,
        protected serperBing: SerperBingSearchService,
        protected jinaSerp: InternalJinaSerpService,
        protected commonGoogleSerp: CommonGoogleSERP,
        protected googleSERP: GoogleSERP,
        protected googleSERPOld: GoogleSERPOldFashion,
    ) {
        super(...arguments);

        setInterval(() => {
            const thisBatch = this.batchedCaches;
            this.batchedCaches = [];
            if (!thisBatch.length) {
                return;
            }
            const batch = SERPResult.DB.batch();

            for (const x of thisBatch) {
                batch.set(SERPResult.COLLECTION.doc(), x.degradeForFireStore());
            }
            batch.commit()
                .then(() => {
                    this.logger.debug(`Saved ${thisBatch.length} caches by batch`);
                })
                .catch((err) => {
                    this.logger.warn(`Failed to cache search result in batch`, { err });
                });
        }, 1000 * 10 + Math.round(1000 * Math.random())).unref();
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
        auth: JinaEmbeddingsAuthDTO,
        crawlerOptions: CrawlerOptions,
        searchExplicitOperators: GoogleSearchExplicitOperatorsDto,
        @Param('count', { validate: (v: number) => v >= 0 && v <= 20 })
        count: number,
        @Param('type', { type: new Set(['web', 'images', 'news']), default: 'web' })
        variant: 'web' | 'images' | 'news',
        @Param('provider', { type: new Set(['google', 'bing']), default: 'google' })
        searchEngine: 'google' | 'bing',
        @Param('num', { validate: (v: number) => v >= 0 && v <= 20 })
        num?: number,
        @Param('gl', { validate: (v: string) => WORLD_COUNTRY_CODES.includes(v?.toLowerCase()) }) gl?: string,
        @Param('hl', { validate: (v: string) => WORLD_LANGUAGES.some(l => l.code === v) }) hl?: string,
        @Param('location') location?: string,
        @Param('page') page?: number,
        @Param('fallback', { type: Boolean, default: true }) fallback?: boolean,
        @Param('q') q?: string,
    ) {
        // We want to make our search API follow SERP schema, so we need to expose 'num' parameter.
        // Since we used 'count' as 'num' previously, we need to keep 'count' for old users.
        // Here we combine 'count' and 'num' to 'count' for the rest of the function.
        count = (num !== undefined ? num : count) ?? 10;

        const authToken = auth.bearerToken;
        let highFreqKey: RateLimitCache | undefined;
        if (authToken && this.highFreqKeyCache.has(authToken)) {
            highFreqKey = this.highFreqKeyCache.get(authToken)!;
            auth.user = highFreqKey.user;
            auth.uid = highFreqKey.user?.user_id;
        }

        const uid = await auth.solveUID();
        // Return content by default
        const crawlWithoutContent = crawlerOptions.respondWith.includes('no-content');
        const withFavicon = Boolean(ctx.get('X-With-Favicons'));
        this.threadLocal.set('collect-favicon', withFavicon);
        crawlerOptions.respondTiming ??= RESPOND_TIMING.VISIBLE_CONTENT;

        let chargeAmount = 0;
        const noSlashPath = decodeURIComponent(ctx.path).slice(1);
        if (!noSlashPath && !q) {
            const index = await this.crawler.getIndex(auth);
            if (!uid) {
                index.note = 'Authentication is required to use this endpoint. Please provide a valid API key via Authorization header.';
            }
            if (!ctx.accepts('text/plain') && (ctx.accepts('text/json') || ctx.accepts('application/json'))) {

                return index;
            }

            return assignTransferProtocolMeta(`${index}`,
                { contentType: 'text/plain', envelope: null }
            );
        }

        const user = await auth.assertUser();
        if (!(user.wallet.total_balance > 0)) {
            throw new InsufficientBalanceError(`Account balance not enough to run this query, please recharge.`);
        }

        if (highFreqKey?.blockedUntil) {
            const now = new Date();
            const blockedTimeRemaining = (highFreqKey.blockedUntil.valueOf() - now.valueOf());
            if (blockedTimeRemaining > 0) {
                throw RateLimitTriggeredError.from({
                    message: `Per UID rate limit exceeded (async)`,
                    retryAfter: Math.ceil(blockedTimeRemaining / 1000),
                });
            }
        }

        const rateLimitPolicy = auth.getRateLimits(rpcReflect.name.toUpperCase()) || [
            parseInt(user.metadata?.speed_level) >= 2 ?
                RateLimitDesc.from({
                    occurrence: 1000,
                    periodSeconds: 60
                }) :
                RateLimitDesc.from({
                    occurrence: 100,
                    periodSeconds: 60
                })
        ];

        const apiRollPromise = this.rateLimitControl.simpleRPCUidBasedLimit(
            rpcReflect, uid!, [rpcReflect.name.toUpperCase()],
            ...rateLimitPolicy
        );

        if (!highFreqKey) {
            // Normal path
            await apiRollPromise;

            if (rateLimitPolicy.some(
                (x) => {
                    const rpm = x.occurrence / (x.periodSeconds / 60);
                    if (rpm >= 400) {
                        return true;
                    }

                    return false;
                })
            ) {
                this.highFreqKeyCache.set(auth.bearerToken!, {
                    user,
                });
            }

        } else {
            // High freq key path
            apiRollPromise.then(
                // Rate limit not triggered, make sure not blocking.
                () => {
                    delete highFreqKey.blockedUntil;
                },
                // Rate limit triggered
                (err) => {
                    if (!(err instanceof RateLimitTriggeredError)) {
                        return;
                    }
                    const now = Date.now();
                    let tgtDate;
                    if (err.retryAfterDate) {
                        tgtDate = err.retryAfterDate;
                    } else if (err.retryAfter) {
                        tgtDate = new Date(now + err.retryAfter * 1000);
                    }

                    if (tgtDate) {
                        const dt = tgtDate.valueOf() - now;
                        highFreqKey.blockedUntil = tgtDate;
                        setTimeout(() => {
                            if (highFreqKey.blockedUntil === tgtDate) {
                                delete highFreqKey.blockedUntil;
                            }
                        }, dt).unref();
                    }
                }
            ).finally(async () => {
                // Always asynchronously update user(wallet);
                const user = await auth.getBrief().catch(() => undefined);
                if (user) {
                    highFreqKey.user = user;
                }
            });
        }

        rpcReflect.finally(async () => {
            if (chargeAmount) {
                auth.reportUsage(chargeAmount, `reader-${rpcReflect.name}`).catch((err) => {
                    this.logger.warn(`Unable to report usage for ${uid}`, { err: marshalErrorLike(err) });
                });
                try {
                    const apiRoll = await apiRollPromise;
                    apiRoll.chargeAmount = chargeAmount;

                } catch (err) {
                    await this.rateLimitControl.record({
                        uid,
                        tags: [rpcReflect.name.toUpperCase()],
                        status: API_CALL_STATUS.SUCCESS,
                        chargeAmount,
                    }).save().catch((err) => {
                        this.logger.warn(`Failed to save rate limit record`, { err: marshalErrorLike(err) });
                    });
                }
            }
        });

        delete crawlerOptions.html;

        const crawlOpts = await this.crawler.configure(crawlerOptions);
        const searchQuery = searchExplicitOperators.addTo(q || noSlashPath);

        let fetchNum = count;
        if ((page ?? 1) === 1) {
            fetchNum = count > 10 ? 30 : 20;
        }

        let fallbackQuery: string | undefined;
        let chargeAmountScaler = 1;
        if (searchEngine === 'bing') {
            this.threadLocal.set('bing-preferred', true);
            chargeAmountScaler = 3;
        }

        if (variant !== 'web') {
            chargeAmountScaler = 5;
        }

        // Search with fallback logic if enabled
        const searchParams = {
            variant,
            provider: searchEngine,
            q: searchQuery,
            num: fetchNum,
            gl,
            hl,
            location,
            page,
        };

        const { results, query: successQuery, tryTimes } = await this.searchWithFallback(
            searchParams, fallback, crawlerOptions.noCache
        );
        chargeAmountScaler *= tryTimes;

        fallbackQuery = successQuery !== searchQuery ? successQuery : undefined;

        if (!results.length) {
            throw new AssertionFailureError(`No search results available for query ${searchQuery}`);
        }

        if (crawlOpts.timeoutMs && crawlOpts.timeoutMs < 30_000) {
            delete crawlOpts.timeoutMs;
        }


        let lastScrapped: any[] | undefined;
        const targetResultCount = crawlWithoutContent ? count : count + 2;
        const trimmedResults: any[] = results.filter((x) => Boolean(x.link)).slice(0, targetResultCount).map((x) => this.mapToFinalResults(x));
        trimmedResults.toString = function () {
            let r = this.map((x, i) => x ? Reflect.apply(x.toString, x, [i]) : '').join('\n\n').trimEnd() + '\n';
            if (fallbackQuery) {
                r = `Fallback query: ${fallbackQuery}\n\n${r}`;
            }
            return r;
        };
        if (!crawlerOptions.respondWith.includes('no-content') &&
            ['html', 'text', 'shot', 'markdown', 'content'].some((x) => crawlerOptions.respondWith.includes(x))
        ) {
            for (const x of trimmedResults) {
                x.content ??= '';
            }
        }
        const assigningOfGeneralMixins = Promise.allSettled(
            trimmedResults.map((x) => this.assignGeneralMixin(x))
        );

        let it;

        if (crawlWithoutContent || count === 0) {
            it = toAsyncGenerator(trimmedResults);
            await assigningOfGeneralMixins;
        } else {
            it = this.fetchSearchResults(crawlerOptions.respondWith, trimmedResults, crawlOpts,
                CrawlerOptions.from({ ...crawlerOptions, cacheTolerance: crawlerOptions.cacheTolerance ?? this.pageCacheToleranceMs }),
                count,
            );
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

                    chargeAmount = this.assignChargeAmount(scrapped, count, chargeAmountScaler, fallbackQuery);
                    lastScrapped = scrapped;

                    if (fallbackQuery) {
                        sseStream.write({
                            event: 'meta',
                            data: { fallback: fallbackQuery },
                        });
                    }

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

        let earlyReturn = false;
        if (!ctx.accepts('text/plain') && (ctx.accepts('text/json') || ctx.accepts('application/json'))) {
            let earlyReturnTimer: ReturnType<typeof setTimeout> | undefined;
            const setEarlyReturnTimer = () => {
                if (earlyReturnTimer) {
                    return;
                }
                earlyReturnTimer = setTimeout(async () => {
                    if (!lastScrapped) {
                        return;
                    }
                    await assigningOfGeneralMixins;
                    chargeAmount = this.assignChargeAmount(lastScrapped, count, chargeAmountScaler, fallbackQuery);

                    rpcReflect.return(lastScrapped);
                    earlyReturn = true;
                }, ((crawlerOptions.timeout || 0) * 1000) || this.reasonableDelayMs);
            };

            for await (const scrapped of it) {
                lastScrapped = scrapped;
                if (rpcReflect.signal.aborted || earlyReturn) {
                    break;
                }
                if (_.some(scrapped, (x) => this.pageQualified(x))) {
                    setEarlyReturnTimer();
                }
                if (!this.searchResultsQualified(scrapped, count)) {
                    continue;
                }
                if (earlyReturnTimer) {
                    clearTimeout(earlyReturnTimer);
                }
                await assigningOfGeneralMixins;
                chargeAmount = this.assignChargeAmount(scrapped, count, chargeAmountScaler, fallbackQuery);

                return scrapped;
            }

            if (earlyReturnTimer) {
                clearTimeout(earlyReturnTimer);
            }

            if (!lastScrapped) {
                throw new AssertionFailureError(`No content available for query ${searchQuery}`);
            }

            if (!earlyReturn) {
                await assigningOfGeneralMixins;
                chargeAmount = this.assignChargeAmount(lastScrapped, count, chargeAmountScaler, fallbackQuery);
            }

            return lastScrapped;
        }

        let earlyReturnTimer: ReturnType<typeof setTimeout> | undefined;
        const setEarlyReturnTimer = () => {
            if (earlyReturnTimer) {
                return;
            }
            earlyReturnTimer = setTimeout(async () => {
                if (!lastScrapped) {
                    return;
                }
                await assigningOfGeneralMixins;
                chargeAmount = this.assignChargeAmount(lastScrapped, count, chargeAmountScaler, fallbackQuery);

                rpcReflect.return(assignTransferProtocolMeta(`${lastScrapped}`, { contentType: 'text/plain', envelope: null }));
                earlyReturn = true;
            }, ((crawlerOptions.timeout || 0) * 1000) || this.reasonableDelayMs);
        };

        for await (const scrapped of it) {
            lastScrapped = scrapped;
            if (rpcReflect.signal.aborted || earlyReturn) {
                break;
            }
            if (_.some(scrapped, (x) => this.pageQualified(x))) {
                setEarlyReturnTimer();
            }

            if (!this.searchResultsQualified(scrapped, count)) {
                continue;
            }

            if (earlyReturnTimer) {
                clearTimeout(earlyReturnTimer);
            }
            await assigningOfGeneralMixins;
            chargeAmount = this.assignChargeAmount(scrapped, count, chargeAmountScaler, fallbackQuery);

            return assignTransferProtocolMeta(`${scrapped}`, { contentType: 'text/plain', envelope: null });
        }

        if (earlyReturnTimer) {
            clearTimeout(earlyReturnTimer);
        }

        if (!lastScrapped) {
            throw new AssertionFailureError(`No content available for query ${searchQuery}`);
        }

        if (!earlyReturn) {
            await assigningOfGeneralMixins;
            chargeAmount = this.assignChargeAmount(lastScrapped, count, chargeAmountScaler, fallbackQuery);
        }

        return assignTransferProtocolMeta(`${lastScrapped}`, { contentType: 'text/plain', envelope: null });
    }

    /**
     * Search with fallback to progressively shorter queries if no results found
     * @param params Search parameters
     * @param useFallback Whether to use the fallback mechanism
     * @param noCache Whether to bypass cache
     * @returns Search response and the successful query
     */
    async searchWithFallback(
        params: SerperSearchQueryParams & { variant: 'web' | 'images' | 'news'; provider?: string; },
        useFallback: boolean = false,
        noCache: boolean = false
    ) {
        // Try original query first
        const originalQuery = params.q;
        const containsRTL = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF\u0590-\u05FF\uFB1D-\uFB4F\u0700-\u074F\u0780-\u07BF\u07C0-\u07FF]/.test(originalQuery);

        // Extract results based on variant
        let tryTimes = 1;
        const results = await this.cachedSearch(params.variant, params, noCache);
        if (results.length || !useFallback) {
            return { results, query: params.q, tryTimes };
        }

        let queryTerms = originalQuery.split(/\s+/);
        const lastResort = containsRTL ? queryTerms.slice(queryTerms.length - 2) : queryTerms.slice(0, 2);

        this.logger.info(`No results for "${originalQuery}", trying fallback queries`);

        let terms: string[] = [];
        // fallback n times
        const n = 4;

        while (tryTimes < n) {
            const delta = Math.ceil(queryTerms.length / n) * tryTimes;
            terms = containsRTL ? queryTerms.slice(delta) : queryTerms.slice(0, queryTerms.length - delta);
            const query = terms.join(' ');
            if (!query) {
                break;
            }
            tryTimes += 1;
            this.logger.info(`Retrying search with fallback query: "${query}"`);
            const fallbackParams = { ...params, q: query };
            const fallbackResults = await this.cachedSearch(params.variant, fallbackParams, noCache);
            if (fallbackResults.length > 0) {
                return { results: fallbackResults, query: fallbackParams.q, tryTimes };
            }
        }

        if (terms.length > lastResort.length) {
            const query = lastResort.join(' ');
            this.logger.info(`Retrying search with fallback query: "${query}"`);
            const fallbackParams = { ...params, q: query };
            tryTimes += 1;
            const fallbackResults = await this.cachedSearch(params.variant, fallbackParams, noCache);

            if (fallbackResults.length > 0) {
                return { results: fallbackResults, query, tryTimes };
            }
        }

        return { results, query: originalQuery, tryTimes };
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
        const snapshotMap = new WeakMap();
        for await (const scrapped of this.crawler.scrapMany(urls, options, crawlerOptions)) {
            const mapped = scrapped.map((x, i) => {
                if (!x) {
                    return {};
                }
                if (snapshotMap.has(x)) {
                    return snapshotMap.get(x);
                }
                return this.crawler.formatSnapshotWithPDFSideLoad(mode, x, urls[i], undefined, options).then((r) => {
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

    assignChargeAmount(formatted: FormattedPage[], num: number, scaler: number, fallbackQuery?: string) {
        let contentCharge = 0;
        for (const x of formatted) {
            const itemAmount = this.crawler.assignChargeAmount(x) || 0;

            if (!itemAmount) {
                continue;
            }

            contentCharge += itemAmount;
        }

        const numCharge = Math.ceil(formatted.length / 10) * 10000 * scaler;

        const final = Math.max(contentCharge, numCharge);

        if (final === numCharge) {
            for (const x of formatted) {
                x.usage = { tokens: Math.ceil(numCharge / formatted.length) };
            }
        }

        const metadata: Record<string, any> = { usage: { tokens: final } };
        if (fallbackQuery) {
            metadata.fallback = fallbackQuery;
        }

        assignMeta(formatted, metadata);

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

    *iterProviders(preference?: string, _variant?: string) {
        if (preference === 'bing') {
            yield this.serperBing;
            yield this.googleSERP;
            yield this.jinaSerp;
            yield this.serperGoogle;
            yield this.commonGoogleSerp;

            return;
        }

        if (preference === 'google') {
            yield this.googleSERP;
            yield this.jinaSerp;
            yield this.serperGoogle;
            yield this.commonGoogleSerp;
            yield this.googleSERPOld;

            return;
        }

        yield this.googleSERP;
        yield this.jinaSerp;
        yield this.serperGoogle;
        yield this.commonGoogleSerp;
        yield this.googleSERPOld;
    }

    async cachedSearch(variant: 'web' | 'news' | 'images', query: Record<string, any>, noCache?: boolean): Promise<WebSearchEntry[]> {
        const queryDigest = objHashMd5B64Of({ ...query, variant });
        const provider = query.provider;
        Reflect.deleteProperty(query, 'provider');
        let cache;
        if (!noCache) {
            cache = (await SERPResult.fromFirestoreQuery(
                SERPResult.COLLECTION.where('queryDigest', '==', queryDigest)
                    .orderBy('createdAt', 'desc')
                    .limit(1)
            ))[0];
            if (cache) {
                const age = Date.now() - cache.createdAt.valueOf();
                const stale = cache.createdAt.valueOf() < (Date.now() - this.cacheValidMs);
                this.logger.info(`${stale ? 'Stale cache exists' : 'Cache hit'} for search query "${query.q}", normalized digest: ${queryDigest}, ${age}ms old`, {
                    query, digest: queryDigest, age, stale
                });

                if (!stale) {
                    return cache.response as any;
                }
            }
        }

        try {
            let r: any[] | undefined;
            let lastError;
            outerLoop:
            for (const client of this.iterProviders(provider, variant)) {
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

                this.batchedCaches.push(record);
            } else if (lastError) {
                throw lastError;
            } else if (!r) {
                throw new AssertionFailureError(`No provider can do ${variant} search atm.`);
            }

            return r as WebSearchEntry[];
        } catch (err: any) {
            if (cache) {
                this.logger.warn(`Failed to fetch search result, but a stale cache is available. falling back to stale cache`, { err: marshalErrorLike(err) });

                return cache.response as any;
            }

            throw err;
        }
    }

    mapToFinalResults(input: WebSearchEntry) {
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

    async assignGeneralMixin(result: FormattedPage) {
        const collectFavicon = this.threadLocal.get('collect-favicon');

        if (collectFavicon && result.url) {
            const url = new URL(result.url);
            Reflect.set(result, 'favicon', await this.getFavicon(url.origin));
        }

        Object.setPrototypeOf(result, searchResultProto);
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

        if (this.content) {
            chunks.push(`\n${this.content}`);
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
