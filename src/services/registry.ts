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
        // Map UI-friendly query params -> request headers so GET requests from interactive builder work
        this.__mapQueryToHeaders.bind(this),
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

    /**
     * Translate well-known query parameters into request headers so that:
     * - GET requests (used by the interactive builder) can pass options in query params,
     * - downstream code that inspects headers (x-respond-with, x-with-generated-alt, Accept, etc.)
     *   will behave identically.
     *
     * Example mappings:
     *  ?respond_with=markdown          => x-respond-with: markdown
     *  ?with_generated_alt=true       => x-with-generated-alt: true
     *  ?no_cache=true                 => x-no-cache: true
     *  ?wait_for_selector=#content    => x-wait-for-selector: #content
     *  ?target_selector=.main         => x-target-selector: .main
     *  ?proxy=https://proxy:3128      => x-proxy-url: https://proxy:3128
     *  ?cache_tolerance=120           => x-cache-tolerance: 120
     *  ?timeout=30                    => x-timeout: 30
     *  ?accept=application/json       => Accept: application/json
     */
    async __mapQueryToHeaders(ctx: any, next: any) {
        try {
            const q = ctx.query || {};
            const map: Record<string, string> = {
                'respond_with': 'x-respond-with',
                'respondWith': 'x-respond-with',
                'with_generated_alt': 'x-with-generated-alt',
                'withGeneratedAlt': 'x-with-generated-alt',
                'no_cache': 'x-no-cache',
                'noCache': 'x-no-cache',
                'wait_for_selector': 'x-wait-for-selector',
                'waitForSelector': 'x-wait-for-selector',
                'target_selector': 'x-target-selector',
                'targetSelector': 'x-target-selector',
                'proxy': 'x-proxy-url',
                'proxy_url': 'x-proxy-url',
                'proxyUrl': 'x-proxy-url',
                'cache_tolerance': 'x-cache-tolerance',
                'cacheTolerance': 'x-cache-tolerance',
                'timeout': 'x-timeout',
                'accept': 'accept',
            };

            for (const [qp, headerName] of Object.entries(map)) {
                const v = q[qp];
                if (v !== undefined && v !== null && String(v) !== '') {
                    // Koa request headers object is normally readonly in types; cast to any to assign
                    (ctx.request.headers as any)[headerName] = String(v);
                }
            }

            // Support boolean flags present without value (e.g. ?with_generated_alt)
            const booleanFlags = ['with_generated_alt', 'withGeneratedAlt', 'no_cache', 'noCache'];
            for (const f of booleanFlags) {
                if (Object.prototype.hasOwnProperty.call(q, f) && (q[f] === '' || q[f] === undefined)) {
                    const headerName = map[f];
                    (ctx.request.headers as any)[headerName] = 'true';
                }
            }
        } catch (err) {
            // don't fail the request on mapping errors; log and continue
            this.logger.warn(`Failed to map query params to headers: ${err}`, { err });
        }

        return next();
    }

}

const instance = container.resolve(RPCRegistry);
export default instance;
export const { Method, RPCMethod, RPCReflect, Param, Ctx, } = instance.decorators();
