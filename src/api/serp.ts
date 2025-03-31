import { singleton } from 'tsyringe';
import {
    RPCHost, RPCReflection, AssertionFailureError, assignMeta, RawString,
} from 'civkit/civ-rpc';
import { marshalErrorLike } from 'civkit/lang';
import _ from 'lodash';

import { RateLimitControl, RateLimitDesc } from '../shared/services/rate-limit';

import { GlobalLogger } from '../services/logger';
import { AsyncLocalContext } from '../services/async-context';
import { Method, Param, RPCReflect } from '../services/registry';
import { OutputServerEventStream } from '../lib/transform-server-event-stream';
import { JinaEmbeddingsAuthDTO } from '../dto/jina-embeddings-auth';
import { InsufficientBalanceError } from '../services/errors';
import { WORLD_COUNTRIES, WORLD_LANGUAGES } from '../shared/3rd-party/serper-search';
import { GoogleSERP } from '../services/serp/google';
import { WebSearchEntry } from '../services/serp/compat';
import { CrawlerOptions } from '../dto/crawler-options';
import { ScrappingOptions } from '../services/serp/puppeteer';
import { objHashMd5B64Of } from 'civkit/hash';
import { SERPResult } from '../db/searched';
import { SerperBingSearchService, SerperGoogleSearchService } from '../services/serp/serper';

const WORLD_COUNTRY_CODES = Object.keys(WORLD_COUNTRIES).map((x) => x.toLowerCase());

@singleton()
export class SerpHost extends RPCHost {
    logger = this.globalLogger.child({ service: this.constructor.name });

    cacheRetentionMs = 1000 * 3600 * 24 * 7;
    cacheValidMs = 1000 * 3600;
    pageCacheToleranceMs = 1000 * 3600 * 24;

    reasonableDelayMs = 15_000;

    targetResultCount = 5;

