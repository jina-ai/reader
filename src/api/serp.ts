import { singleton } from 'tsyringe';
import {
    RPCHost, RPCReflection, AssertionFailureError, assignMeta, RawString,
} from 'civkit/civ-rpc';
import { marshalErrorLike } from 'civkit/lang';
import _ from 'lodash';

import { RateLimitControl, RateLimitDesc } from '../shared/services/rate-limit';

import { GlobalLogger } from '../services/logger';
import { AsyncLocalContext } from '../services/async-context';
import { Context, Ctx, Method, Param, RPCReflect } from '../services/registry';
import { OutputServerEventStream } from '../lib/transform-server-event-stream';
import { JinaEmbeddingsAuthDTO } from '../dto/jina-embeddings-auth';
import { InsufficientBalanceError } from '../services/errors';
import { SerperSearchQueryParams, WORLD_COUNTRIES, WORLD_LANGUAGES } from '../shared/3rd-party/serper-search';
import { GoogleSERP } from '../services/serp/google';
import { WebSearchEntry } from '../services/serp/compat';

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
    ) {
        super(...arguments);
    }

    override async init() {
        await this.dependencyReady();

        this.emit('ready');
    }

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
        auth: JinaEmbeddingsAuthDTO,
        @Param('q', { required: true }) q: string,
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
    ) {
        const uid = await auth.solveUID();
        // Return content by default
        const user = await auth.assertUser();
        if (!(user.wallet.total_balance > 0)) {
            throw new InsufficientBalanceError(`Account balance not enough to run this query, please recharge.`);
        }

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

        const apiRoll = await this.rateLimitControl.simpleRPCUidBasedLimit(
            rpcReflect, uid!, [rpcReflect.name.toUpperCase()],
            ...rateLimitPolicy
        );
        let chargeAmount = 0;
        rpcReflect.finally(() => {
            if (chargeAmount) {
                auth.reportUsage(chargeAmount, `reader-${rpcReflect.name}`).catch((err) => {
                    this.logger.warn(`Unable to report usage for ${uid}`, { err: marshalErrorLike(err) });
                });
                apiRoll.chargeAmount = chargeAmount;
            }
        });

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
            q,
            num,
            gl,
            hl,
            location,
            page,
        });

        let results: any;
        switch (variant) {
            // case 'images': {
            //     results = (r as SerperImageSearchResponse).images;
            //     break;
            // }
            // case 'news': {
            //     results = (r as SerperNewsSearchResponse).news;
            //     break;
            // }
            // case 'web':
            default: {
                results = r;
                break;
            }
        }

        if (!results?.length) {
            throw new AssertionFailureError(`No search results available for query ${q}`);
        }

        this.assignChargeAmount(results, chargeAmountScaler);

        return results;
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

    async cachedSearch(query: SerperSearchQueryParams & { variant: 'web' | 'images' | 'news'; provider?: string; }, noCache: boolean = false) {
        // const queryDigest = objHashMd5B64Of(query);
        Reflect.deleteProperty(query, 'provider');
        // let cache;
        // if (!noCache) {
        //     cache = (await SerperSearchResult.fromFirestoreQuery(
        //         SerperSearchResult.COLLECTION.where('queryDigest', '==', queryDigest)
        //             .orderBy('createdAt', 'desc')
        //             .limit(1)
        //     ))[0];
        //     if (cache) {
        //         const age = Date.now() - cache.createdAt.valueOf();
        //         const stale = cache.createdAt.valueOf() < (Date.now() - this.cacheValidMs);
        //         this.logger.info(`${stale ? 'Stale cache exists' : 'Cache hit'} for search query "${query.q}", normalized digest: ${queryDigest}, ${age}ms old`, {
        //             query, digest: queryDigest, age, stale
        //         });

        //         if (!stale) {
        //             return cache.response as SerperSearchResponse;
        //         }
        //     }
        // }

        try {
            let r;
            const variant = query.variant;
            Reflect.deleteProperty(query, 'variant');
            switch (variant) {
                // case 'images': {
                //     r = await this.serperSearchService.imageSearch(query);
                //     break;
                // }
                // case 'news': {
                //     r = await this.serperSearchService.newsSearch(query);
                //     break;
                // }
                // case 'web':
                default: {
                    r = await this.googleSerp.webSearch(query);
                    break;
                }
            }

            // const nowDate = new Date();
            // const record = SerperSearchResult.from({
            //     query,
            //     queryDigest,
            //     response: r,
            //     createdAt: nowDate,
            //     expireAt: new Date(nowDate.valueOf() + this.cacheRetentionMs)
            // });
            // SerperSearchResult.save(record.degradeForFireStore()).catch((err) => {
            //     this.logger.warn(`Failed to cache search result`, { err });
            // });

            return r;
        } catch (err: any) {
            // if (cache) {
            //     this.logger.warn(`Failed to fetch search result, but a stale cache is available. falling back to stale cache`, { err: marshalErrorLike(err) });

            //     return cache.response as SerperSearchResponse;
            // }

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
