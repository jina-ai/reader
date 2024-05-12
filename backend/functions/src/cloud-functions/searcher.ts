import {
    assignTransferProtocolMeta, marshalErrorLike,
    RPCHost, RPCReflection,
    HashManager,
    AssertionFailureError,
    Defer,
} from 'civkit';
import { singleton } from 'tsyringe';
import { AsyncContext, CloudHTTPv2, Ctx, InsufficientBalanceError, Logger, OutputServerEventStream, RPCReflect } from '../shared';
import { RateLimitControl } from '../shared/services/rate-limit';
import _ from 'lodash';
import { PageSnapshot, ScrappingOptions } from '../services/puppeteer';
import { Request, Response } from 'express';
import { JinaEmbeddingsAuthDTO } from '../shared/dto/jina-embeddings-auth';
import { BraveSearchService } from '../services/brave-search';
import { CrawlerHost } from './crawler';
import { CookieParam } from 'puppeteer';

import { parseString as parseSetCookieString } from 'set-cookie-parser';


const md5Hasher = new HashManager('md5', 'hex');

@singleton()
export class SearcherHost extends RPCHost {
    logger = this.globalLogger.child({ service: this.constructor.name });

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
            concurrency: 22,
            maxInstances: 455,
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

            return assignTransferProtocolMeta(`[Usage] https://s.jina.ai/YOUR_URL
[Homepage] https://jina.ai/reader
[Source code] https://github.com/jina-ai/reader
${authMixin}`,
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
                    // 1000 requests per minute
                    new Date(Date.now() - 60 * 1000), 1000
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
            await this.rateLimitControl.simpleRpcIPBasedLimit(rpcReflect, ctx.req.ip, ['CRAWL'],
                [
                    // 100 requests per minute
                    new Date(Date.now() - 60 * 1000), 100
                ]
            );
        }

        const customMode = ctx.req.get('x-respond-with') || 'default';
        const withGeneratedAlt = Boolean(ctx.req.get('x-with-generated-alt'));
        const noCache = Boolean(ctx.req.get('x-no-cache'));
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
        const r = await this.braveSearchService.webSearch({
            q: searchQuery,
            count: 5
        });

        const urls = r.web.results.map((x) => new URL(x.url));
        this.scrapMany(urls);

        if (!ctx.req.accepts('text/plain') && ctx.req.accepts('text/event-stream')) {
            const sseStream = new OutputServerEventStream();
            rpcReflect.return(sseStream);

            try {
                for await (const scrapped of this.scrapMany(urls, crawlOpts, noCache)) {
                    if (!scrapped) {
                        continue;
                    }

                    const formatted = await this.formatSnapshot(customMode, scrapped, urlToCrawl);
                    chargeAmount = this.getChargeAmount(formatted);
                    sseStream.write({
                        event: 'data',
                        data: formatted,
                    });
                }
            } catch (err: any) {
                this.logger.error(`Failed to crawl ${urlToCrawl}`, { err: marshalErrorLike(err) });
                sseStream.write({
                    event: 'error',
                    data: marshalErrorLike(err),
                });
            }

            sseStream.end();

            return sseStream;
        }

        let lastScrapped;
        if (!ctx.req.accepts('text/plain') && (ctx.req.accepts('text/json') || ctx.req.accepts('application/json'))) {
            for await (const scrapped of this.fetchSearchResults(customMode, urls, crawlOpts, noCache)) {
                lastScrapped = scrapped;

                if (_.every(scrapped, (x) => (x as any).content || (x as any).screenShotUrl || (x as any).screenshot)) {
                    chargeAmount = _.sum(
                        scrapped.map((x) => this.crawler.getChargeAmount(x) || 0)
                    );

                    return scrapped;
                }

                chargeAmount = _.sum(
                    scrapped.map((x) => this.crawler.getChargeAmount(x) || 0)
                );

                return scrapped;
            }

            if (!lastScrapped) {
                throw new AssertionFailureError(`No content available for URL ${urlToCrawl}`);
            }

            const formatted = await this.formatSnapshot(customMode, lastScrapped, urlToCrawl);
            chargeAmount = this.getChargeAmount(formatted);

            return formatted;
        }

        for await (const scrapped of this.cachedScrap(urlToCrawl, crawlOpts, noCache)) {
            lastScrapped = scrapped;
            if (!scrapped?.parsed?.content || !(scrapped.title?.trim())) {
                continue;
            }

            const formatted = await this.formatSnapshot(customMode, scrapped, urlToCrawl);
            chargeAmount = this.getChargeAmount(formatted);
            if (customMode === 'screenshot' && Reflect.get(formatted, 'screenshotUrl')) {

                return assignTransferProtocolMeta(`${formatted}`,
                    { code: 302, envelope: null, headers: { Location: Reflect.get(formatted, 'screenshotUrl') } }
                );
            }

            return assignTransferProtocolMeta(`${formatted}`, { contentType: 'text/plain', envelope: null });
        }

        if (!lastScrapped) {
            throw new AssertionFailureError(`No content available for URL ${urlToCrawl}`);
        }

        const formatted = await this.formatSnapshot(customMode, lastScrapped, urlToCrawl);
        chargeAmount = this.getChargeAmount(formatted);
        if (customMode === 'screenshot' && Reflect.get(formatted, 'screenshotUrl')) {

            return assignTransferProtocolMeta(`${formatted}`,
                { code: 302, envelope: null, headers: { Location: Reflect.get(formatted, 'screenshotUrl') } }
            );
        }

        return assignTransferProtocolMeta(`${formatted}`, { contentType: 'text/plain', envelope: null });
    }

    async *scrapMany(urls: URL[], options?: ScrappingOptions, noCache = false) {
        const iterators = urls.map((url) => this.crawler.cachedScrap(url, options, noCache));

        const results: (PageSnapshot | undefined)[] = [];
        results.length = iterators.length;

        let nextDeferred = Defer();
        let concluded = false;

        const handler = async (it: AsyncGenerator<PageSnapshot | undefined>, idx: number) => {
            for await (const x of it) {
                results[idx] = x;

                if (x) {
                    nextDeferred.resolve();
                    nextDeferred = Defer();
                }

            }
        };

        Promise.all(
            iterators.map((it, idx) => handler(it, idx))
        ).finally(() => {
            concluded = true;
            nextDeferred.resolve();
        });

        yield results;

        try {
            while (!concluded) {
                await nextDeferred.promise;

                yield results;
            }
        } finally {
            for (const x of iterators) {
                x.return();
            }
        }
    }

    async *fetchSearchResults(mode: string | 'markdown' | 'html' | 'text' | 'screenshot',
        urls: URL[], options?: ScrappingOptions, noCache = false) {
        for await (const scrapped of this.scrapMany(urls, options, noCache)) {
            const mapped = scrapped.map((x, i) => {
                if (!x) {
                    return {
                        url: urls[i].toString(),

                        toString() {
                            return `No content available for ${urls[i]}`;
                        }
                    };
                }
                return this.crawler.formatSnapshot(mode, x, urls[i]);
            });

            yield await Promise.all(mapped);
        }
    }
}
