import {
    assignTransferProtocolMeta, marshalErrorLike,
    RPCHost, RPCReflection,
    AssertionFailureError,
    objHashMd5B64Of,
} from 'civkit';
import { singleton } from 'tsyringe';
import { AsyncContext, CloudHTTPv2, Ctx, InsufficientBalanceError, Logger, OutputServerEventStream, RPCReflect } from '../shared';
import { RateLimitControl } from '../shared/services/rate-limit';
import _ from 'lodash';
import { ScrappingOptions } from '../services/puppeteer';
import { Request, Response } from 'express';
import { JinaEmbeddingsAuthDTO } from '../shared/dto/jina-embeddings-auth';
import { BraveSearchService } from '../services/brave-search';
import { CrawlerHost } from './crawler';
import { CookieParam } from 'puppeteer';

import { parseString as parseSetCookieString } from 'set-cookie-parser';
import { WebSearchQueryParams } from '../shared/3rd-party/brave-search';
import { SearchResult } from '../db/searched';
import { WebSearchApiResponse, SearchResult as WebSearchResult } from '../shared/3rd-party/brave-types';


@singleton()
export class SearcherHost extends RPCHost {
    logger = this.globalLogger.child({ service: this.constructor.name });

    cacheRetentionMs = 1000 * 3600 * 24 * 7;
    cacheValidMs = 1000 * 3600;
    pageCacheToleranceMs = 1000 * 3600 * 24;

    reasonableDelayMs = 10_000;

    constructor(
        protected globalLogger: Logger,
        protected rateLimitControl: RateLimitControl,
        protected threadLocal: AsyncContext,
        protected braveSearchService: BraveSearchService,
        protected crawler: CrawlerHost,
    ) {
        super(...arguments);
    }

    override async init() {
        await this.dependencyReady();

        this.emit('ready');
    }