    constructor(
        protected globalLogger: GlobalLogger,
        protected rateLimitControl: RateLimitControl,
        protected threadLocal: AsyncLocalContext,
        protected googleSerp: GoogleSERP,
        protected serperGoogle: SerperGoogleSearchService,
        protected serperBing: SerperBingSearchService,
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
                path: '/'
            }
        },
        tags: ['search'],
        returnType: [String, OutputServerEventStream, RawString],
    })
    @Method({
        ext: {
            http: {
                action: ['get', 'post'],
            }
        },
        tags: ['search'],
        returnType: [String, OutputServerEventStream, RawString],
    })
    async search(
        @RPCReflect() rpcReflect: RPCReflection,
        crawlerOptions: CrawlerOptions,
        auth: JinaEmbeddingsAuthDTO,
        @Param('q', { required: true }) q: string,
        @Param('type', { type: new Set(['web', 'images', 'news']), default: 'web' })
        variant: 'web' | 'images' | 'news',
        @Param('provider', { type: new Set(['google', 'bing']) })
        searchEngine?: 'google' | 'bing',
        @Param('num', { validate: (v: number) => v >= 0 && v <= 20 })
        num?: number,
        @Param('gl', { validate: (v: string) => WORLD_COUNTRY_CODES.includes(v?.toLowerCase()) }) gl?: string,
        @Param('hl', { validate: (v: string) => WORLD_LANGUAGES.some(l => l.code === v) }) hl?: string,
        @Param('location') location?: string,
        @Param('page') page?: number,
    ) {
        const uid = await auth.solveUID();
        // Return content by default
        const user = await auth.assertUser();
        if (!(user.wallet.total_balance > 0)) {
            throw new InsufficientBalanceError(`Account balance not enough to run this query, please recharge.`);
        }

        const rateLimitPolicy = auth.getRateLimits('SERP') || [
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

        const apiRoll = await this.rateLimitControl.simpleRPCUidBasedLimit(
            rpcReflect, uid!, [rpcReflect.name.toUpperCase()],
            ...rateLimitPolicy
        );
        let chargeAmount = 0;
        rpcReflect.finally(() => {
            if (chargeAmount) {
                auth.reportUsage(chargeAmount, `reader-serp`).catch((err) => {
                    this.logger.warn(`Unable to report usage for ${uid}`, { err: marshalErrorLike(err) });
                });
                apiRoll.chargeAmount = chargeAmount;
            }
        });

        let chargeAmountScaler = 1;
        if (searchEngine === 'bing') {
            chargeAmountScaler = 3;
        }
        if (variant !== 'web') {
            chargeAmountScaler = 5;
        }

        const results = await this.cachedSearch(variant, {
            provider: searchEngine,
            q,
            num,
            gl,
            hl,
            location,
            page,
        }, crawlerOptions);

        if (!results?.length) {
            throw new AssertionFailureError(`No search results available for query ${q}`);
        }

        const finalResults = results.map((x: any) => this.mapToFinalResults(x));

        await Promise.all(finalResults.map((x: any) => this.assignGeneralMixin(x)));

        this.assignChargeAmount(finalResults, chargeAmountScaler);

        return finalResults;
    }


    assignChargeAmount(items: unknown[], scaler: number) {
        const numCharge = Math.ceil(items.length / 10) * 10000 * scaler;
        assignMeta(items, { usage: { tokens: numCharge } });

        return numCharge;
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

    async configure(opts: CrawlerOptions) {
        const crawlOpts: ScrappingOptions = {
            proxyUrl: opts.proxyUrl,
            cookies: opts.setCookies,
            overrideUserAgent: opts.userAgent,
            timeoutMs: opts.timeout ? opts.timeout * 1000 : undefined,
            locale: opts.locale,
            referer: opts.referer,
            viewport: opts.viewport,
            proxyResources: (opts.proxyUrl || opts.proxy?.endsWith('+')) ? true : false,
            allocProxy: opts.proxy?.endsWith('+') ? opts.proxy.slice(0, -1) : opts.proxy,
        };

        if (opts.locale) {
            crawlOpts.extraHeaders ??= {};
            crawlOpts.extraHeaders['Accept-Language'] = opts.locale;
        }

        return crawlOpts;
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

    *iterProviders(preference?: string) {
        if (preference === 'bing') {
            yield this.serperBing;
            yield this.serperGoogle;
            yield this.googleSerp;

            return;
        }

        if (preference === 'google') {
            yield this.googleSerp;
            yield this.googleSerp;
            yield this.serperGoogle;

            return;
        }

        yield this.serperGoogle;
        yield this.googleSerp;
        yield this.googleSerp;
    }

    async cachedSearch(variant: 'web' | 'news' | 'images', query: Record<string, any>, opts: CrawlerOptions) {
        const queryDigest = objHashMd5B64Of({ ...query, variant });
        const provider = query.provider;
        Reflect.deleteProperty(query, 'provider');
        const noCache = opts.noCache;
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
        const scrappingOptions = await this.configure(opts);

        try {
            let r: any[] | undefined;
            let lastError;
            outerLoop:
            for (const client of this.iterProviders(provider)) {
                try {
                    switch (variant) {
                        case 'images': {
                            r = await Reflect.apply(client.imageSearch, client, [query, scrappingOptions]);
                            break outerLoop;
                        }
                        case 'news': {
                            r = await Reflect.apply(client.newsSearch, client, [query, scrappingOptions]);
                            break outerLoop;
                        }
                        case 'web':
                        default: {
                            r = await Reflect.apply(client.webSearch, client, [query, scrappingOptions]);
                            break outerLoop;
                        }
                    }
                } catch (err) {
                    lastError = err;
                    this.logger.warn(`Failed to do ${variant} search using ${client.constructor.name}`, { err });
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
                SERPResult.save(record.degradeForFireStore()).catch((err) => {
                    this.logger.warn(`Failed to cache search result`, { err });
                });
            } else if (lastError) {
                throw lastError;
            }

            return r;
        } catch (err: any) {
            if (cache) {
                this.logger.warn(`Failed to fetch search result, but a stale cache is available. falling back to stale cache`, { err: marshalErrorLike(err) });

                return cache.response as any;
            }

            throw err;
        }
    }

    async assignGeneralMixin(result: Partial<WebSearchEntry>) {
        const collectFavicon = this.threadLocal.get('collect-favicon');

        if (collectFavicon && result.link) {
            const url = new URL(result.link);
            Reflect.set(result, 'favicon', await this.getFavicon(url.origin));
        }
    }
}
