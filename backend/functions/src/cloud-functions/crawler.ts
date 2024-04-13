import { assignTransferProtocolMeta, marshalErrorLike, RPCHost, RPCReflection, AssertionFailureError } from 'civkit';
import { singleton } from 'tsyringe';
import { CloudHTTPv2, Ctx, Logger, OutputServerEventStream, RPCReflect } from '../shared';
import _ from 'lodash';
import { PageSnapshot, PuppeteerControl } from '../services/puppeteer';
import TurnDownService from 'turndown';
import { Request, Response } from 'express';
import normalizeUrl from "@esm2cjs/normalize-url";


@singleton()
export class CrawlerHost extends RPCHost {
    logger = this.globalLogger.child({ service: this.constructor.name });

    turnDownService = new TurnDownService().use(require('turndown-plugin-gfm').gfm);

    constructor(
        protected globalLogger: Logger,
        protected puppeteerControl: PuppeteerControl,
    ) {
        super(...arguments);
    }

    override async init() {
        await this.dependencyReady();

        this.emit('ready');
    }

    formatSnapshot(snapshot: PageSnapshot) {

        const toBeTurnedToMd = snapshot.parsed?.content;
        const turnedDown = toBeTurnedToMd ? this.turnDownService.turndown(toBeTurnedToMd).trim() : '';

        const contentText = turnedDown && !(turnedDown.startsWith('<') && turnedDown.endsWith('>')) ? turnedDown : snapshot.text.trim();

        const formatted = {
            title: (snapshot.parsed?.title || snapshot.title || '').trim(),
            url: snapshot.href.trim(),
            content: contentText.trim(),

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
        const urlToCrawl = new URL(normalizeUrl(noSlashURL));
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

                    const formatted = this.formatSnapshot(scrapped);

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
                if (!scrapped?.parsed?.content) {
                    continue;
                }

                const formatted = this.formatSnapshot(scrapped);

                return formatted;
            }

            if (!lastScrapped) {
                throw new AssertionFailureError(`No content available for URL ${urlToCrawl}`);
            }

            return this.formatSnapshot(lastScrapped);
        }

        for await (const scrapped of this.puppeteerControl.scrap(urlToCrawl.toString(), noCache)) {
            lastScrapped = scrapped;
            if (!scrapped?.parsed?.content) {
                continue;
            }

            const formatted = this.formatSnapshot(scrapped);

            return assignTransferProtocolMeta(`${formatted}`, { contentType: 'text/plain', envelope: null });
        }

        if (!lastScrapped) {
            throw new AssertionFailureError(`No content available for URL ${urlToCrawl}`);
        }

        return `${this.formatSnapshot(lastScrapped)}`;
    }


}
