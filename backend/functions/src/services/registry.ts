import { propertyInjectorFactory } from 'civkit/property-injector';
import { KoaRPCRegistry } from 'civkit/civ-rpc/koa';
import { container, singleton } from 'tsyringe';
import { IntegrityEnvelope } from 'civkit/civ-rpc';
import bodyParser from '@koa/bodyparser';

import { GlobalLogger } from './logger';
import { TempFileManager } from './temp-file';
import { AsyncLocalContext } from './async-context';
import { BlackHoleDetector } from './blackhole-detector';
export { Context } from 'koa';

export const InjectProperty = propertyInjectorFactory(container);

@singleton()
export class RPCRegistry extends KoaRPCRegistry {

    title = 'Jina Reader API';
    container = container;
    logger = this.globalLogger.child({ service: this.constructor.name });
    static override envelope = IntegrityEnvelope;
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
        this.__binaryParse.bind(this),
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
