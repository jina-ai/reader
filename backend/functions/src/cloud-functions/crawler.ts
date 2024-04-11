import { assignTransferProtocolMeta, marshalErrorLike, RPCHost, RPCReflection } from 'civkit';
import { singleton } from 'tsyringe';
import { CloudHTTPv2, Ctx, Logger, OutputServerEventStream, RPCReflect } from '../shared';
import _ from 'lodash';
import { PageSnapshot, PuppeteerControl } from '../services/puppeteer';
import TurnDownService from 'turndown';
import { Request, Response } from 'express';


@singleton()
export class CrawlerHost extends RPCHost {
    logger = this.globalLogger.child({ service: this.constructor.name });

    turnDownService = new TurnDownService();

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
        const contentText = toBeTurnedToMd ? this.turnDownService.turndown(toBeTurnedToMd) : snapshot.text;

        const formatted = `Title: ${(snapshot.parsed?.title || snapshot.title || '').trim()}

URL Source: ${snapshot.href.trim()}

Markdown Content:
${contentText.trim()}
`;

        return formatted;
    }

    @CloudHTTPv2({
        runtime: {
            memory: '4GiB',
            timeoutSeconds: 540,
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
        const url = new URL(ctx.req.url, `${ctx.req.protocol}://${ctx.req.headers.host}`);
        const rawPath = url.pathname.split('/').filter(Boolean);
        const host = rawPath.shift();
        const urlToCrawl = new URL(`${ctx.req.protocol}://${host}/${rawPath.join('/')}`);
        urlToCrawl.search = url.search;

        if (!ctx.req.accepts('text/plain') && ctx.req.accepts('text/event-stream')) {
            const sseStream = new OutputServerEventStream();
            rpcReflect.return(sseStream);

            try {
                for await (const scrapped of this.puppeteerControl.scrap(urlToCrawl.toString())) {
                    if (!scrapped) {
                        continue;
                    }

                    const formatted = this.formatSnapshot(scrapped);

                    if (scrapped.screenshot) {
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
                this.logger.error(`Failed to crawl ${url}`, { err: marshalErrorLike(err) });
                sseStream.write({
                    event: 'error',
                    data: marshalErrorLike(err),
                });
            }

            sseStream.end();

            return sseStream;
        }

        if (!ctx.req.accepts('text/plain') && (ctx.req.accepts('text/json') || ctx.req.accepts('application/json'))) {
            for await (const scrapped of this.puppeteerControl.scrap(urlToCrawl.toString())) {
                if (!scrapped?.parsed?.content) {
                    continue;
                }

                const formatted = this.formatSnapshot(scrapped);

                if (scrapped.screenshot) {

                    return [
                        {
                            type: 'image_url', image_url: {
                                url: `data:image/jpeg;base64,${scrapped.screenshot.toString('base64')}`,
                            }
                        },
                        { type: 'text', content: formatted },
                    ];
                }

                return formatted;
            }
        }

        for await (const scrapped of this.puppeteerControl.scrap(urlToCrawl.toString())) {
            if (!scrapped?.parsed?.content) {
                continue;
            }

            const formatted = this.formatSnapshot(scrapped);

            return assignTransferProtocolMeta(formatted, { contentType: 'text/plain', envelope: null });
        }

        throw new Error('Unreachable');
    }


}
