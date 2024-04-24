import {
    assignTransferProtocolMeta, marshalErrorLike,
    RPCHost, RPCReflection,
    HashManager,
    AssertionFailureError, ParamValidationError,
} from 'civkit';
import { singleton } from 'tsyringe';
import { CloudHTTPv2, Ctx, FirebaseStorageBucketControl, Logger, OutputServerEventStream, RPCReflect } from '../shared';
import _ from 'lodash';
import { PageSnapshot, PuppeteerControl, ScrappingOptions } from '../services/puppeteer';
import { Request, Response } from 'express';
import normalizeUrl from "@esm2cjs/normalize-url";
import { AltTextService } from '../services/alt-text';
import TurndownService from 'turndown';
import { parseString as parseSetCookieString } from 'set-cookie-parser';
import { CookieParam } from 'puppeteer';
import { Crawled } from '../db/crawled';
import { tidyMarkdown } from '../utils/markdown';
import { cleanAttribute } from '../utils/misc';
import { randomUUID } from 'crypto';

const md5Hasher = new HashManager('md5', 'hex');

@singleton()
export class CrawlerHost extends RPCHost {
    logger = this.globalLogger.child({ service: this.constructor.name });

    turnDownPlugins = [require('turndown-plugin-gfm').tables];

    cacheRetentionMs = 1000 * 3600 * 24 * 7;
    cacheValidMs = 1000 * 300;
    urlValidMs = 1000 * 3600 * 4;

    constructor(
        protected globalLogger: Logger,
        protected puppeteerControl: PuppeteerControl,
        protected altTextService: AltTextService,
        protected firebaseObjectStorage: FirebaseStorageBucketControl,
    ) {
        super(...arguments);

        puppeteerControl.on('crawled', async (snapshot: PageSnapshot, options: ScrappingOptions & { url: URL; }) => {
            if (!snapshot.title?.trim()) {
                return;
            }
            if (options.cookies?.length) {
                // Potential privacy issue, dont cache if cookies are used
                return;
            }

            await this.setToCache(options.url, snapshot);
        });
    }

    override async init() {
        await this.dependencyReady();

        this.emit('ready');
    }

    async formatSnapshot(mode: string | 'markdown' | 'html' | 'text' | 'screenshot', snapshot: PageSnapshot & {
        screenshotUrl?: string;
    }, nominalUrl?: URL) {
        if (mode === 'screenshot') {
            if (snapshot.screenshot && !snapshot.screenshotUrl) {
                const fid = `instant-screenshots/${randomUUID()}`;
                await this.firebaseObjectStorage.saveFile(fid, snapshot.screenshot, {
                    metadata: {
                        contentType: 'image/png',
                    }
                });
                snapshot.screenshotUrl = await this.firebaseObjectStorage.signDownloadUrl(fid, Date.now() + this.urlValidMs);
            }

            return {
                screenshotUrl: snapshot.screenshotUrl,
                toString() {
                    return this.screenshotUrl;
                }
            };
        }
        if (mode === 'html') {
            return {
                html: snapshot.html,
                toString() {
                    return this.html;
                }
            };
        }
        if (mode === 'text') {
            return {
                text: snapshot.text,
                toString() {
                    return this.text;
                }
            };
        }

        const toBeTurnedToMd = snapshot.parsed?.content;
        let turnDownService = new TurndownService();
        for (const plugin of this.turnDownPlugins) {
            turnDownService = turnDownService.use(plugin);
        }
        const urlToAltMap: { [k: string]: string | undefined; } = {};
        if (snapshot.imgs?.length) {
            const tasks = (snapshot.imgs || []).map(async (x) => {
                const r = await this.altTextService.getAltText(x).catch((err: any) => {
                    this.logger.warn(`Failed to get alt text for ${x.src}`, { err: marshalErrorLike(err) });
                    return undefined;
                });
                if (r && x.src) {
                    urlToAltMap[x.src.trim()] = r;
                }
            });

            await Promise.all(tasks);
        }
        let imgIdx = 0;
        turnDownService.addRule('img-generated-alt', {
            filter: 'img',
            replacement: (_content, node) => {
                const src = (node.getAttribute('src') || '').trim();
                const alt = cleanAttribute(node.getAttribute('alt'));
                if (!src) {
                    return '';
                }
                const mapped = urlToAltMap[src];
                imgIdx++;
                if (mapped) {
                    return `![Image ${imgIdx}: ${mapped || alt}](${src})`;
                }
                return `![Image ${imgIdx}: ${alt}](${src})`;
            }
        });

        let contentText = '';
        if (toBeTurnedToMd) {
            try {
                contentText = turnDownService.turndown(toBeTurnedToMd).trim();
            } catch (err) {
                this.logger.warn(`Turndown failed to run, retrying without plugins`, { err });
                const vanillaTurnDownService = new TurndownService();
                try {
                    contentText = vanillaTurnDownService.turndown(toBeTurnedToMd).trim();
                } catch (err2) {
                    this.logger.warn(`Turndown failed to run, giving up`, { err: err2 });
                }
            }
        }

        if (!contentText || (contentText.startsWith('<') && contentText.endsWith('>'))) {
            try {
                contentText = turnDownService.turndown(snapshot.html);
            } catch (err) {
                this.logger.warn(`Turndown failed to run, retrying without plugins`, { err });
                const vanillaTurnDownService = new TurndownService();
                try {
                    contentText = vanillaTurnDownService.turndown(snapshot.html);
                } catch (err2) {
                    this.logger.warn(`Turndown failed to run, giving up`, { err: err2 });
                }
            }
        }
        if (!contentText || (contentText.startsWith('<') || contentText.endsWith('>'))) {
            contentText = snapshot.text;
        }

        const cleanText = tidyMarkdown(contentText || '').trim();

        const formatted = {
            title: (snapshot.parsed?.title || snapshot.title || '').trim(),
            url: nominalUrl?.toString() || snapshot.href?.trim(),
            content: cleanText,
            publishedTime: snapshot.parsed?.publishedTime || undefined,

            toString() {
                const mixins = [];
                if (this.publishedTime) {
                    mixins.push(`Published Time: ${this.publishedTime}`);
                }

                return `Title: ${this.title}

URL Source: ${this.url}
${mixins.length ? `\n${mixins.join('\n\n')}\n` : ''}
Markdown Content:
${this.content}
`;
            }
        };

        return formatted;
    }

