import { singleton } from 'tsyringe';
import {
    assignTransferProtocolMeta, RPCHost, RPCReflection, AssertionFailureError, assignMeta, RawString,
} from 'civkit/civ-rpc';
import { marshalErrorLike } from 'civkit/lang';
import { objHashMd5B64Of } from 'civkit/hash';
import _ from 'lodash';

import { RateLimitControl, RateLimitDesc } from '../shared/services/rate-limit';

import { CrawlerHost, ExtraScrappingOptions } from './crawler';
import { SerperSearchResult } from '../db/searched';
import { CrawlerOptions } from '../dto/crawler-options';
import { SnapshotFormatter, FormattedPage as RealFormattedPage } from '../services/snapshot-formatter';
import { GoogleSearchExplicitOperatorsDto, SerperSearchService } from '../services/serper-search';

import { GlobalLogger } from '../services/logger';
import { AsyncLocalContext } from '../services/async-context';
import { Context, Ctx, Method, Param, RPCReflect } from '../services/registry';
import { OutputServerEventStream } from '../lib/transform-server-event-stream';
import { JinaEmbeddingsAuthDTO } from '../dto/jina-embeddings-auth';
import { InsufficientBalanceError } from '../services/errors';
import { SerperSearchQueryParams, SerperSearchResponse, WORLD_COUNTRIES, WORLD_LANGUAGES } from '../shared/3rd-party/serper-search';

