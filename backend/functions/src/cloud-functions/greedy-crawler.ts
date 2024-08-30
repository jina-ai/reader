import {
    RPCHost, RPCReflection,
} from 'civkit';
import { singleton } from 'tsyringe';
import { AsyncContext, CloudHTTPv2, Ctx, Logger, RPCReflect } from '../shared';
import { RateLimitControl } from '../shared/services/rate-limit';
import _ from 'lodash';
import { Request, Response } from 'express';
import { JinaEmbeddingsAuthDTO } from '../shared/dto/jina-embeddings-auth';

import { FirebaseRoundTripChecker } from '../shared/services/firebase-roundtrip-checker';
import { CrawlerHost } from './crawler';
import { GreedyCrawlerOptions } from '../dto/greedy-options';
import { CrawlerOptions } from '../dto/scrapping-options';

@singleton()
export class GreedyCrawlerHost extends RPCHost {
    logger = this.globalLogger.child({ service: this.constructor.name });

    constructor(
        protected globalLogger: Logger,
        protected rateLimitControl: RateLimitControl,
        protected threadLocal: AsyncContext,
        protected fbHealthCheck: FirebaseRoundTripChecker,
        protected crawler: CrawlerHost,
    ) {
        super(...arguments);
    }

    override async init() {
        await this.dependencyReady();

        this.emit('ready');
    }

    @CloudHTTPv2({
        runtime: {
            memory: '4GiB',
            timeoutSeconds: 300,
            concurrency: 22,
        },
        tags: ['Crawler'],
        httpMethod: ['post'],
        returnType: [String],
        exposeRoot: true,
    })
    async greedyCrawl(
        @RPCReflect() rpcReflect: RPCReflection,
        @Ctx() ctx: {
            req: Request,
            res: Response,
        },
        auth: JinaEmbeddingsAuthDTO,
        crawlerOptions: CrawlerOptions,
        greedyCrawlerOptions: GreedyCrawlerOptions,
    ) {
        // const uid = await auth.solveUID();
        return {
            greedyCrawlerOptions,
            crawlerOptions,
        };
    }
}
