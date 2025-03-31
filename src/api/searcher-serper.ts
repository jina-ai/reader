import { singleton } from 'tsyringe';
import {
    assignTransferProtocolMeta, RPCHost, RPCReflection, AssertionFailureError, assignMeta, RawString,
    AuthenticationFailedError,
} from 'civkit/civ-rpc';
import { marshalErrorLike } from 'civkit/lang';
import { objHashMd5B64Of } from 'civkit/hash';
import _ from 'lodash';

import { RateLimitControl, RateLimitDesc } from '../shared/services/rate-limit';

import { CrawlerHost, ExtraScrappingOptions } from './crawler';
import { SerperSearchResult } from '../db/searched';
import { CrawlerOptions, RESPOND_TIMING } from '../dto/crawler-options';
import { SnapshotFormatter, FormattedPage as RealFormattedPage } from '../services/snapshot-formatter';
import { GoogleSearchExplicitOperatorsDto, SerperSearchService } from '../services/serper-search';

import { GlobalLogger } from '../services/logger';
import { AsyncLocalContext } from '../services/async-context';
import { Context, Ctx, Method, Param, RPCReflect } from '../services/registry';
import { OutputServerEventStream } from '../lib/transform-server-event-stream';
import { JinaEmbeddingsAuthDTO } from '../dto/jina-embeddings-auth';
import { InsufficientBalanceError } from '../services/errors';
import { SerperImageSearchResponse, SerperNewsSearchResponse, SerperSearchQueryParams, SerperSearchResponse, SerperWebSearchResponse, WORLD_COUNTRIES, WORLD_LANGUAGES } from '../shared/3rd-party/serper-search';
import { toAsyncGenerator } from '../utils/misc';
import { LRUCache } from 'lru-cache';
import { JinaEmbeddingsTokenAccount } from '../shared/db/jina-embeddings-token-account';

const WORLD_COUNTRY_CODES = Object.keys(WORLD_COUNTRIES).map((x) => x.toLowerCase());

interface FormattedPage extends RealFormattedPage {
    favicon?: string;
    date?: string;
}

type RateLimitCache = {
    error?: Error;
    timeout?: NodeJS.Timeout;
    banned: boolean;
};

@singleton()
export class SearcherHost extends RPCHost {
    logger = this.globalLogger.child({ service: this.constructor.name });

    cacheRetentionMs = 1000 * 3600 * 24 * 7;
    cacheValidMs = 1000 * 3600;
    pageCacheToleranceMs = 1000 * 3600 * 24;

    reasonableDelayMs = 15_000;

    targetResultCount = 5;

    rateLimitCache = new LRUCache<{}, RateLimitCache>({
        max: 256,
        ttl: 60 * 60 * 1000,
        updateAgeOnGet: false,
        updateAgeOnHas: false,
    });

    userCache = new LRUCache<{}, JinaEmbeddingsTokenAccount>({
        max: 256,
        ttl: 60 * 60 * 1000,
        updateAgeOnGet: false,
        updateAgeOnHas: false,
    });

