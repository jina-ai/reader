import { assignTransferProtocolMeta, marshalErrorLike, RPCHost, RPCReflection, AssertionFailureError, ParamValidationError } from 'civkit';
import { singleton } from 'tsyringe';
import { CloudHTTPv2, Ctx, Logger, OutputServerEventStream, RPCReflect } from '../shared';
import _ from 'lodash';
import { PageSnapshot, PuppeteerControl, ScrappingOptions } from '../services/puppeteer';
import { Request, Response } from 'express';
import normalizeUrl from "@esm2cjs/normalize-url";
import { AltTextService } from '../services/alt-text';
import TurndownService from 'turndown';
import { parseString as parseSetCookieString } from 'set-cookie-parser';
import { CookieParam } from 'puppeteer';

function tidyMarkdown(markdown: string): string {

    // Step 1: Handle complex broken links with text and optional images spread across multiple lines
    let normalizedMarkdown = markdown.replace(/\[\s*([^]+?)\s*\]\s*\(\s*([^)]+)\s*\)/g, (match, text, url) => {
        // Remove internal new lines and excessive spaces within the text
        text = text.replace(/\s+/g, ' ').trim();
        url = url.replace(/\s+/g, '').trim();
        return `[${text}](${url})`;
    });

    normalizedMarkdown = normalizedMarkdown.replace(/\[\s*([^!]*?)\s*\n*(?:!\[([^\]]*)\]\((.*?)\))?\s*\n*\]\s*\(\s*([^)]+)\s*\)/g, (match, text, alt, imgUrl, linkUrl) => {
        // Normalize by removing excessive spaces and new lines
        text = text.replace(/\s+/g, ' ').trim();
        alt = alt ? alt.replace(/\s+/g, ' ').trim() : '';
        imgUrl = imgUrl ? imgUrl.replace(/\s+/g, '').trim() : '';
        linkUrl = linkUrl.replace(/\s+/g, '').trim();
        if (imgUrl) {
            return `[${text} ![${alt}](${imgUrl})](${linkUrl})`;
        } else {
            return `[${text}](${linkUrl})`;
        }
    });

    // Step 2: Normalize regular links that may be broken across lines
    normalizedMarkdown = normalizedMarkdown.replace(/\[\s*([^\]]+)\]\s*\(\s*([^)]+)\)/g, (match, text, url) => {
        text = text.replace(/\s+/g, ' ').trim();
        url = url.replace(/\s+/g, '').trim();
        return `[${text}](${url})`;
    });

    // Step 3: Replace more than two consecutive empty lines with exactly two empty lines
    normalizedMarkdown = normalizedMarkdown.replace(/\n{3,}/g, '\n\n');

    // Step 4: Remove leading spaces from each line
    normalizedMarkdown = normalizedMarkdown.replace(/^[ \t]+/gm, '');

    return normalizedMarkdown.trim();
}

@singleton()
export class CrawlerHost extends RPCHost {
    logger = this.globalLogger.child({ service: this.constructor.name });

    turnDownPlugins = [require('turndown-plugin-gfm').tables];

    constructor(
        protected globalLogger: Logger,
        protected puppeteerControl: PuppeteerControl,
        protected altTextService: AltTextService,
    ) {
        super(...arguments);
    }

    override async init() {
        await this.dependencyReady();

        this.emit('ready');
    }

    async formatSnapshot(mode: string | 'markdown' | 'html' | 'text' | 'screenshot', snapshot: PageSnapshot, nominalUrl?: string) {
        if (mode === 'screenshot') {
            return {
                screenshot: snapshot.screenshot?.toString('base64'),
                toString() {
                    return this.screenshot;
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

        let contentText = '';
        if (toBeTurnedToMd) {
            const urlToAltMap: { [k: string]: string | undefined; } = {};
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
            url: nominalUrl || snapshot.href?.trim(),
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
            noCache,
            proxyUrl: ctx.req.get('x-proxy-url'),
            cookies,
        };

        if (!ctx.req.accepts('text/plain') && ctx.req.accepts('text/event-stream')) {
            const sseStream = new OutputServerEventStream();
            rpcReflect.return(sseStream);

            try {
                for await (const scrapped of this.puppeteerControl.scrap(urlToCrawl.toString(), crawlOpts)) {
                    if (!scrapped) {
                        continue;
                    }

                    const formatted = await this.formatSnapshot(customMode, scrapped, urlToCrawl?.toString());

                    sseStream.write({
                        event: 'data',
                        data: formatted,
                    });
                }
            } catch (err: any) {
                this.logger.error(`Failed to crawl ${urlToCrawl.toString()}`, { err: marshalErrorLike(err) });
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
            for await (const scrapped of this.puppeteerControl.scrap(urlToCrawl.toString(), crawlOpts)) {
                lastScrapped = scrapped;
                if (!scrapped?.parsed?.content || !(scrapped.title?.trim())) {
                    continue;
                }

                const formatted = await this.formatSnapshot(customMode, scrapped, urlToCrawl?.toString());

                return formatted;
            }

            if (!lastScrapped) {
                throw new AssertionFailureError(`No content available for URL ${urlToCrawl}`);
            }

            return await this.formatSnapshot(customMode, lastScrapped, urlToCrawl?.toString());
        }

        for await (const scrapped of this.puppeteerControl.scrap(urlToCrawl.toString(), crawlOpts)) {
            lastScrapped = scrapped;
            if (!scrapped?.parsed?.content || !(scrapped.title?.trim())) {
                continue;
            }

            if (customMode === 'screenshot' && scrapped?.screenshot) {
                return assignTransferProtocolMeta(scrapped.screenshot, { contentType: 'image/jpeg', envelope: null });
            }

            const formatted = await this.formatSnapshot(customMode, scrapped, urlToCrawl?.toString());


            return assignTransferProtocolMeta(`${formatted}`, { contentType: 'text/plain', envelope: null });
        }

        if (!lastScrapped) {
            throw new AssertionFailureError(`No content available for URL ${urlToCrawl}`);
        }

        if (customMode === 'screenshot') {
            if (!lastScrapped.screenshot) {
                throw new AssertionFailureError(`No screenshot available for URL ${urlToCrawl}`);
            }
            return assignTransferProtocolMeta(lastScrapped.screenshot, { contentType: 'image/jpeg', envelope: null });
        }

        return assignTransferProtocolMeta(`${await this.formatSnapshot(customMode, lastScrapped, urlToCrawl?.toString())}`, { contentType: 'text/plain', envelope: null });
    }


}

function cleanAttribute(attribute: string) {
    return attribute ? attribute.replace(/(\n+\s*)+/g, '\n') : '';
}
