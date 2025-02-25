import {
    assignTransferProtocolMeta, marshalErrorLike,
    RPCHost, RPCReflection,
    AssertionFailureError,
    objHashMd5B64Of,
} from 'civkit';
import { singleton } from 'tsyringe';
import { AsyncContext, CloudHTTPv2, Ctx, InsufficientBalanceError, Logger, OutputServerEventStream, Param, RPCReflect } from '../shared';
import { RateLimitControl, RateLimitDesc } from '../shared/services/rate-limit';
import _ from 'lodash';
import { Request, Response } from 'express';
import { JinaEmbeddingsAuthDTO } from '../shared/dto/jina-embeddings-auth';
import { CrawlerHost, ExtraScrappingOptions } from './crawler';
import { SerperSearchResult } from '../db/searched';
import { CrawlerOptions } from '../dto/scrapping-options';
import { SnapshotFormatter, FormattedPage } from '../services/snapshot-formatter';
import { GoogleSearchExplicitOperatorsDto, SerperSearchService } from '../services/serper-search';
import { SerperSearchQueryParams, SerperSearchResponse } from '../shared/3rd-party/serper-search';


@singleton()
export class SearcherHost extends RPCHost {
    logger = this.globalLogger.child({ service: this.constructor.name });

    cacheRetentionMs = 1000 * 3600 * 24 * 7;
    cacheValidMs = 1000 * 3600;
    pageCacheToleranceMs = 1000 * 3600 * 24;

    reasonableDelayMs = 15_000;

    targetResultCount = 5;