    constructor(
        protected globalLogger: GlobalLogger,
        protected rateLimitControl: RateLimitControl,
        protected threadLocal: AsyncLocalContext,
        protected serperSearchService: SerperSearchService,
        protected crawler: CrawlerHost,
        protected snapshotFormatter: SnapshotFormatter,
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
        @Param('q') q?: string,
    ) {
        // We want to make our search API follow SERP schema, so we need to expose 'num' parameter.
        // Since we used 'count' as 'num' previously, we need to keep 'count' for old users.
        // Here we combine 'count' and 'num' to 'count' for the rest of the function.
        count = (num !== undefined ? num : count) ?? 10;

        const uid = await auth.solveUID();
        const authToken = auth.bearerToken;
        // Return content by default
        const crawlWithoutContent = crawlerOptions.respondWith.includes('no-content');
        const withFavicon = Boolean(ctx.get('X-With-Favicons'));
        this.threadLocal.set('collect-favicon', withFavicon);
        crawlerOptions.respondTiming ??= RESPOND_TIMING.VISIBLE_CONTENT;

        const rpcReflectPayload = {
            chargeAmount: 0
        };

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

        if (!authToken) {
            throw new AuthenticationFailedError({
                message: 'Invalid API key, please get a new one from https://jina.ai'
            });
        }

        let user: JinaEmbeddingsTokenAccount | undefined = this.userCache.get(authToken);
        const userPromise = this.assertUser(auth);
        if (!user) {
            user = await userPromise;
        } else {
            // resolve uncaught error
            userPromise.catch(() => {});
        }

        let rateLimitResult: RateLimitCache | undefined = this.rateLimitCache.get(authToken);
        const rateLimitPromise = this.assertRateLimit(rpcReflect, auth, user, rpcReflectPayload);
        if (rateLimitResult !== undefined) {
            // resolve uncaught error
            rateLimitPromise.catch(() => {});
            // throw rate limit error when cache is error result from last time.
            if (rateLimitResult.error instanceof Error) throw rateLimitResult;
        } else {
            await rateLimitPromise;
        }

        delete crawlerOptions.html;

        const crawlOpts = await this.crawler.configure(crawlerOptions);
        const searchQuery = searchExplicitOperators.addTo(q || noSlashPath);

        let fetchNum = count;
        if ((page ?? 1) === 1) {
            fetchNum = count > 10 ? 30 : 20;
        }

        let chargeAmountScaler = 1;
        if (searchEngine === 'bing') {
            this.threadLocal.set('bing-preferred', true);
            chargeAmountScaler = 3;
        }
        if (variant !== 'web') {
            chargeAmountScaler = 5;
        }

        const r = await this.cachedSearch({
            variant,
            provider: searchEngine,
            q: searchQuery,
            num: fetchNum,
            gl,
            hl,
            location,
            page,
        }, crawlerOptions.noCache);

        let results;
        switch (variant) {
            case 'images': {
                results = (r as SerperImageSearchResponse).images;
                break;
            }
            case 'news': {
                results = (r as SerperNewsSearchResponse).news;
                break;
            }
            case 'web':
            default: {
                results = (r as SerperWebSearchResponse).organic;
                break;
            }
        }

        if (!results.length) {
            throw new AssertionFailureError(`No search results available for query ${searchQuery}`);
        }

        if (crawlOpts.timeoutMs && crawlOpts.timeoutMs < 30_000) {
            delete crawlOpts.timeoutMs;
        }


        let lastScrapped: any[] | undefined;
        const targetResultCount = crawlWithoutContent ? count : count + 2;
        const trimmedResults = results.filter((x) => Boolean(x.link)).slice(0, targetResultCount).map((x) => this.mapToFinalResults(x));
        trimmedResults.toString = function () {
            return this.map((x, i) => x ? Reflect.apply(x.toString, x, [i]) : '').join('\n\n').trimEnd() + '\n';
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

                    rpcReflectPayload.chargeAmount = this.assignChargeAmount(scrapped, count, chargeAmountScaler);
                    lastScrapped = scrapped;
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
                    rpcReflectPayload.chargeAmount = this.assignChargeAmount(lastScrapped, count, chargeAmountScaler);
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
                rpcReflectPayload.chargeAmount = this.assignChargeAmount(scrapped, count, chargeAmountScaler);

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
                rpcReflectPayload.chargeAmount = this.assignChargeAmount(lastScrapped, count, chargeAmountScaler);
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
                rpcReflectPayload.chargeAmount = this.assignChargeAmount(lastScrapped, count, chargeAmountScaler);
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
            rpcReflectPayload.chargeAmount = this.assignChargeAmount(scrapped, count, chargeAmountScaler);

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
            rpcReflectPayload.chargeAmount = this.assignChargeAmount(lastScrapped, count, chargeAmountScaler);
        }

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

        const final = Math.max(contentCharge, numCharge);

        if (final === numCharge) {
            for (const x of formatted) {
                x.usage = { tokens: Math.ceil(numCharge / formatted.length) };
            }
        }


        assignMeta(formatted, { usage: { tokens: final } });

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

    async cachedSearch(query: SerperSearchQueryParams & { variant: 'web' | 'images' | 'news'; provider?: string; }, noCache: boolean = false) {
        const queryDigest = objHashMd5B64Of(query);
        Reflect.deleteProperty(query, 'provider');
        let cache;
        if (!noCache) {
            cache = (await SerperSearchResult.fromFirestoreQuery(
                SerperSearchResult.COLLECTION.where('queryDigest', '==', queryDigest)
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
                    return cache.response as SerperSearchResponse;
                }
            }
        }

        try {
            let r;
            const variant = query.variant;
            Reflect.deleteProperty(query, 'variant');
            switch (variant) {
                case 'images': {
                    r = await this.serperSearchService.imageSearch(query);
                    break;
                }
                case 'news': {
                    r = await this.serperSearchService.newsSearch(query);
                    break;
                }
                case 'web':
                default: {
                    r = await this.serperSearchService.webSearch(query);
                    break;
                }
            }

            const nowDate = new Date();
            const record = SerperSearchResult.from({
                query,
                queryDigest,
                response: r,
                createdAt: nowDate,
                expireAt: new Date(nowDate.valueOf() + this.cacheRetentionMs)
            });
            SerperSearchResult.save(record.degradeForFireStore()).catch((err) => {
                this.logger.warn(`Failed to cache search result`, { err });
            });

            return r;
        } catch (err: any) {
            if (cache) {
                this.logger.warn(`Failed to fetch search result, but a stale cache is available. falling back to stale cache`, { err: marshalErrorLike(err) });

                return cache.response as SerperSearchResponse;
            }

            throw err;
        }

    }

    mapToFinalResults(input:
        | SerperImageSearchResponse['images'][0]
        | SerperWebSearchResponse['organic'][0]
        | SerperNewsSearchResponse['news'][0],
    ) {
        const whitelistedProps = [
            'imageUrl', 'imageWidth', 'imageHeight', 'source', 'date'
        ];
        const result = {
            title: input.title,
            url: input.link,
            description: Reflect.get(input, 'snippet'),
            ..._.pick(input, whitelistedProps),
        } as FormattedPage;

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

    async assertUser(auth: JinaEmbeddingsAuthDTO) {
        let user: JinaEmbeddingsTokenAccount | undefined = undefined;
        try {
            user = await auth.assertUser();
            if (!(user.wallet.total_balance > 0)) {
                throw new InsufficientBalanceError(`Account balance not enough to run this query, please recharge.`);
            }
            this.userCache.set(auth.bearerToken!, user);
            return user;
        } catch (e: any) {
            throw e;
        }
    }

    async assertRateLimit(rpcReflect: RPCReflection, auth: JinaEmbeddingsAuthDTO, user: JinaEmbeddingsTokenAccount, rpcReflectPayload: {chargeAmount: number}) {
        const uid = auth.uid!;
        const rateLimitPolicy = auth.getRateLimits(rpcReflect.name.toUpperCase()) || [
            parseInt(user.metadata?.speed_level) >= 2 ?
                RateLimitDesc.from({
                    occurrence: 400,
                    periodSeconds: 60
                }) :
                RateLimitDesc.from({
                    occurrence: 40,
                    periodSeconds: 60
                })
        ];

        const isBigRateLimit = rateLimitPolicy.some(x => x.occurrence >= 500);
        let cacheValue: RateLimitCache | undefined = undefined;
        try {
            const apiRoll = await this.rateLimitControl.simpleRPCUidBasedLimit(
                rpcReflect, uid, [rpcReflect.name.toUpperCase()],
                ...rateLimitPolicy
            );

            rpcReflect.finally(() => {
                const chargeAmount = rpcReflectPayload.chargeAmount;
                if (chargeAmount) {
                    auth.reportUsage(chargeAmount, `reader-${rpcReflect.name}`).catch((err) => {
                        this.logger.warn(`Unable to report usage for ${uid}`, { err: marshalErrorLike(err) });
                    });
                    apiRoll.chargeAmount = chargeAmount;
                }
            });

            cacheValue = {
                banned: false,
            };
        } catch (e: any) {
            const cache: RateLimitCache | undefined  = this.rateLimitCache.get(auth.bearerToken!);
            if (cache && cache.banned !== false) {
                clearTimeout(cache.timeout);
            }
            cacheValue = {
                error: e,
                timeout: setTimeout(() => {
                    this.rateLimitCache.set(auth.bearerToken!, {banned: false});
                }, e.retryAfter * 1000),
                banned: true,
            };
            throw e;
        } finally {
            if (isBigRateLimit) {
                this.rateLimitCache.set(auth.bearerToken!, cacheValue);
            }
        }
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