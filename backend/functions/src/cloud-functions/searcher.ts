import {
    assignTransferProtocolMeta, marshalErrorLike,
    RPCHost, RPCReflection,
    AssertionFailureError,
    objHashMd5B64Of,
} from 'civkit';
import { singleton } from 'tsyringe';
import { AsyncContext, CloudHTTPv2, Ctx, InsufficientBalanceError, Logger, OutputServerEventStream, RPCReflect } from '../shared';
import { RateLimitControl, RateLimitDesc } from '../shared/services/rate-limit';
import _ from 'lodash';
import { ScrappingOptions } from '../services/puppeteer';
import { Request, Response } from 'express';
import { JinaEmbeddingsAuthDTO } from '../shared/dto/jina-embeddings-auth';
import { BraveSearchService } from '../services/brave-search';
import { CrawlerHost, FormattedPage } from './crawler';
import { CookieParam } from 'puppeteer';

import { parseString as parseSetCookieString } from 'set-cookie-parser';
import { WebSearchQueryParams } from '../shared/3rd-party/brave-search';
import { SearchResult } from '../db/searched';
import { WebSearchApiResponse, SearchResult as WebSearchResult } from '../shared/3rd-party/brave-types';
import { CrawlerOptions } from '../dto/scrapping-options';


@singleton()
export class SearcherHost extends RPCHost {
    logger = this.globalLogger.child({ service: this.constructor.name });

    cacheRetentionMs = 1000 * 3600 * 24 * 7;
    cacheValidMs = 1000 * 3600;
    pageCacheToleranceMs = 1000 * 3600 * 24;

    reasonableDelayMs = 10_000;

