import { AsyncService, AutoCastable, DownstreamServiceFailureError, Prop, RPC_CALL_ENVIRONMENT, delay, marshalErrorLike } from 'civkit';
import { singleton } from 'tsyringe';
import { GlobalLogger } from './logger';
import { SecretExposer } from '../shared/services/secrets';
import { AsyncLocalContext } from './async-context';
import { SerperBingHTTP, SerperGoogleHTTP, SerperImageSearchResponse, SerperNewsSearchResponse, SerperSearchQueryParams, SerperWebSearchResponse } from '../shared/3rd-party/serper-search';
import { BlackHoleDetector } from './blackhole-detector';
import { Context } from './registry';
import { ServiceBadAttemptError } from '../shared';

@singleton()
export class SerperSearchService extends AsyncService {

    logger = this.globalLogger.child({ service: this.constructor.name });

    serperGoogleSearchHTTP!: SerperGoogleHTTP;
    serperBingSearchHTTP!: SerperBingHTTP;

    constructor(
        protected globalLogger: GlobalLogger,
        protected secretExposer: SecretExposer,
        protected threadLocal: AsyncLocalContext,
        protected blackHoleDetector: BlackHoleDetector,
    ) {
        super(...arguments);
    }

    override async init() {
        await this.dependencyReady();
        this.emit('ready');

        this.serperGoogleSearchHTTP = new SerperGoogleHTTP(this.secretExposer.SERPER_SEARCH_API_KEY);
        this.serperBingSearchHTTP = new SerperBingHTTP(this.secretExposer.SERPER_SEARCH_API_KEY);
    }

    *iterClient() {
        const preferBingSearch = this.threadLocal.get('bing-preferred');
        if (preferBingSearch) {
            yield this.serperBingSearchHTTP;
        }
        while (true) {
            yield this.serperGoogleSearchHTTP;
        }
    }

    doSearch(variant: 'web', query: SerperSearchQueryParams): Promise<SerperWebSearchResponse>;
    doSearch(variant: 'images', query: SerperSearchQueryParams): Promise<SerperImageSearchResponse>;
    doSearch(variant: 'news', query: SerperSearchQueryParams): Promise<SerperNewsSearchResponse>;
    async doSearch(variant: 'web' | 'images' | 'news', query: SerperSearchQueryParams) {
        const clientIt = this.iterClient();
        let client = clientIt.next().value;
        if (!client) {
            throw new Error(`Error iterating serper client`);
        }

        let maxTries = 3;

        while (maxTries--) {
            const t0 = Date.now();
            try {
                this.logger.debug(`Doing external search`, query);
                let r;
                switch (variant) {
                    case 'images': {
                        r = await client.imageSearch(query);
                        const nextClient = clientIt.next().value;
                        if (nextClient && nextClient !== client) {
                            const results = r.parsed.images;
                            if (!results.length) {
                                client = nextClient;
                                throw new ServiceBadAttemptError('No results found');
                            }
                        }

                        break;
                    }
                    case 'news': {
                        r = await client.newsSearch(query);
                        const nextClient = clientIt.next().value;
                        if (nextClient && nextClient !== client) {
                            const results = r.parsed.news;
                            if (!results.length) {
                                client = nextClient;
                                throw new ServiceBadAttemptError('No results found');
                            }
                        }

                        break;
                    }
                    case 'web':
                    default: {
                        r = await client.webSearch(query);
                        const nextClient = clientIt.next().value;
                        if (nextClient && nextClient !== client) {
                            const results = r.parsed.organic;
                            if (!results.length) {
                                client = nextClient;
                                throw new ServiceBadAttemptError('No results found');
                            }
                        }

                        break;
                    }
                }
                const dt = Date.now() - t0;
                this.blackHoleDetector.itWorked();
                this.logger.debug(`External search took ${dt}ms`, { searchDt: dt, variant });

                return r.parsed;
            } catch (err: any) {
                const dt = Date.now() - t0;
                this.logger.error(`${variant} search failed: ${err?.message}`, { searchDt: dt, err: marshalErrorLike(err) });
                if (err?.status === 429) {
                    await delay(500 + 1000 * Math.random());
                    continue;
                }
                if (err instanceof ServiceBadAttemptError) {
                    continue;
                }

                throw new DownstreamServiceFailureError({ message: `Search(${variant}) failed` });
            }
        }

        throw new DownstreamServiceFailureError({ message: `Search(${variant}) failed` });
    }


    async webSearch(query: SerperSearchQueryParams) {
        return this.doSearch('web', query);
    }
    async imageSearch(query: SerperSearchQueryParams) {
        return this.doSearch('images', query);
    }
    async newsSearch(query: SerperSearchQueryParams) {
        return this.doSearch('news', query);
    }

}

export class GoogleSearchExplicitOperatorsDto extends AutoCastable {
    @Prop({
        arrayOf: String,
        desc: `Returns web pages with a specific file extension. Example: to find the Honda GX120 Owner’s manual in PDF, type “Honda GX120 ownners manual ext:pdf”.`
    })
    ext?: string | string[];

    @Prop({
        arrayOf: String,
        desc: `Returns web pages created in the specified file type. Example: to find a web page created in PDF format about the evaluation of age-related cognitive changes, type “evaluation of age cognitive changes filetype:pdf”.`
    })
    filetype?: string | string[];

    @Prop({
        arrayOf: String,
        desc: `Returns webpages containing the specified term in the title of the page. Example: to find pages about SEO conferences making sure the results contain 2023 in the title, type “seo conference intitle:2023”.`
    })
    intitle?: string | string[];

    @Prop({
        arrayOf: String,
        desc: `Returns web pages written in the specified language. The language code must be in the ISO 639-1 two-letter code format. Example: to find information on visas only in Spanish, type “visas lang:es”.`
    })
    loc?: string | string[];

    @Prop({
        arrayOf: String,
        desc: `Returns web pages coming only from a specific web site. Example: to find information about Goggles only on Brave pages, type “goggles site:brave.com”.`
    })
    site?: string | string[];

    addTo(searchTerm: string) {
        const chunks = [];
        for (const [key, value] of Object.entries(this)) {
            if (value) {
                const values = Array.isArray(value) ? value : [value];
                const textValue = values.map((v) => `${key}:${v}`).join(' OR ');
                if (textValue) {
                    chunks.push(textValue);
                }
            }
        }
        const opPart = chunks.length > 1 ? chunks.map((x) => `(${x})`).join(' AND ') : chunks;

        if (opPart.length) {
            return [searchTerm, opPart].join(' ');
        }

        return searchTerm;
    }

    static override from(input: any) {
        const instance = super.from(input) as GoogleSearchExplicitOperatorsDto;
        const ctx = Reflect.get(input, RPC_CALL_ENVIRONMENT) as Context | undefined;

        const params = ['ext', 'filetype', 'intitle', 'loc', 'site'];

        for (const p of params) {
            const customValue = ctx?.get(`x-${p}`) || ctx?.get(`${p}`);
            if (!customValue) {
                continue;
            }

            const filtered = customValue.split(', ').filter(Boolean);
            if (filtered.length) {
                Reflect.set(instance, p, filtered);
            }
        }

        return instance;
    }
}
