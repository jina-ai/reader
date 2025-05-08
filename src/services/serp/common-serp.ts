import { singleton } from 'tsyringe';
import { AsyncService } from 'civkit/async-service';
import { GlobalLogger } from '../logger';
import { JSDomControl } from '../jsdom';
import _ from 'lodash';
import { WebSearchEntry } from './compat';
import { ServiceBadAttemptError } from '../errors';
import commonSerpClients, { CommonSerpImageResponse, CommonSerpNewsResponse, CommonSerpWebResponse } from '../../shared/3rd-party/common-serp';
import { AsyncLocalContext } from '../async-context';

@singleton()
export class CommonGoogleSERP extends AsyncService {
    logger = this.globalLogger.child({ service: this.constructor.name });
    googleDomain = process.env.OVERRIDE_GOOGLE_DOMAIN || 'www.google.com';

    protected ctxIteratorMap = new WeakMap<object, ReturnType<CommonGoogleSERP['iterClients']>>();

    constructor(
        protected globalLogger: GlobalLogger,
        protected jsDomControl: JSDomControl,
        protected asyncContext: AsyncLocalContext,

    ) {
        super(...arguments);
    }

    override async init() {
        await this.dependencyReady();

        this.emit('ready');
    }

    *iterClients() {
        if (!commonSerpClients.length) {
            return;
        }
        while (true) {
            yield* commonSerpClients;
        }
    }

    getClient() {
        const ctx = this.asyncContext.ctx;
        const it = this.ctxIteratorMap.get(ctx) || this.iterClients();
        this.ctxIteratorMap.set(ctx, it);
        const client = it.next().value;
        if (!client) {
            throw new ServiceBadAttemptError('No client available');
        }
        return client;
    }


    digestQuery(query: { [k: string]: any; }) {
        const url = new URL(`https://${this.googleDomain}/search`);
        const clone = { ...query };
        const num = clone.num || 10;
        if (clone.page) {
            const page = parseInt(clone.page);
            delete clone.page;
            clone.start = (page - 1) * num;
            if (clone.start === 0) {
                delete clone.start;
            }
        }
        if (clone.location) {
            delete clone.location;
        }

        for (const [k, v] of Object.entries(clone)) {
            if (v === undefined || v === null) {
                continue;
            }
            url.searchParams.set(k, `${v}`);
        }

        return url;
    }

    async webSearch(query: { [k: string]: any; }) {
        const url = this.digestQuery(query);

        const client = this.getClient();

        const r = await client.queryJSON(url.href) as CommonSerpWebResponse;

        return r.organic.map((x)=> ({
            link: x.link,
            title: x.title,
            snippet: x.description,
            variant: 'web',
        })) as WebSearchEntry[];
    }

    async newsSearch(query: { [k: string]: any; }) {
        const url = this.digestQuery(query);

        url.searchParams.set('tbm', 'nws');

        const client = this.getClient();

        const r = await client.queryJSON(url.href) as CommonSerpNewsResponse;

        return r.news.map((x)=> ({
            link: x.link,
            title: x.title,
            snippet: x.description,
            source: x.source,
            date: x.date,
            imageUrl: x.image,
            variant: 'news',
        })) as WebSearchEntry[];
    }

    async imageSearch(query: { [k: string]: any; }) {
        const url = this.digestQuery(query);

        url.searchParams.set('tbm', 'isch');

        const client = this.getClient();

        const r = await client.queryJSON(url.href) as CommonSerpImageResponse;

        return r.images.map((x)=> ({
            link: x.link,
            title: x.title,
            snippet: x.image_alt,
            source: x.source,
            imageUrl: x.image,
            variant: 'images',
        })) as WebSearchEntry[];
    }
}