    targetResultCount = 5;

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
            cpu: 4,
            memory: '8GiB',
            timeoutSeconds: 300,
            concurrency: 4,
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
                        description: `Enable automatic alt-text generating for images without an meaningful alt-text.\n\n` +
                            `Note: Does not work when \`X-Respond-With\` is specified`,
                        in: 'header',
                        schema: { type: 'string' }
                    },
                    'X-With-Images-Summary': {
                        description: `Enable dedicated summary section for images on the page.`,
                        in: 'header',
                        schema: { type: 'string' }
                    },
                    'X-With-links-Summary': {
                        description: `Enable dedicated summary section for hyper links on the page.`,
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
        auth: JinaEmbeddingsAuthDTO,
        crawlerOptions: CrawlerOptions,
    ) {
        const uid = await auth.solveUID();
        let chargeAmount = 0;
        const noSlashPath = ctx.req.url.slice(1);
        if (!noSlashPath) {
            const latestUser = uid ? await auth.assertUser() : undefined;
            if (!ctx.req.accepts('text/plain') && (ctx.req.accepts('text/json') || ctx.req.accepts('application/json'))) {

                return this.crawler.getIndex(latestUser);
            }

            return assignTransferProtocolMeta(`${this.crawler.getIndex(latestUser)}`,
                { contentType: 'text/plain', envelope: null }
            );
        }

        if (uid) {
            const user = await auth.assertUser();
            if (!(user.wallet.total_balance > 0)) {
                throw new InsufficientBalanceError(`Account balance not enough to run this query, please recharge.`);
            }

            const rateLimitPolicy = auth.getRateLimits(rpcReflect.name.toUpperCase()) || [RateLimitDesc.from({
                occurrence: 40,
                periodSeconds: 60
            })];

            const apiRoll = await this.rateLimitControl.simpleRPCUidBasedLimit(
                rpcReflect, uid, [rpcReflect.name.toUpperCase()],
                ...rateLimitPolicy
            );

            rpcReflect.finally(() => {
                if (chargeAmount) {
                    auth.reportUsage(chargeAmount, `reader-${rpcReflect.name}`).catch((err) => {
                        this.logger.warn(`Unable to report usage for ${uid}`, { err: marshalErrorLike(err) });
                    });
                    apiRoll.chargeAmount = chargeAmount;
                }
            });
        } else if (ctx.req.ip) {
            this.threadLocal.set('ip', ctx.req.ip);
            const apiRoll = await this.rateLimitControl.simpleRpcIPBasedLimit(rpcReflect, ctx.req.ip, [rpcReflect.name.toUpperCase()],
                [
                    // 5 requests per minute
                    new Date(Date.now() - 60 * 1000), 5
                ]
            );
            rpcReflect.finally(() => {
                if (chargeAmount) {
                    apiRoll.chargeAmount = chargeAmount;
                }
            });
        }

        const crawlOpts = this.crawler.configure(crawlerOptions);
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
        const searchQuery = noSlashPath;
        const r = await this.cachedWebSearch({
            q: searchQuery,
            count: 10
        }, crawlerOptions.noCache);

        if (!r.web?.results.length) {
            throw new AssertionFailureError(`No search results available for query ${searchQuery}`);
        }

        const it = this.fetchSearchResults(crawlerOptions.respondWith, r.web?.results, crawlOpts,
            crawlerOptions.cacheTolerance || this.pageCacheToleranceMs
        );

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

                if (!this.searchResultsQualified(scrapped)) {
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

            if (!this.searchResultsQualified(scrapped)) {
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
        searchResults?: WebSearchResult[],
        options?: ScrappingOptions,
        pageCacheTolerance?: number
    ) {
        if (!searchResults) {
            return;
        }
        const urls = searchResults.map((x) => new URL(x.url));
        for await (const scrapped of this.crawler.scrapMany(urls, options, pageCacheTolerance)) {
            const mapped = scrapped.map((x, i) => {
                const upstreamSearchResult = searchResults[i];
                if (!x || (!x.parsed && mode !== 'markdown')) {
                    return {
                        url: upstreamSearchResult.url,
                        title: upstreamSearchResult.title,
                        description: upstreamSearchResult.description,
                    };
                }
                return this.crawler.formatSnapshot(mode, x, urls[i]);
            });

            const resultArray = await Promise.all(mapped) as FormattedPage[];

            yield this.reOrganizeSearchResults(resultArray);
        }
    }

    reOrganizeSearchResults(searchResults: FormattedPage[]) {
        const [qualifiedPages, unqualifiedPages] = _.partition(searchResults, (x) => this.pageQualified(x));
        const acceptSet = new Set(qualifiedPages);

        const n = this.targetResultCount - qualifiedPages.length;
        for (const x of unqualifiedPages.slice(0, n >= 0 ? n : 0)) {
            acceptSet.add(x);
        }

        const filtered = searchResults.filter((x) => acceptSet.has(x)).slice(0, this.targetResultCount);
        filtered.toString = searchResults.toString;

        const resultArray = filtered.map((x, i) => {

            return {
                ...x,
                toString(this: any) {
                    if (this.description) {
                        if (this.title) {
                            return `[${i + 1}] Title: ${this.title}
[${i + 1}] URL Source: ${this.url}
[${i + 1}] Description: ${this.description}
`;
                        }

                        return `[${i + 1}] No content available for ${this.url}`;
                    }

                    const mixins = [];
                    if (this.publishedTime) {
                        mixins.push(`[${i + 1}] Published Time: ${this.publishedTime}`);
                    }

                    const suffixMixins = [];
                    if (this.images) {
                        const imageSummaryChunks = [`[${i + 1}] Images:`];
                        for (const [k, v] of Object.entries(this.images)) {
                            imageSummaryChunks.push(`- ![${k}](${v})`);
                        }
                        if (imageSummaryChunks.length === 1) {
                            imageSummaryChunks.push('This page does not seem to contain any images.');
                        }
                        suffixMixins.push(imageSummaryChunks.join('\n'));
                    }
                    if (this.links) {
                        const linkSummaryChunks = [`[${i + 1}] Links/Buttons:`];
                        for (const [k, v] of Object.entries(this.links)) {
                            linkSummaryChunks.push(`- [${k}](${v})`);
                        }
                        if (linkSummaryChunks.length === 1) {
                            linkSummaryChunks.push('This page does not seem to contain any buttons/links.');
                        }
                        suffixMixins.push(linkSummaryChunks.join('\n'));
                    }

                    return `[${i + 1}] Title: ${this.title}
[${i + 1}] URL Source: ${this.url}${mixins.length ? `\n${mixins.join('\n')}` : ''}
[${i + 1}] Markdown Content:
${this.content}
${suffixMixins.length ? `\n${suffixMixins.join('\n')}\n` : ''}`;
                }
            };
        });

        resultArray.toString = function () {
            return this.map((x, i) => x ? x.toString() : `[${i + 1}] No content available for ${this[i].url}`).join('\n\n').trimEnd() + '\n';
        };

        return resultArray;
    }

    getChargeAmount(formatted: FormattedPage[]) {
        return _.sum(
            formatted.map((x) => this.crawler.getChargeAmount(x) || 0)
        );
    }

    pageQualified(formattedPage: FormattedPage) {
        return formattedPage.title &&
            formattedPage.content ||
            formattedPage.screenshotUrl ||
            formattedPage.text ||
            formattedPage.html;
    }

    searchResultsQualified(results: FormattedPage[]) {
        return _.every(results, (x) => this.pageQualified(x)) && results.length >= this.targetResultCount;
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

        try {
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
        } catch (err: any) {
            if (cache) {
                this.logger.warn(`Failed to fetch search result, but a stale cache is available. falling back to stale cache`, { err: marshalErrorLike(err) });

                return cache.response as WebSearchApiResponse;
            }

            throw err;
        }

    }
}