    @CloudHTTPv2({
        name: 'crawl2',
        runtime: {
            memory: '4GiB',
            timeoutSeconds: 540,
            concurrency: 4,
        },
        tags: ['Crawler'],
        httpMethod: ['get', 'post'],
        returnType: [String, OutputServerEventStream],
    })
    @CloudHTTPv2({
        runtime: {
            memory: '8GiB',
            timeoutSeconds: 540,
            concurrency: 21,
            maxInstances: 476,
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
                        description: `Specifies the form factor of the crawled data you prefer. \n\n` +
                            `Supported formats:\n` +
                            `- markdown\n` +
                            `- html\n` +
                            `- text\n` +
                            `- screenshot\n\n` +
                            `Defaults to: markdown`
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
                }
            }
        },
        tags: ['Crawler'],
        httpMethod: ['get', 'post'],
        returnType: [String, OutputServerEventStream],
    })
    async crawl(
        @RPCReflect() rpcReflect: RPCReflection,
        @Ctx() ctx: {
            req: Request,
            res: Response,
        },
    ) {
        const noSlashURL = ctx.req.url.slice(1);
        let urlToCrawl;
        try {
            urlToCrawl = new URL(normalizeUrl(noSlashURL.trim(), { stripWWW: false, removeTrailingSlash: false, removeSingleSlash: false }));
            if (urlToCrawl.protocol !== 'http:' && urlToCrawl.protocol !== 'https:') {
                throw new ParamValidationError({
                    message: `Invalid protocol ${urlToCrawl.protocol}`,
                    path: 'url'
                });
            }
        } catch (err) {
            throw new ParamValidationError({
                message: `${err}`,
                path: 'url'
            });
        }

        const customMode = ctx.req.get('x-respond-with') || 'markdown';
        const noCache = Boolean(ctx.req.get('x-no-cache'));
        const cookies: CookieParam[] = [];
        const setCookieHeaders = ctx.req.headers['x-set-cookie'];
        if (Array.isArray(setCookieHeaders)) {
            for (const setCookie of setCookieHeaders) {
                cookies.push({
                    ...parseSetCookieString(setCookie, { decodeValues: false }) as CookieParam,
                    domain: urlToCrawl.hostname,
                });
            }
        } else if (setCookieHeaders) {
            cookies.push({
                ...parseSetCookieString(setCookieHeaders, { decodeValues: false }) as CookieParam,
                domain: urlToCrawl.hostname,
            });
        }

        const crawlOpts: ScrappingOptions = {
            proxyUrl: ctx.req.get('x-proxy-url'),
            cookies,
        };

        if (!ctx.req.accepts('text/plain') && ctx.req.accepts('text/event-stream')) {
            const sseStream = new OutputServerEventStream();
            rpcReflect.return(sseStream);

            try {
                for await (const scrapped of this.cachedScrap(urlToCrawl, crawlOpts, noCache)) {
                    if (!scrapped) {
                        continue;
                    }

                    const formatted = await this.formatSnapshot(customMode, scrapped, urlToCrawl);

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
            for await (const scrapped of this.cachedScrap(urlToCrawl, crawlOpts, noCache)) {
                lastScrapped = scrapped;
                if (!scrapped?.parsed?.content || !(scrapped.title?.trim())) {
                    continue;
                }

                const formatted = await this.formatSnapshot(customMode, scrapped, urlToCrawl);

                return formatted;
            }

            if (!lastScrapped) {
                throw new AssertionFailureError(`No content available for URL ${urlToCrawl}`);
            }

            return await this.formatSnapshot(customMode, lastScrapped, urlToCrawl);
        }

        for await (const scrapped of this.cachedScrap(urlToCrawl, crawlOpts, noCache)) {
            lastScrapped = scrapped;
            if (!scrapped?.parsed?.content || !(scrapped.title?.trim())) {
                continue;
            }

            const formatted = await this.formatSnapshot(customMode, scrapped, urlToCrawl);
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
        if (customMode === 'screenshot' && Reflect.get(formatted, 'screenshotUrl')) {

            return assignTransferProtocolMeta(`${formatted}`,
                { code: 302, envelope: null, headers: { Location: Reflect.get(formatted, 'screenshotUrl') } }
            );
        }

        return assignTransferProtocolMeta(`${formatted}`, { contentType: 'text/plain', envelope: null });
    }

    getUrlDigest(urlToCrawl: URL) {
        const normalizedURL = new URL(urlToCrawl);
        normalizedURL.hash = '';
        const normalizedUrl = normalizedURL.toString().toLowerCase();
        const digest = md5Hasher.hash(normalizedUrl.toString());

        return digest;
    }

    async queryCache(urlToCrawl: URL) {
        const digest = this.getUrlDigest(urlToCrawl);

        const cache = (await Crawled.fromFirestoreQuery(Crawled.COLLECTION.where('urlPathDigest', '==', digest).orderBy('createdAt', 'desc').limit(1)))?.[0];

        if (cache) {
            const age = Date.now() - cache.createdAt.valueOf();
            const stale = cache.createdAt.valueOf() > (Date.now() - this.cacheValidMs);
            this.logger.info(`${stale ? 'Only stale ' : ''}Cache exists for ${urlToCrawl}, normalized digest: ${digest}, ${age}ms old`, {
                url: urlToCrawl, digest, age, stale
            });

            const r = cache.snapshot;

            return {
                isFresh: !stale,
                snapshot: {
                    ...r,
                    screenshot: undefined,
                    screenshotUrl: cache.screenshotAvailable ?
                        await this.firebaseObjectStorage.signDownloadUrl(`screenshots/${cache._id}`, Date.now() + this.urlValidMs) : undefined,
                } as PageSnapshot & { screenshotUrl?: string; }
            };
        }

        return undefined;
    }

    async setToCache(urlToCrawl: URL, snapshot: PageSnapshot) {
        const digest = this.getUrlDigest(urlToCrawl);

        this.logger.info(`Caching snapshot of ${urlToCrawl}...`, { url: urlToCrawl, digest, title: snapshot?.title, href: snapshot?.href });
        const nowDate = new Date();

        const cache = Crawled.from({
            _id: randomUUID(),
            url: urlToCrawl.toString(),
            createdAt: nowDate,
            expireAt: new Date(nowDate.valueOf() + this.cacheRetentionMs),
            urlPathDigest: digest,
            snapshot: {
                ...snapshot,
                screenshot: null
            },
        });

        if (snapshot.screenshot) {
            await this.firebaseObjectStorage.saveFile(`screenshots/${cache._id}`, snapshot.screenshot, {
                metadata: {
                    contentType: 'image/png',
                }
            });
            cache.screenshotAvailable = true;
        }
        const r = await Crawled.save(cache.degradeForFireStore()).catch((err) => {
            this.logger.error(`Failed to save cache for ${urlToCrawl}`, { err: marshalErrorLike(err) });

            return undefined;
        });

        return r;
    }

    async *cachedScrap(urlToCrawl: URL, crawlOpts: ScrappingOptions, noCache: boolean = false) {
        let cache;
        if (!noCache && !crawlOpts.cookies?.length) {
            cache = await this.queryCache(urlToCrawl);
        }

        if (cache?.isFresh) {
            yield cache.snapshot;

            return;
        }

        try {
            yield* this.puppeteerControl.scrap(urlToCrawl, crawlOpts);
        } catch (err: any) {
            if (cache) {
                this.logger.warn(`Failed to scrap ${urlToCrawl}, but a stale cache is available. Falling back to cache`, { err: marshalErrorLike(err) });
                yield cache.snapshot;
                return;
            }
            throw err;
        }
    }

}