    constructor(
        protected globalLogger: Logger,
        protected rateLimitControl: RateLimitControl,
        protected threadLocal: AsyncContext,
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

    @CloudHTTPv2({
        name: 'search2',
        runtime: {
            cpu: 4,
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
            memory: '16GiB',
            timeoutSeconds: 300,
            concurrency: 4,
            maxInstances: 200,
            minInstances: 1,
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
        @Param('count', { default: 5, validate: (v) => v >= 0 && v <= 20 })
        count: number,
        crawlerOptions: CrawlerOptions,
        searchExplicitOperators: GoogleSearchExplicitOperatorsDto,
        @Param('q') q?: string,
    ) {
        const uid = await auth.solveUID();
        let chargeAmount = 0;
        const noSlashPath = decodeURIComponent(ctx.req.path).slice(1);
        if (!noSlashPath && !q) {
            const latestUser = uid ? await auth.assertUser() : undefined;
            const index = this.crawler.getIndex(latestUser);
            if (!uid) {
                index.note = 'Authentication is required to use this endpoint. Please provide a valid API key via Authorization header.';
            }
            if (!ctx.req.accepts('text/plain') && (ctx.req.accepts('text/json') || ctx.req.accepts('application/json'))) {

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

        const rateLimitPolicy = auth.getRateLimits(rpcReflect.name.toUpperCase()) || [
            parseInt(user.metadata?.speed_level) >= 2 ?
                RateLimitDesc.from({
                    occurrence: 100,
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

        rpcReflect.finally(() => {
            if (chargeAmount) {
                auth.reportUsage(chargeAmount, `reader-${rpcReflect.name}`).catch((err) => {
                    this.logger.warn(`Unable to report usage for ${uid}`, { err: marshalErrorLike(err) });
                });
                apiRoll.chargeAmount = chargeAmount;
            }
        });

        delete crawlerOptions.html;

        const crawlOpts = await this.crawler.configure(crawlerOptions);
        const searchQuery = searchExplicitOperators.addTo(q || noSlashPath);
        const r = await this.cachedWebSearch({
            q: searchQuery,
            num: count ? (crawlOpts.version === 2 ? count : Math.min(Math.floor(count + 2)), 10) : 10
        }, crawlerOptions.noCache);

        if (!r.organic.length) {
            throw new AssertionFailureError(`No search results available for query ${searchQuery}`);
        }

        if (crawlOpts.timeoutMs && crawlOpts.timeoutMs < 30_000) {
            delete crawlOpts.timeoutMs;
        }

        if (crawlOpts.version === 2) {
            const result = [];
            for (const x of r.organic) {
                const url = new URL(x.link);
                const favicon = await this.getFavicon(url.origin);

                const formatted = await this.snapshotFormatter.formatSnapshot('text', {
                    title: x.title,
                    description: q + x.snippet + x.title + x.link,
                    href: x.link,
                    html: '',
                    text: q + x.snippet + x.title + x.link,
                });

                const tokens = this.assignChargeAmount([formatted]);
                chargeAmount += tokens;

                result.push({
                    url: x.link,
                    title: x.title,
                    snippet: x.snippet,
                    domain: url.origin,
                    favicon: favicon,
                    usage: {
                        tokens
                    }
                });
            }

            return result;
        }

        const it = this.fetchSearchResults(crawlerOptions.respondWith, r.organic.slice(0, count + 2), crawlOpts,
            CrawlerOptions.from({ ...crawlerOptions, cacheTolerance: crawlerOptions.cacheTolerance ?? this.pageCacheToleranceMs }),
            count,
        );

        if (!ctx.req.accepts('text/plain') && ctx.req.accepts('text/event-stream')) {
            const sseStream = new OutputServerEventStream();
            rpcReflect.return(sseStream);

            try {
                for await (const scrapped of it) {
                    if (!scrapped) {
                        continue;
                    }

                    chargeAmount = this.assignChargeAmount(scrapped);
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
            let earlyReturnTimer: ReturnType<typeof setTimeout> | undefined;
            const setEarlyReturnTimer = () => {
                if (earlyReturnTimer) {
                    return;
                }
                earlyReturnTimer = setTimeout(() => {
                    if (!lastScrapped) {
                        return;
                    }
                    chargeAmount = this.assignChargeAmount(lastScrapped);
                    rpcReflect.return(lastScrapped);
                    earlyReturn = true;
                }, ((crawlerOptions.timeout || 0) * 1000) || this.reasonableDelayMs);
            };

            for await (const scrapped of it) {
                lastScrapped = scrapped;
                if (_.some(scrapped, (x) => this.pageQualified(x))) {
                    setEarlyReturnTimer();
                }
                if (!this.searchResultsQualified(scrapped, count)) {
                    continue;
                }
                if (earlyReturnTimer) {
                    clearTimeout(earlyReturnTimer);
                }
                chargeAmount = this.assignChargeAmount(scrapped);

                return scrapped;
            }

            if (earlyReturnTimer) {
                clearTimeout(earlyReturnTimer);
            }

            if (!lastScrapped) {
                throw new AssertionFailureError(`No content available for query ${searchQuery}`);
            }

            if (!earlyReturn) {
                chargeAmount = this.assignChargeAmount(lastScrapped);
            }

            return lastScrapped;
        }

        let earlyReturnTimer: ReturnType<typeof setTimeout> | undefined;
        const setEarlyReturnTimer = () => {
            if (earlyReturnTimer) {
                return;
            }
            earlyReturnTimer = setTimeout(() => {
                if (!lastScrapped) {
                    return;
                }
                chargeAmount = this.assignChargeAmount(lastScrapped);
                rpcReflect.return(assignTransferProtocolMeta(`${lastScrapped}`, { contentType: 'text/plain', envelope: null }));
                earlyReturn = true;
            }, ((crawlerOptions.timeout || 0) * 1000) || this.reasonableDelayMs);
        };

        for await (const scrapped of it) {
            lastScrapped = scrapped;

            if (_.some(scrapped, (x) => this.pageQualified(x))) {
                setEarlyReturnTimer();
            }

            if (!this.searchResultsQualified(scrapped, count)) {
                continue;
            }

            if (earlyReturnTimer) {
                clearTimeout(earlyReturnTimer);
            }

            chargeAmount = this.assignChargeAmount(scrapped);

            return assignTransferProtocolMeta(`${scrapped}`, { contentType: 'text/plain', envelope: null });
        }

        if (earlyReturnTimer) {
            clearTimeout(earlyReturnTimer);
        }

        if (!lastScrapped) {
            throw new AssertionFailureError(`No content available for query ${searchQuery}`);
        }

        if (!earlyReturn) {
            chargeAmount = this.assignChargeAmount(lastScrapped);
        }

        return assignTransferProtocolMeta(`${lastScrapped}`, { contentType: 'text/plain', envelope: null });
    }

    async *fetchSearchResults(
        mode: string | 'markdown' | 'html' | 'text' | 'screenshot',
        searchResults?: SerperSearchResponse['organic'],
        options?: ExtraScrappingOptions,
        crawlerOptions?: CrawlerOptions,
        count?: number,
    ) {
        if (!searchResults) {
            return;
        }
        if (count === 0) {
            const resultArray = searchResults.map((upstreamSearchResult, i) => ({
                url: upstreamSearchResult.link,
                title: upstreamSearchResult.title,
                description: upstreamSearchResult.snippet,
                content: ['html', 'text', 'screenshot'].includes(mode) ? undefined : '',
                toString() {
                    return `[${i + 1}] Title: ${this.title}
[${i + 1}] URL Source: ${this.url}
[${i + 1}] Description: ${this.description}
`;
                }

            })) as FormattedPage[];
            resultArray.toString = function () {
                return this.map((x, i) => x ? x.toString() : '').join('\n\n').trimEnd() + '\n';
            };
            yield resultArray;
            return;
        }
        const urls = searchResults.map((x) => new URL(x.link));
        const snapshotMap = new WeakMap();
        for await (const scrapped of this.crawler.scrapMany(urls, options, crawlerOptions)) {
            const mapped = scrapped.map((x, i) => {
                const upstreamSearchResult = searchResults[i];
                if (!x) {
                    return {
                        url: upstreamSearchResult.link,
                        title: upstreamSearchResult.title,
                        description: upstreamSearchResult.snippet,
                        content: ['html', 'text', 'screenshot'].includes(mode) ? undefined : ''
                    };
                }
                if (snapshotMap.has(x)) {
                    return snapshotMap.get(x);
                }
                return this.snapshotFormatter.formatSnapshot(mode, x, urls[i]).then((r) => {
                    r.title ??= upstreamSearchResult.title;
                    r.description = upstreamSearchResult.snippet;
                    snapshotMap.set(x, r);

                    return r;
                }).catch((err) => {
                    this.logger.error(`Failed to format snapshot for ${urls[i].href}`, { err: marshalErrorLike(err) });

                    return {
                        url: upstreamSearchResult.link,
                        title: upstreamSearchResult.title,
                        description: upstreamSearchResult.snippet,
                        content: x.text,
                    };
                });
            });

            const resultArray = await Promise.all(mapped) as FormattedPage[];

            yield this.reOrganizeSearchResults(resultArray, count);
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

        const resultArray = filtered.map((x, i) => {

            return {
                ...x,
                toString(this: any) {
                    if (!this.content && this.description) {
                        if (this.title || x.textRepresentation) {
                            const textRep = x.textRepresentation ? `\n[${i + 1}] Content: \n${x.textRepresentation}` : '';
                            return `[${i + 1}] Title: ${this.title}
[${i + 1}] URL Source: ${this.url}
[${i + 1}] Description: ${this.description}${textRep}
`;
                        }

                        return `[${i + 1}] No content available for ${this.url}`;
                    }

                    const mixins = [];
                    if (this.description) {
                        mixins.push(`[${i + 1}] Description: ${this.description}`);
                    }
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

    assignChargeAmount(formatted: FormattedPage[]) {
        return _.sum(
            formatted.map((x) => this.crawler.assignChargeAmount(x) || 0)
        );
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

    async getFavicon (domain: string) {
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

    async cachedWebSearch(query: SerperSearchQueryParams, noCache: boolean = false) {
        const queryDigest = objHashMd5B64Of(query);
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
            const r = await this.serperSearchService.webSearch(query);

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
}
