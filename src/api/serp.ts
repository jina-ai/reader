import { singleton } from 'tsyringe';
import {
    RPCHost, RPCReflection, assignMeta, RawString,
    ParamValidationError,
    assignTransferProtocolMeta,
    AssertionFailureError,
} from 'civkit/civ-rpc';
import { marshalErrorLike } from 'civkit/lang';
import _ from 'lodash';

import { GlobalLogger } from '../services/logger';
import { AsyncLocalContext } from '../services/async-context';
import { Context, Ctx, Method, Param, RPCReflect } from '../services/registry';
import { OutputServerEventStream } from '../lib/transform-server-event-stream';
// import { JinaEmbeddingsAuthDTO } from '../dto/jina-embeddings-auth';
import { WORLD_COUNTRIES, WORLD_LANGUAGES } from '../3rd-party/serper-search';
import { GoogleSERP, GoogleSERPOldFashion } from '../services/serp/google';
import { WebSearchEntry } from '../services/serp/compat';
import { CrawlerOptions } from '../dto/crawler-options';
import { ScrappingOptions } from '../services/serp/puppeteer';
import { objHashMd5B64Of } from 'civkit/hash';
import { SerperBingSearchService, SerperGoogleSearchService } from '../services/serp/serper';
import { CommonGoogleSERP } from '../services/serp/common-serp';
import { BingSERP } from '../services/serp/bing';
import { bcp47ToIso639_3 } from '../utils/languages';
import { StorageLayer } from '../db/noop-storage';
import { BaseAuthDTO } from '../dto/base-auth';
import { SERPResult } from '../db/models';
import { EnvConfig } from '../services/envconfig';

const WORLD_COUNTRY_CODES = Object.keys(WORLD_COUNTRIES).map((x) => x.toLowerCase());

const indexProto = {
    toString: function (): string {
        return _(this)
            .toPairs()
            .map(([k, v]) => k ? `[${_.upperFirst(_.lowerCase(k))}] ${v}` : '')
            .value()
            .join('\n') + '\n';
    }
};

@singleton()
export class SerpHost extends RPCHost {
    logger = this.globalLogger.child({ service: this.constructor.name });

    cacheRetentionMs = 1000 * 3600 * 24 * 7;
    cacheValidMs = 1000 * 3600;
    pageCacheToleranceMs = 1000 * 3600 * 24;

    reasonableDelayMs = 15_000;

    targetResultCount = 5;

    async getIndex(ctx: Context, auth?: BaseAuthDTO) {
        const indexObject: Record<string, string | number | undefined> = Object.create(indexProto);
        Object.assign(indexObject, {
            usage1: 'https://r.jina.ai/YOUR_URL',
            usage2: 'https://s.jina.ai/YOUR_SEARCH_QUERY',
            usage3: `${ctx.origin}/?q=YOUR_SEARCH_QUERY`,
            homepage: 'https://jina.ai/reader',
        });

        if (auth && auth.user) {
            // if (auth instanceof JinaEmbeddingsAuthDTO) {
            //     indexObject[''] = undefined;
            //     indexObject.authenticatedAs = `${auth.user.user_id} (${auth.user.full_name})`;
            //     indexObject.balanceLeft = auth.user.wallet.total_balance;
            // }
        } else {
            indexObject.note = 'Authentication is required to use this endpoint. Please provide a valid API key via Authorization header.';
        }

        return indexObject;
    }