const WORLD_COUNTRY_CODES = Object.keys(WORLD_COUNTRIES);

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

    reasonableDelayMs = 15_000;

    targetResultCount = 5;

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
        @Param('num', { validate: (v: number) => v >= 0 && v <= 20 })
        num?: number,
        @Param('gl', { validate: (v: string) => WORLD_COUNTRY_CODES.includes(v) }) gl?: string,
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
        // Return content by default
        const crawlWithoutContent = crawlerOptions.respondWith.includes('no-content');
        const withFavicon = Boolean(ctx.get('X-With-Favicons'));

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

        let fetchNum = count;
        if ((page ?? 1) === 1) {
            fetchNum = count > 10 ? 30 : 20;
        }

        const r = await this.cachedWebSearch({
            q: searchQuery,
            num: fetchNum,
            gl,
            hl,
            location,
            page,
        }, crawlerOptions.noCache);

        if (!r.organic.length) {
            throw new AssertionFailureError(`No search results available for query ${searchQuery}`);
        }

        if (crawlOpts.timeoutMs && crawlOpts.timeoutMs < 30_000) {
            delete crawlOpts.timeoutMs;
        }


        let lastScrapped: any[] | undefined;
        const targetResultCount = crawlWithoutContent ? count : count + 2;
        const organicSearchResults = r.organic.slice(0, targetResultCount);
        if (crawlWithoutContent || count === 0) {
            const fakeResults = await this.fakeResult(crawlerOptions, organicSearchResults, !crawlWithoutContent, withFavicon);
            lastScrapped = fakeResults;
            chargeAmount = this.assignChargeAmount(!crawlWithoutContent ? lastScrapped : [], count);

            this.assignTokenUsage(lastScrapped, chargeAmount, crawlWithoutContent);
            if ((!ctx.accepts('text/plain') && (ctx.accepts('text/json') || ctx.accepts('application/json'))) || count === 0) {
                return lastScrapped;
            }
            return assignTransferProtocolMeta(`${lastScrapped}`, { contentType: 'text/plain', envelope: null });
        }

        const it = this.fetchSearchResults(crawlerOptions.respondWith, r.organic.slice(0, targetResultCount), crawlOpts,
            CrawlerOptions.from({ ...crawlerOptions, cacheTolerance: crawlerOptions.cacheTolerance ?? this.pageCacheToleranceMs }),
            count,
            withFavicon
        );

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

                    chargeAmount = this.assignChargeAmount(scrapped, count);
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
                earlyReturnTimer = setTimeout(() => {
                    if (!lastScrapped) {
                        return;
                    }
                    chargeAmount = this.assignChargeAmount(lastScrapped, count);

                    this.assignTokenUsage(lastScrapped, chargeAmount, crawlWithoutContent);
                    rpcReflect.return(lastScrapped);
                    earlyReturn = true;
                }, ((crawlerOptions.timeout || 0) * 1000) || this.reasonableDelayMs);
            };

            for await (const scrapped of it) {
                lastScrapped = scrapped;
                if (rpcReflect.signal.aborted) {
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
                chargeAmount = this.assignChargeAmount(scrapped, count);

                this.assignTokenUsage(scrapped, chargeAmount, crawlWithoutContent);
                return scrapped;
            }

            if (earlyReturnTimer) {
                clearTimeout(earlyReturnTimer);
            }

            if (!lastScrapped) {
                throw new AssertionFailureError(`No content available for query ${searchQuery}`);
            }

            if (!earlyReturn) {
                chargeAmount = this.assignChargeAmount(lastScrapped, count);
            }

            this.assignTokenUsage(lastScrapped, chargeAmount, crawlWithoutContent);
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
                chargeAmount = this.assignChargeAmount(lastScrapped, count);
                rpcReflect.return(assignTransferProtocolMeta(`${lastScrapped}`, { contentType: 'text/plain', envelope: null }));
                earlyReturn = true;
            }, ((crawlerOptions.timeout || 0) * 1000) || this.reasonableDelayMs);
        };

        for await (const scrapped of it) {
            lastScrapped = scrapped;
            if (rpcReflect.signal.aborted) {
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

            chargeAmount = this.assignChargeAmount(scrapped, count);

            return assignTransferProtocolMeta(`${scrapped}`, { contentType: 'text/plain', envelope: null });
        }

        if (earlyReturnTimer) {
            clearTimeout(earlyReturnTimer);
        }

        if (!lastScrapped) {
            throw new AssertionFailureError(`No content available for query ${searchQuery}`);
        }

        if (!earlyReturn) {
            chargeAmount = this.assignChargeAmount(lastScrapped, count);
        }

        return assignTransferProtocolMeta(`${lastScrapped}`, { contentType: 'text/plain', envelope: null });
    }

    assignTokenUsage(result: FormattedPage[], chargeAmount: number, crawlWithoutContent: boolean) {
        if (crawlWithoutContent) {
            if (result) {
                result.forEach((x) => {
                    delete x.usage;
                });
            }
        }

        assignMeta(result, { usage: { tokens: chargeAmount } });
    }

    async fakeResult(
        crawlerOptions: CrawlerOptions,
        searchResults?: SerperSearchResponse['organic'],
        withContent: boolean = false,
        withFavicon: boolean = false,
    ) {
        const mode: string | 'markdown' | 'html' | 'text' | 'screenshot' = crawlerOptions.respondWith;

        if (!searchResults) {
            return [];
        }

        const resultArray = await Promise.all(searchResults.map(async (upstreamSearchResult, index) => {
            const result = {
                url: upstreamSearchResult.link,
                title: upstreamSearchResult.title,
                description: upstreamSearchResult.snippet,
                date: upstreamSearchResult.date,
            } as FormattedPage;

            const dataItems = [
                { key: 'title', label: 'Title' },
                { key: 'url', label: 'URL Source' },
                { key: 'description', label: 'Description' },
            ];

            if (upstreamSearchResult.date) {
                dataItems.push({ key: 'date', label: 'Date' });
            }

            if (withContent) {
                result.content = ['html', 'text', 'screenshot'].includes(mode) ? undefined : '';
            }

            if (withFavicon) {
                const url = new URL(upstreamSearchResult.link);
                result.favicon = await this.getFavicon(url.origin);
                dataItems.push({
                    key: 'favicon',
                    label: 'Favicon',
                });
            }

            result.toString = function () {
                const self = this as any;
                return dataItems.map((x) => `[${index + 1}] ${x.label}: ${self[x.key]}`).join('\n') + '\n';
            };
            return result;
        }));

        resultArray.toString = function () {
            return this.map((x, i) => x ? x.toString() : '').join('\n\n').trimEnd() + '\n';
        };

        return resultArray;
    }

    async *fetchSearchResults(
        mode: string | 'markdown' | 'html' | 'text' | 'screenshot' | 'favicon' | 'content',
        searchResults?: SerperSearchResponse['organic'],
        options?: ExtraScrappingOptions,
        crawlerOptions?: CrawlerOptions,
        count?: number,
        withFavicon?: boolean,
    ) {
        if (!searchResults) {
            return;
        }
        const urls = searchResults.map((x) => new URL(x.link));
        const snapshotMap = new WeakMap();
        for await (const scrapped of this.crawler.scrapMany(urls, options, crawlerOptions)) {
            const mapped = scrapped.map((x, i) => {
                const upstreamSearchResult = searchResults[i];
                const url = upstreamSearchResult.link;

                if (!x) {
                    return {
                        url,
                        title: upstreamSearchResult.title,
                        description: upstreamSearchResult.snippet,
                        date: upstreamSearchResult.date,
                        content: ['html', 'text', 'screenshot'].includes(mode) ? undefined : ''
                    };
                }
                if (snapshotMap.has(x)) {
                    return snapshotMap.get(x);
                }
                return this.crawler.formatSnapshotWithPDFSideLoad(mode, x, urls[i], undefined, options).then((r) => {
                    r.title ??= upstreamSearchResult.title;
                    r.description = upstreamSearchResult.snippet;
                    r.date ??= upstreamSearchResult.date;
                    snapshotMap.set(x, r);

                    return r;
                }).catch((err) => {
                    this.logger.error(`Failed to format snapshot for ${urls[i].href}`, { err: marshalErrorLike(err) });

                    return {
                        url,
                        title: upstreamSearchResult.title,
                        description: upstreamSearchResult.snippet,
                        date: upstreamSearchResult.date,
                        content: x.text,
                    };
                });
            }).map(async (x) => {
                const page = await x;
                if (withFavicon && page.url) {
                    const url = new URL(page.url);
                    page.favicon = await this.getFavicon(url.origin);
                }
                return page;
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
[${i + 1}] Description: ${this.description}${textRep}${this.favicon !== undefined ? `\n[${i + 1}] Favicon: ${this.favicon}` : ''}${this.date ? `\n[${i + 1}] Date: ${this.date}` : ''}
`;
                        }

                        return `[${i + 1}] No content available for ${this.url}${this.favicon !== undefined ? `\n[${i + 1}] Favicon: ${this.favicon}` : ''}`;
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
[${i + 1}] URL Source: ${this.url}${mixins.length ? `\n${mixins.join('\n')}` : ''}${this.favicon !== undefined ? `\n[${i + 1}] Favicon: ${this.favicon}` : ''}${this.date ? `\n[${i + 1}] Date: ${this.date}` : ''}
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

    assignChargeAmount(formatted: FormattedPage[], num: number) {
        const countentCharge = _.sum(
            formatted.map((x) => this.crawler.assignChargeAmount(x) || 0)
        );

        const numCharge = Math.ceil(num / 10) * 10000;

        return Math.max(countentCharge, numCharge);

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
