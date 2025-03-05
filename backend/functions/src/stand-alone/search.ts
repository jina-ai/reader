import 'reflect-metadata';
import { container, singleton } from 'tsyringe';
import { initializeApp, applicationDefault } from 'firebase-admin/app';

process.env['FIREBASE_CONFIG'] ??= JSON.stringify({
    projectId: process.env['GCLOUD_PROJECT'] || 'reader-6b7dc',
    storageBucket: `${process.env['GCLOUD_PROJECT'] || 'reader-6b7dc'}.appspot.com`,
    credential: applicationDefault(),
});

initializeApp();


import { Logger, AsyncContext } from '../shared';
import { KoaServer } from 'civkit/civ-rpc/koa';
import http2 from 'http2';
import { SearcherHost } from '../api/searcher-serper';
import { FsWalk, WalkOutEntity } from 'civkit/fswalk';
import path from 'path';
import fs from 'fs';
import { mimeOfExt } from 'civkit/mime';
import { Context, Next } from 'koa';
import { RPCRegistry } from '../services/registry';
import { AsyncResource } from 'async_hooks';
import { runOnce } from 'civkit/decorators';
import { randomUUID } from 'crypto';

process.on('unhandledRejection', (err) => {
    console.error('Unhandled rejection', err);
});

process.on('uncaughtException', (err) => {
    console.log('Uncaught exception', err);

    // Looks like Firebase runtime does not handle error properly.
    // Make sure to quit the process.
    console.error('Uncaught exception, process quit.');
    process.nextTick(() => process.exit(1));
});

@singleton()
export class SearchStandAloneServer extends KoaServer {
    logger = this.globalLogger.child({ service: this.constructor.name });

    httpAlternativeServer?: typeof this['httpServer'];
    assets = new Map<string, WalkOutEntity>();

    constructor(
        protected globalLogger: Logger,
        protected registry: RPCRegistry,
        protected searcherHost: SearcherHost,
        protected threadLocal: AsyncContext,
    ) {
        super(...arguments);
    }

    h2c() {
        this.httpAlternativeServer = this.httpServer;
        const fn = this.koaApp.callback();
        this.httpServer = http2.createServer((req, res) => {
            const ar = new AsyncResource('HTTP2ServerRequest');
            ar.runInAsyncScope(fn, this.koaApp, req, res);
        });
        // useResourceBasedDefaultTracker();

        return this;
    }

    override async init() {
        await this.walkForAssets();
        await super.init();
    }

    async walkForAssets() {
        const files = await FsWalk.walkOut(path.resolve(__dirname, '..', '..', 'public'));

        for (const file of files) {
            if (file.type !== 'file') {
                continue;
            }
            this.assets.set(file.relativePath.toString(), file);
        }
    }

    override listen(port: number) {
        const r = super.listen(port);
        if (this.httpAlternativeServer) {
            const altPort = port + 1;
            this.httpAlternativeServer.listen(altPort, () => {
                this.logger.info(`Alternative ${this.httpAlternativeServer!.constructor.name} listening on port ${altPort}`);
            });
        }

        return r;
    }

    makeAssetsServingController() {
        return (ctx: Context, next: Next) => {
            const requestPath = ctx.path;
            const file = requestPath.slice(1);
            if (!file) {
                return next();
            }

            const asset = this.assets.get(file);
            if (asset?.type !== 'file') {
                return next();
            }

            ctx.body = fs.createReadStream(asset.path);
            ctx.type = mimeOfExt(path.extname(asset.path.toString())) || 'application/octet-stream';
            ctx.set('Content-Length', asset.stats.size.toString());

            return;
        };
    }

    registerRoutes(): void {
        this.koaApp.use(this.makeAssetsServingController());
        this.koaApp.use(this.registry.makeShimController());
    }


    // Using h2c server has an implication that multiple requests may share the same connection and x-cloud-trace-context
    // TraceId is expected to be request-bound and unique. So these two has to be distinguished.
    @runOnce()
    override insertAsyncHookMiddleware() {
        const asyncHookMiddleware = async (ctx: Context, next: () => Promise<void>) => {
            const googleTraceId = ctx.get('x-cloud-trace-context').split('/')?.[0];
            this.threadLocal.setup({
                traceId: randomUUID(),
                traceT0: new Date(),
                googleTraceId,
            });

            return next();
        };

        this.koaApp.use(asyncHookMiddleware);
    }

}
const instance = container.resolve(SearchStandAloneServer);

export default instance;

instance.serviceReady().then((s) => s.h2c().listen(parseInt(process.env.PORT || '') || 3000));