    constructor(
        protected globalLogger: GlobalLogger,
        protected threadLocal: AsyncLocalContext,
        protected envConfig: EnvConfig,
        protected googleSerp: GoogleSERP,
        protected googleSerpOld: GoogleSERPOldFashion,
        protected serperGoogle: SerperGoogleSearchService,
        protected serperBing: SerperBingSearchService,
        protected commonGoogleSerp: CommonGoogleSERP,
        protected bingSERP: BingSERP,
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
        @Ctx() ctx: Context,
        crawlerOptions: CrawlerOptions,
        auth: BaseAuthDTO,
        @Param('type', { type: new Set(['web', 'images', 'news']), default: 'web' })
        variant: 'web' | 'images' | 'news',
        @Param('q') q?: string,
        @Param('provider', { type: new Set(['google', 'bing']) })
        @Param('engine', { type: new Set(['google', 'bing']) })
        searchEngine?: 'google' | 'bing',
        @Param('num', { validate: (v: number) => v >= 0 && v <= 20 })
        num?: number,
        @Param('gl', { validate: (v: string) => WORLD_COUNTRY_CODES.includes(v?.toLowerCase()) }) gl?: string,
        @Param('hl', { validate: (v: string) => WORLD_LANGUAGES.some(l => l.code === v) }) hl?: string,
        @Param('location') location?: string,
        @Param('page') page?: number,
        @Param('fallback') fallback?: boolean,
        @Param('nfpr') nfpr?: boolean,
    ) {
        if (!q) {
            if (ctx.path === '/') {
                const indexObject = await this.getIndex(ctx, auth);
                if (!ctx.accepts('text/plain') && (ctx.accepts('text/json') || ctx.accepts('application/json'))) {
                    return indexObject;
                }

                return assignTransferProtocolMeta(`${indexObject}`,
                    { contentType: 'text/plain; charset=utf-8', envelope: null }
                );
            }
            throw new ParamValidationError({
                path: 'q',
                message: `Required but not provided`
            });
        }

        let chargeAmount = 0;
        const {
            reportOptions,
            reportUsage
        } = await this.storageLayer.rateLimit(ctx, rpcReflect, auth as any);

        rpcReflect.finally(() => {
            reportOptions?.(crawlerOptions.customizedProps());
            reportUsage?.(chargeAmount, 'reader-search');
        });

        let chargeAmountScaler = 1;
        if (searchEngine === 'bing') {
            chargeAmountScaler = 3;
        }
        if (variant !== 'web') {
            chargeAmountScaler = 5;
        }

        let realQuery = q;
        let queryTerms = q.split(/\s+/g).filter((x) => !!x);

        let results = await this.cachedSearch(variant, {
            provider: searchEngine,
            q,
            num,
            gl,
            hl,
            location,
            page,
            nfpr,
        }, crawlerOptions);


        if (fallback && !results?.length && (!page || page === 1)) {
            let tryTimes = 1;
            const containsRTL = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF\u0590-\u05FF\uFB1D-\uFB4F\u0700-\u074F\u0780-\u07BF\u07C0-\u07FF]/.test(q);
            const lastResort = (containsRTL ? queryTerms.slice(queryTerms.length - 2) : queryTerms.slice(0, 2)).join(' ');
            const n = 4;
            let terms: string[] = [];
            while (tryTimes < n) {
                const delta = Math.ceil(queryTerms.length / n) * tryTimes;
                terms = containsRTL ? queryTerms.slice(delta) : queryTerms.slice(0, queryTerms.length - delta);
                const query = terms.join(' ');
                if (!query) {
                    break;
                }
                if (realQuery === query) {
                    continue;
                }
                tryTimes += 1;
                realQuery = query;
                this.logger.info(`Retrying search with fallback query: "${realQuery}"`);
                results = await this.cachedSearch(variant, {
                    provider: searchEngine,
                    q: realQuery,
                    num,
                    gl,
                    // hl,
                    location,
                }, crawlerOptions);
                if (results?.length) {
                    break;
                }
            }

            if (!results?.length && realQuery.length > lastResort.length) {
                realQuery = lastResort;
                this.logger.info(`Retrying search with fallback query: "${realQuery}"`);
                tryTimes += 1;
                results = await this.cachedSearch(variant, {
                    provider: searchEngine,
                    q: realQuery,
                    num,
                    gl,
                    // hl,
                    location,
                }, crawlerOptions);
            }

            chargeAmountScaler *= tryTimes;
        }

        if (!results?.length) {
            results = [];
        }

        const finalResults = results.map((x: any) => this.mapToFinalResults(x));

        await Promise.all(finalResults.map((x: any) => this.assignGeneralMixin(x)));

        chargeAmount = this.assignChargeAmount(finalResults, chargeAmountScaler);
        assignMeta(finalResults, {
            query: realQuery,
            fallback: realQuery === q ? undefined : realQuery,
        });

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
            if (this.envConfig.SERPER_SEARCH_API_KEY) {
                yield this.serperBing;
            }
            yield this.bingSERP;
            return;
        }

        if (preference === 'google') {
            yield this.googleSerp;
            if (this.envConfig.SERPER_SEARCH_API_KEY) {
                yield this.serperGoogle;
            }
            yield this.commonGoogleSerp;

            return;
        }

        if (this.envConfig.SERPER_SEARCH_API_KEY) {
            yield this.serperGoogle;
        }
        yield this.googleSerp;
        yield this.bingSERP;
        yield this.commonGoogleSerp;
    }

    async cachedSearch(variant: 'web' | 'news' | 'images', query: Record<string, any>, opts: CrawlerOptions) {
        const queryDigest = objHashMd5B64Of({ ...query, variant });
        const provider = query.provider;
        Reflect.deleteProperty(query, 'provider');
        const noCache = opts.noCache;
        let cache;
        if (!noCache) {
            cache = await this.storageLayer.findSERPResult({ queryDigest });
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
                    r = await Reflect.apply(func, client, [query, scrappingOptions]);
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
                    this.logger.warn(`Failed to save search result`, { err: marshalErrorLike(err) });
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
