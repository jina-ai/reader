import { marshalErrorLike, RPCHost, RPCReflection } from 'civkit';
import { singleton } from 'tsyringe';
import { CloudHTTPv2, Logger, OutputServerEventStream, Param, RPCReflect } from '../shared';
import _ from 'lodash';
import { PuppeteerControl } from '../services/puppeteer';
import TurnDownService from 'turndown';


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

    @CloudHTTPv2({
        exportInGroup: ['crawler'],
        httpMethod: ['get', 'post'],
        returnType: OutputServerEventStream,
    })
    async crawl(
        @RPCReflect() rpcReflect: RPCReflection,
        @Param('url', { required: true }) url: string
    ) {
        await this.serviceReady();
        const sseStream = new OutputServerEventStream();

        rpcReflect.return(sseStream);

        try {
            for await (const scrapped of this.puppeteerControl.scrap(url)) {
                this.logger.info(`Scrapped: ${scrapped.snapshot}`);
                const content = typeof scrapped.snapshot === 'string' ? scrapped.snapshot : (scrapped.snapshot as any)?.content;
                if (!content) {
                    continue;
                }
                const text = this.turnDownService.turndown(typeof scrapped.snapshot === 'string' ? scrapped.snapshot : (scrapped.snapshot as any)?.content);
                sseStream.write({
                    event: 'data',
                    data: text,
                });
            }
        } catch (err: any) {
            this.logger.error(`Failed to crawl ${url}`, { err: marshalErrorLike(err) });
            sseStream.write({
                event: 'error',
                data: err,
            });
        }

        sseStream.end();

        return sseStream;
    }


}