    @CloudHTTPv2({
        name: 'search2',
        runtime: {
            memory: '4GiB',
            timeoutSeconds: 300,
            concurrency: 4,
        },
        tags: ['Searcher'],
        httpMethod: ['get', 'post'],
        returnType: [String, OutputServerEventStream],
        exposeRoot: true,
    })
    @CloudHTTPv2({
        runtime: {
            memory: '8GiB',
            timeoutSeconds: 300,
            concurrency: 8,
            maxInstances: 200,
        },
        openapi: {
            operation: {
                parameters: {
                    'Accept': {
                        description: `Specifies your preference for the response format. \n\n` +
                            `Supported formats:\n` +
                            `- text/event-stream\n` +
                            `- application/json  or  text/json\n` +
                            `- text/plain`
                        ,
                        in: 'header',
                        schema: { type: 'string' }
                    },
                    'X-No-Cache': {
                        description: `Ignores internal cache if this header is specified with a value.`,
                        in: 'header',
                        schema: { type: 'string' }
                    },
                    'X-Respond-With': {
                        description: `Specifies the (non-default) form factor of the crawled data you prefer. \n\n` +
                            `Supported formats:\n` +
                            `- markdown\n` +
                            `- html\n` +
                            `- text\n` +
                            `- screenshot\n`
                        ,
                        in: 'header',
                        schema: { type: 'string' }
                    },
                    'X-Proxy-Url': {
                        description: `Specifies your custom proxy if you prefer to use one. \n\n` +
                            `Supported protocols:\n` +
                            `- http\n` +
                            `- https\n` +
                            `- socks4\n` +
                            `- socks5\n\n` +
                            `For authentication, https://user:pass@host:port`,
                        in: 'header',
                        schema: { type: 'string' }
                    },
                    'X-Set-Cookie': {
                        description: `Sets cookie(s) to the headless browser for your request. \n\n` +
                            `Syntax is the same with standard Set-Cookie`,
                        in: 'header',
                        schema: { type: 'string' }
                    },
                    'X-With-Generated-Alt': {
                        description: `Enable automatic alt-text generating for images without an meaningful alt-text.`,
                        in: 'header',
                        schema: { type: 'string' }
                    },
                }
            }
        },
        tags: ['Searcher'],
        httpMethod: ['get', 'post'],
        returnType: [String, OutputServerEventStream],
        exposeRoot: true,
    })
    async search(
        @RPCReflect() rpcReflect: RPCReflection,
        @Ctx() ctx: {
            req: Request,
            res: Response,
        },
        auth: JinaEmbeddingsAuthDTO
    ) {
        const uid = await auth.solveUID();
        let chargeAmount = 0;
        const noSlashPath = ctx.req.url.slice(1);
        if (!noSlashPath) {
            const latestUser = uid ? await auth.assertUser() : undefined;
            const authMixin = latestUser ? `
[Authenticated as] ${latestUser.user_id} (${latestUser.full_name})
[Balance left] ${latestUser.wallet.total_balance}
` : '';

            return assignTransferProtocolMeta(`${this.crawler.indexText}${authMixin}`,
                { contentType: 'text/plain', envelope: null }
            );
        }

        if (uid) {
            const user = await auth.assertUser();
            if (!(user.wallet.total_balance > 0)) {
                throw new InsufficientBalanceError(`Account balance not enough to run this query, please recharge.`);
            }

            await this.rateLimitControl.simpleRPCUidBasedLimit(rpcReflect, uid, ['CRAWL'],
                [
                    // 40 requests per minute
                    new Date(Date.now() - 60 * 1000), 40
                ]
            );

            rpcReflect.finally(() => {
                if (chargeAmount) {
                    auth.reportUsage(chargeAmount, 'reader-crawl').catch((err) => {
                        this.logger.warn(`Unable to report usage for ${uid}`, { err: marshalErrorLike(err) });
                    });
                }
            });
        } else if (ctx.req.ip) {
            this.threadLocal.set('ip', ctx.req.ip);
            await this.rateLimitControl.simpleRpcIPBasedLimit(rpcReflect, ctx.req.ip, ['CRAWL'],
                [
                    // 5 requests per minute
                    new Date(Date.now() - 60 * 1000), 5
                ]
            );
        }

        const customMode = ctx.req.get('x-respond-with') || ctx.req.get('x-return-format') || 'default';
        const withGeneratedAlt = Boolean(ctx.req.get('x-with-generated-alt'));
        const noCache = Boolean(ctx.req.get('x-no-cache'));
        let pageCacheTolerance = parseInt(ctx.req.get('x-cache-tolerance') || '') * 1000;
        if (isNaN(pageCacheTolerance)) {
            pageCacheTolerance = this.pageCacheToleranceMs;
            if (noCache) {
                pageCacheTolerance = 0;
            }
        }
        const cookies: CookieParam[] = [];
        const setCookieHeaders = ctx.req.headers['x-set-cookie'];
        if (Array.isArray(setCookieHeaders)) {
            for (const setCookie of setCookieHeaders) {
                cookies.push({
                    ...parseSetCookieString(setCookie, { decodeValues: false }) as CookieParam,
                });
            }
        } else if (setCookieHeaders) {
            cookies.push({
                ...parseSetCookieString(setCookieHeaders, { decodeValues: false }) as CookieParam,
            });
        }
        this.threadLocal.set('withGeneratedAlt', withGeneratedAlt);
        const crawlOpts: ScrappingOptions = {
            proxyUrl: ctx.req.get('x-proxy-url'),
            cookies,
            favorScreenshot: customMode === 'screenshot'
        };

        const searchQuery = noSlashPath;
        const r = await this.cachedWebSearch({
            q: searchQuery,
            count: 5
        }, noCache);

        const it = this.fetchSearchResults(customMode, r.web.results, crawlOpts, pageCacheTolerance);

        if (!ctx.req.accepts('text/plain') && ctx.req.accepts('text/event-stream')) {
            const sseStream = new OutputServerEventStream();
            rpcReflect.return(sseStream);

            try {
                for await (const scrapped of it) {
                    if (!scrapped) {
                        continue;
                    }

                    chargeAmount = this.getChargeAmount(scrapped);
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

        let lastScrapped: any[] | undefined;
        let earlyReturn = false;
        if (!ctx.req.accepts('text/plain') && (ctx.req.accepts('text/json') || ctx.req.accepts('application/json'))) {
            const earlyReturnTimer = setTimeout(() => {
                if (!lastScrapped) {
                    return;
                }
                chargeAmount = this.getChargeAmount(lastScrapped);
                rpcReflect.return(lastScrapped);
                earlyReturn = true;
            }, this.reasonableDelayMs);

            for await (const scrapped of it) {
                lastScrapped = scrapped;

                if (!this.qualified(scrapped)) {
                    continue;
                }
                clearTimeout(earlyReturnTimer);
                chargeAmount = this.getChargeAmount(scrapped);

                return scrapped;
            }

            clearTimeout(earlyReturnTimer);

            if (!lastScrapped) {
                throw new AssertionFailureError(`No content available for query ${searchQuery}`);
            }

            if (!earlyReturn) {
                chargeAmount = this.getChargeAmount(lastScrapped);
            }

            return lastScrapped;
        }

        const earlyReturnTimer = setTimeout(() => {
            if (!lastScrapped) {
                return;
            }
            chargeAmount = this.getChargeAmount(lastScrapped);
            rpcReflect.return(assignTransferProtocolMeta(`${lastScrapped}`, { contentType: 'text/plain', envelope: null }));
            earlyReturn = true;
        }, this.reasonableDelayMs);

        for await (const scrapped of it) {
            lastScrapped = scrapped;

            if (!this.qualified(scrapped)) {
                continue;
            }

            clearTimeout(earlyReturnTimer);
            chargeAmount = this.getChargeAmount(scrapped);

            return assignTransferProtocolMeta(`${scrapped}`, { contentType: 'text/plain', envelope: null });
        }

        clearTimeout(earlyReturnTimer);

        if (!lastScrapped) {
            throw new AssertionFailureError(`No content available for query ${searchQuery}`);
        }

        if (!earlyReturn) {
            chargeAmount = this.getChargeAmount(lastScrapped);
        }


        return assignTransferProtocolMeta(`${lastScrapped}`, { contentType: 'text/plain', envelope: null });
    }

    async *fetchSearchResults(
        mode: string | 'markdown' | 'html' | 'text' | 'screenshot',
        searchResults: WebSearchResult[],
        options?: ScrappingOptions,
        pageCacheTolerance?: number
    ) {
        const urls = searchResults.map((x) => new URL(x.url));
        for await (const scrapped of this.crawler.scrapMany(urls, options, pageCacheTolerance)) {
            const mapped = scrapped.map((x, i) => {
                const upstreamSearchResult = searchResults[i];
                if (!x || (!x.parsed && mode !== 'markdown')) {
                    const p = {
                        toString(this: any) {
                            if (this.title && this.description) {
                                return `[${i + 1}] Title: ${this.title}
[${i + 1}] URL Source: ${this.url}
[${i + 1}] Description: ${this.description}
`;
                            }
                            return `[${i + 1}] No content available for ${this.url}`;
                        }
                    };
                    const r = Object.create(p);
                    r.url = upstreamSearchResult.url;
                    r.title = upstreamSearchResult.title;
                    r.description = upstreamSearchResult.description;

                    return r;
                }
                return this.crawler.formatSnapshot(mode, x, urls[i]);
            });

            const resultArray = await Promise.all(mapped);
            for (const [i, result] of resultArray.entries()) {
                if (result && typeof result === 'object' && Object.hasOwn(result, 'toString')) {
                    result.toString = function (this: any) {
                        const mixins = [];
                        if (this.publishedTime) {
                            mixins.push(`[${i + 1}] Published Time: ${this.publishedTime}`);
                        }

                        return `[${i + 1}] Title: ${this.title}
[${i + 1}] URL Source: ${this.url}${mixins.length ? `\n${mixins.join('\n')}` : ''}
[${i + 1}] Markdown Content:
${this.content}
`;
                    };
                }
            }
            resultArray.toString = function () {
                return this.map((x, i) => x ? x.toString() : `[${i + 1}] No content available for ${urls[i]}`).join('\n\n').trimEnd() + '\n';
            };

            yield resultArray;
        }
    }

    getChargeAmount(formatted: any[]) {
        return _.sum(
            formatted.map((x) => this.crawler.getChargeAmount(x) || 0)
        );
    }

    qualified(scrapped: any[]) {
        return _.every(scrapped, (x) =>
            (x as any)?.title &&
            (
                (x as any).content ||
                (x as any).screenShotUrl ||
                (x as any).screenshot ||
                (x as any).text ||
                (x as any).html
            )
        );
    }

    async cachedWebSearch(query: WebSearchQueryParams, noCache: boolean = false) {
        const queryDigest = objHashMd5B64Of(query);
        let cache;
        if (!noCache) {
            cache = (await SearchResult.fromFirestoreQuery(
                SearchResult.COLLECTION.where('queryDigest', '==', queryDigest)
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
                    return cache.response as WebSearchApiResponse;
                }
            }
        }

        const r = await this.braveSearchService.webSearch(query);

        const nowDate = new Date();
        const record = SearchResult.from({
            query,
            queryDigest,
            response: r,
            createdAt: nowDate,
            expireAt: new Date(nowDate.valueOf() + this.cacheRetentionMs)
        });
        SearchResult.save(record.degradeForFireStore()).catch((err) => {
            this.logger.warn(`Failed to cache search result`, { err });
        });

        return r;
    }
}
