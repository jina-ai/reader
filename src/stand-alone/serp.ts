import 'reflect-metadata';
import { container, singleton } from 'tsyringe';

import { KoaServer } from 'civkit/civ-rpc/koa';
import http2 from 'http2';
import http from 'http';
import { FsWalk, WalkOutEntity } from 'civkit/fswalk';
import path from 'path';
import fs from 'fs';
import { mimeOfExt } from 'civkit/mime';
import { Context, Next } from 'koa';
import { RPCRegistry } from '../services/registry';
import { AsyncResource } from 'async_hooks';
import { runOnce } from 'civkit/decorators';
import { randomUUID } from 'crypto';
import { ThreadedServiceRegistry } from '../services/threaded';
import { GlobalLogger } from '../services/logger';
import { AsyncLocalContext } from '../services/async-context';
import finalizer, { Finalizer } from '../services/finalizer';
import { SerpHost } from '../api/serp';
import koaCompress from 'koa-compress';

@singleton()
export class SERPStandAloneServer extends KoaServer {
    logger = this.globalLogger.child({ service: this.constructor.name });

    httpAlternativeServer?: typeof this['httpServer'];
    assets = new Map<string, WalkOutEntity>();

    constructor(
        protected globalLogger: GlobalLogger,
        protected registry: RPCRegistry,
        protected serpHost: SerpHost,
        protected threadLocal: AsyncLocalContext,
        protected threads: ThreadedServiceRegistry,
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
        await this.dependencyReady();

        for (const [k, v] of this.registry.conf.entries()) {
            if (v.tags?.includes('crawl')) {
                this.registry.conf.delete(k);
            }
        }

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
        this.koaApp.use(koaCompress({
            filter(type) {
                if (type.startsWith('text/')) {
                    return true;
                }

                if (type.includes('application/json') || type.includes('+json') || type.includes('+xml')) {
                    return true;
                }

                if (type.includes('application/x-ndjson')) {
                    return true;
                }

                return false;
            }
        }));
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

    @Finalizer()
    override async standDown() {
        const tasks: Promise<any>[] = [];
        if (this.httpAlternativeServer?.listening) {
            (this.httpAlternativeServer as http.Server).closeIdleConnections?.();
            this.httpAlternativeServer.close();
            tasks.push(new Promise<void>((resolve, reject) => {
                this.httpAlternativeServer!.close((err) => {
                    if (err) {
                        return reject(err);
                    }
                    resolve();
                });
            }));
        }
        tasks.push(super.standDown());
        await Promise.all(tasks);
    }

}
const instance = container.resolve(SERPStandAloneServer);

export default instance;

if (process.env.NODE_ENV?.includes('dry-run')) {
    instance.serviceReady().then(() => finalizer.terminate());
} else {
    instance.serviceReady().then((s) => s.h2c().listen(parseInt(process.env.PORT || '') || 3000));
}
