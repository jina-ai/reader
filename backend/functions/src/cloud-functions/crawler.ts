import { assignTransferProtocolMeta, marshalErrorLike, RPCHost, RPCReflection, AssertionFailureError, ParamValidationError } from 'civkit';
import { singleton } from 'tsyringe';
import { CloudHTTPv2, Ctx, Logger, OutputServerEventStream, RPCReflect } from '../shared';
import _ from 'lodash';
import { PageSnapshot, PuppeteerControl } from '../services/puppeteer';
import { Request, Response } from 'express';
import normalizeUrl from "@esm2cjs/normalize-url";
import { AltTextService } from '../services/alt-text';
import TurndownService from 'turndown';

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

    turnDownPlugins = [require('turndown-plugin-gfm').gfm];

    imageShortUrlPrefix?: string;

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

    async formatSnapshot(snapshot: PageSnapshot) {
        const toBeTurnedToMd = snapshot.parsed?.content;
        let turnDownService = new TurndownService();
        for (const plugin of this.turnDownPlugins) {
            turnDownService = turnDownService.use(plugin);
        }

        let contentText = '';
        if (toBeTurnedToMd) {
            const urlToAltMap: { [k: string]: { shortDigest: string, alt?: string; }; } = {};
            const tasks = (snapshot.imgs || []).map(async (x) => {
                const r = await this.altTextService.getAltTextAndShortDigest(x).catch((err)=> {
                    this.logger.warn(`Failed to get alt text for ${x.src}`, { err: marshalErrorLike(err) });
                    return undefined;
                });
                if (r) {
                    urlToAltMap[x.src.trim()] = r;
                }
            });

            await Promise.all(tasks);

            turnDownService.addRule('img-generated-alt', {
                filter: 'img',
                replacement: (_content, node) => {
                    const src = (node.getAttribute('src') || '').trim();
                    const alt = cleanAttribute(node.getAttribute('alt'));
                    if (!src) {
                        return '';
                    }
                    const mapped = urlToAltMap[src];
                    if (mapped) {
                        return `![${mapped.alt || alt}](${this.imageShortUrlPrefix ? `${this.imageShortUrlPrefix}/${mapped.shortDigest}` : src})`;
                    }
                    return `![${alt}](${src})`;
                }
            });

            contentText = turnDownService.turndown(toBeTurnedToMd).trim();
        }

        if (contentText.startsWith('<') && contentText.endsWith('>')) {
            contentText = turnDownService.turndown(snapshot.html);
        }
        if (!contentText || contentText.startsWith('<') || contentText.endsWith('>')) {
            contentText = snapshot.text;
        }

        const cleanText = tidyMarkdown(contentText || '').trim();

        const formatted = {
            title: (snapshot.parsed?.title || snapshot.title || '').trim(),
            url: snapshot.href?.trim(),
            content: cleanText,

            toString() {
                return `Title: ${this.title}

URL Source: ${this.url}

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
        httpMethod: ['get', 'post'],
        returnType: [String, OutputServerEventStream],
    })
    @CloudHTTPv2({
        runtime: {
            memory: '8GiB',
            timeoutSeconds: 540,
            concurrency: 16,
        },
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
            urlToCrawl = new URL(normalizeUrl(noSlashURL.trim()));
        } catch (err) {
            throw new ParamValidationError({
                message: `${err}`,
                path: 'url'
            });
        }
        const screenshotEnabled = Boolean(ctx.req.headers['x-screenshot']);
        const noCache = Boolean(ctx.req.headers['x-no-cache']);

        if (!ctx.req.accepts('text/plain') && ctx.req.accepts('text/event-stream')) {
            const sseStream = new OutputServerEventStream();
            rpcReflect.return(sseStream);

            try {
                for await (const scrapped of this.puppeteerControl.scrap(urlToCrawl.toString(), noCache)) {
                    if (!scrapped) {
                        continue;
                    }

                    const formatted = await this.formatSnapshot(scrapped);

                    if (scrapped.screenshot && screenshotEnabled) {
                        sseStream.write({
                            event: 'screenshot',
                            data: scrapped.screenshot.toString('base64'),
                        });
                    }

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
            for await (const scrapped of this.puppeteerControl.scrap(urlToCrawl.toString(), noCache)) {
                lastScrapped = scrapped;
                if (!scrapped?.parsed?.content || !(scrapped.title?.trim())) {
                    continue;
                }

                const formatted = await this.formatSnapshot(scrapped);

                return formatted;
            }

            if (!lastScrapped) {
                throw new AssertionFailureError(`No content available for URL ${urlToCrawl}`);
            }

            return await this.formatSnapshot(lastScrapped);
        }

        for await (const scrapped of this.puppeteerControl.scrap(urlToCrawl.toString(), noCache)) {
            lastScrapped = scrapped;
            if (!scrapped?.parsed?.content || !(scrapped.title?.trim())) {
                continue;
            }

            const formatted = await this.formatSnapshot(scrapped);

            return assignTransferProtocolMeta(`${formatted}`, { contentType: 'text/plain', envelope: null });
        }

        if (!lastScrapped) {
            throw new AssertionFailureError(`No content available for URL ${urlToCrawl}`);
        }

        return `${await this.formatSnapshot(lastScrapped)}`;
    }


}

function cleanAttribute(attribute: string) {
    return attribute ? attribute.replace(/(\n+\s*)+/g, '\n') : '';
}
