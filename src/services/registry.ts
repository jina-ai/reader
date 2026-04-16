import { propertyInjectorFactory } from 'civkit/property-injector';
import { KoaRPCRegistry } from 'civkit/civ-rpc/koa';
import { container, singleton } from 'tsyringe';
import { IntegrityEnvelope } from 'civkit/civ-rpc';
import bodyParser from '@koa/bodyparser';

import { GlobalLogger } from './logger';
import { TempFileManager } from './temp-file';
import { AsyncLocalContext } from './async-context';
import { BlackHoleDetector } from './blackhole-detector';
import { OutputServerEventStream } from '../lib/transform-server-event-stream';
import { isReadable } from 'stream';
export { Context } from 'koa';

export const InjectProperty = propertyInjectorFactory(container);


export class ReaderEnvelope extends IntegrityEnvelope {

    @InjectProperty(AsyncLocalContext)
    ctxMgr!: AsyncLocalContext;

    override async wrapError(err: any) {
        if (!this.ctxMgr?.available?.()) {
            return super.wrapError(err);
        }

        const upstream = await super.wrapError(err);

        if (this.ctxMgr.ctx.accepts?.('application/json')) {
            return upstream;
        }

        if (this.ctxMgr.ctx.accepts?.('text/plain') || this.ctxMgr.ctx.accepts?.('text/markdown')) {
            if (typeof upstream.output !== 'string') {
                upstream.output = `${err.readableMessage || err.toString()}`;
                if (!upstream.output.endsWith('\n')) {
                    upstream.output += '\n';
                }
                upstream.tpm.contentType = 'text/plain';
            }

            return upstream;
        }

        if (this.ctxMgr.ctx.accepts?.('text/event-stream')) {
            if (isReadable(upstream.output)) {
                return upstream.output;
            }
            const eventStream = new OutputServerEventStream();

            eventStream.end({
                event: 'error',
                data: JSON.stringify(`${err.readableMessage || err.toString()}` || 'Unknown error')
            });

            upstream.output = eventStream;
            upstream.tpm.contentType = 'text/event-stream';

            return upstream;
        }

        return upstream;
    }

}


@singleton()
export class RPCRegistry extends KoaRPCRegistry {

    title = 'Jina Reader API';
    container = container;
    logger = this.globalLogger.child({ service: this.constructor.name });
    static override envelope = ReaderEnvelope;
    override _BODY_PARSER_LIMIT = '102mb';
    override _RESPONSE_STREAM_MODE = 'koa' as const;

    override koaMiddlewares = [
        this.__CORSAllowAllMiddleware.bind(this),
        bodyParser({
            encoding: 'utf-8',
            enableTypes: ['json', 'form'],
            jsonLimit: this._BODY_PARSER_LIMIT,
            xmlLimit: this._BODY_PARSER_LIMIT,
            formLimit: this._BODY_PARSER_LIMIT,
        }),
        this.__multiParse.bind(this),
        // this.__binaryParse.bind(this),
    ];

    constructor(
        protected globalLogger: GlobalLogger,
        protected ctxMgr: AsyncLocalContext,
        protected tempFileManager: TempFileManager,
        protected blackHoleDetector: BlackHoleDetector,
    ) {
        super(...arguments);

        this.on('run', () => this.blackHoleDetector.incomingRequest());
        this.on('ran', () => this.blackHoleDetector.doneWithRequest());
        this.on('fail', () => this.blackHoleDetector.doneWithRequest());
    }

    override async init() {
        await this.dependencyReady();
        this.emit('ready');
    }

}

const instance = container.resolve(RPCRegistry);
export default instance;
export const { Method, RPCMethod, RPCReflect, Param, Ctx, } = instance.decorators();
