import 'reflect-metadata';
import { container, singleton } from 'tsyringe';
import { initializeApp, applicationDefault } from 'firebase-admin/app';

process.env['FIREBASE_CONFIG'] = JSON.stringify({
    projectId: 'reader-6b7dc',
    storageBucket: 'reader-6b7dc.appspot.com',
    credential: applicationDefault(),
});

initializeApp();


import { Logger, CloudFunctionRegistry } from '../shared';
import { AbstractRPCRegistry, OpenAPIManager } from 'civkit/civ-rpc';
import { ExpressServer } from 'civkit/civ-rpc/express';
import http2 from 'http2';
import { SearcherHost } from '../cloud-functions/searcher';
import { FsWalk, WalkOutEntity } from 'civkit/fswalk';
import path from 'path';
import fs from 'fs';
import { mimeOfExt } from 'civkit/mime';
import { NextFunction, Request, Response } from 'express';

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
export class SearchStandAloneServer extends ExpressServer {
    logger = this.globalLogger.child({ service: this.constructor.name });

    httpAlternativeServer?: typeof this['httpServer'];
    assets = new Map<string, WalkOutEntity>();

    constructor(
        protected globalLogger: Logger,
        protected registry: CloudFunctionRegistry,
        protected searcherHost: SearcherHost,
    ) {
        super(...arguments);

        registry.allHandsOnDeck().catch(() => void 0);
        registry.title = 'reader';
        registry.version = '0.1.0';
    }

    h2c() {
        this.httpAlternativeServer = this.httpServer;
        this.httpServer = http2.createServer(this.expressApp);
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

    makeAssetsServingController() {
        return (req: Request, res: Response, next: NextFunction) => {
            const requestPath = req.url;
            const file = requestPath.slice(1);
            if (!file) {
                return next();
            }

            const asset = this.assets.get(file);
            if (asset?.type !== 'file') {
                return next();
            }
            res.type(mimeOfExt(path.extname(asset.path.toString())) || 'application/octet-stream');
            res.set('Content-Length', asset.stats.size.toString());
            fs.createReadStream(asset.path).pipe(res);

            return;
        };
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

    override registerRoutes(): void {

        const openAPIManager = new OpenAPIManager();
        openAPIManager.document('/{q}', ['get', 'post'], this.registry.conf.get('search')!);
        const openapiJsonPath = '/openapi.json';
        this.expressRootRouter.get(openapiJsonPath, (req, res) => {
            const baseURL = new URL(req.url, `${req.protocol}://${req.headers.host}`);
            baseURL.pathname = baseURL.pathname.replace(new RegExp(`${openapiJsonPath}$`, 'i'), '').replace(/\/+$/g, '');
            baseURL.search = '';
            const content = openAPIManager.createOpenAPIObject(baseURL.toString(), {
                info: {
                    title: this.registry.title,
                    description: `${this.registry.title} openAPI documentations`,
                    'x-logo': {
                        url: this.registry.logoUrl || `https://www.openapis.org/wp-content/uploads/sites/3/2018/02/OpenAPI_Logo_Pantone-1.png`
                    }
                }
            }, (this.registry.constructor as typeof AbstractRPCRegistry).envelope, req.query as any);
            res.statusCode = 200;
            res.end(JSON.stringify(content));
        });

        this.expressRootRouter.use('/', ...this.registry.expressMiddlewares, this.makeAssetsServingController(), this.registry.makeShimController('search'));
    }

    protected override featureSelect(): void {
        this.insertAsyncHookMiddleware();
        this.insertHealthCheckMiddleware(this.healthCheckEndpoint);
        this.insertLogRequestsMiddleware();
        this.registerOpenAPIDocsRoutes('/docs');

        this.registerRoutes();
    }
}
const instance = container.resolve(SearchStandAloneServer);

export default instance;

instance.serviceReady().then((s) => s.h2c().listen(parseInt(process.env.PORT || '') || 3000));
