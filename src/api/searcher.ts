import { singleton } from 'tsyringe';
import _ from 'lodash';

import {
    assignTransferProtocolMeta, RPCHost, RPCReflection,
    AssertionFailureError,
    RawString,
} from 'civkit/civ-rpc';
import { marshalErrorLike } from 'civkit/lang';
import { objHashMd5B64Of } from 'civkit/hash';

import { RateLimitControl, RateLimitDesc } from '../shared/services/rate-limit';
import { WebSearchApiResponse, SearchResult as WebSearchResult } from '../shared/3rd-party/brave-types';
import { WebSearchQueryParams } from '../shared/3rd-party/brave-search';

import { CrawlerHost, ExtraScrappingOptions } from './crawler';
import { SearchResult } from '../db/searched';
import { JinaEmbeddingsAuthDTO } from '../dto/jina-embeddings-auth';
import { CrawlerOptions } from '../dto/crawler-options';
import { BraveSearchExplicitOperatorsDto, BraveSearchService } from '../services/brave-search';

import { SnapshotFormatter, FormattedPage } from '../services/snapshot-formatter';
import { GlobalLogger } from '../services/logger';
import { AsyncLocalContext } from '../services/async-context';
import { OutputServerEventStream } from '../lib/transform-server-event-stream';
import { Context, Ctx, Method, Param, RPCReflect } from '../services/registry';
import { InsufficientBalanceError } from '../services/errors';


@singleton()
export class SearcherHost extends RPCHost {
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
        protected braveSearchService: BraveSearchService,
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
        @Param('count', { default: 5, validate: (v) => v >= 0 && v <= 10 })
        count: number,
        crawlerOptions: CrawlerOptions,
        braveSearchExplicitOperators: BraveSearchExplicitOperatorsDto,
        @Param('q') q?: string,
    ) {
        const uid = await auth.solveUID();
        let chargeAmount = 0;
        const noSlashPath = decodeURIComponent(ctx.path).slice(1);
        if (!noSlashPath && !q) {
            const index = await this.crawler.getIndex(ctx, auth);
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
        const searchQuery = braveSearchExplicitOperators.addTo(q || noSlashPath);
        const r = await this.cachedWebSearch({
            q: searchQuery,
            count: count ? Math.floor(count + 2) : 20
        }, crawlerOptions.noCache);

        if (!r.web?.results.length) {
            throw new AssertionFailureError(`No search results available for query ${searchQuery}`);
        }

        if (crawlOpts.timeoutMs && crawlOpts.timeoutMs < 30_000) {
            delete crawlOpts.timeoutMs;
        }

        const it = this.fetchSearchResults(crawlerOptions.respondWith, r.web?.results.slice(0, count + 2), crawlOpts,
            CrawlerOptions.from({ ...crawlerOptions, cacheTolerance: crawlerOptions.cacheTolerance ?? this.pageCacheToleranceMs }),
            count,
        );

        if (!ctx.accepts('text/plain') && ctx.accepts('text/event-stream')) {
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
        if (!ctx.accepts('text/plain') && (ctx.accepts('text/json') || ctx.accepts('application/json'))) {
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
        searchResults?: WebSearchResult[],
        options?: ExtraScrappingOptions,
        crawlerOptions?: CrawlerOptions,
        count?: number,
    ) {
        if (!searchResults) {
            return;
        }
        if (count === 0) {
            const resultArray = searchResults.map((upstreamSearchResult, i) => ({
                url: upstreamSearchResult.url,
                title: upstreamSearchResult.title,
                description: upstreamSearchResult.description,
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
        const urls = searchResults.map((x) => new URL(x.url));
        const snapshotMap = new WeakMap();
        for await (const scrapped of this.crawler.scrapMany(urls, options, crawlerOptions)) {
            const mapped = scrapped.map((x, i) => {
                const upstreamSearchResult = searchResults[i];
                if (!x) {
                    return {
                        url: upstreamSearchResult.url,
                        title: upstreamSearchResult.title,
                        description: upstreamSearchResult.description,
                        content: ['html', 'text', 'screenshot'].includes(mode) ? undefined : ''
                    };
                }
                if (snapshotMap.has(x)) {
                    return snapshotMap.get(x);
                }
                return this.snapshotFormatter.formatSnapshot(mode, x, urls[i]).then((r) => {
                    r.title ??= upstreamSearchResult.title;
                    r.description = upstreamSearchResult.description;
                    snapshotMap.set(x, r);

                    return r;
                }).catch((err) => {
                    this.logger.error(`Failed to format snapshot for ${urls[i].href}`, { err: marshalErrorLike(err) });

                    return {
                        url: upstreamSearchResult.url,
                        title: upstreamSearchResult.title,
                        description: upstreamSearchResult.description,
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
