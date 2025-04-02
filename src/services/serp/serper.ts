
import { singleton } from 'tsyringe';
import { GlobalLogger } from '../logger';
import { SecretExposer } from '../../shared/services/secrets';
import { AsyncLocalContext } from '../async-context';
import { SerperBingHTTP, SerperGoogleHTTP, SerperImageSearchResponse, SerperNewsSearchResponse, SerperSearchQueryParams, SerperWebSearchResponse } from '../../shared/3rd-party/serper-search';
import { BlackHoleDetector } from '../blackhole-detector';
import { Context } from '../registry';
import { AsyncService } from 'civkit/async-service';
import { AutoCastable, Prop, RPC_CALL_ENVIRONMENT } from 'civkit/civ-rpc';

@singleton()
export class SerperGoogleSearchService extends AsyncService {

    logger = this.globalLogger.child({ service: this.constructor.name });

    client!: SerperGoogleHTTP;

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

        this.client = new SerperGoogleHTTP(this.secretExposer.SERPER_SEARCH_API_KEY);
    }


    doSearch(variant: 'web', query: SerperSearchQueryParams): Promise<SerperWebSearchResponse['organic']>;
    doSearch(variant: 'images', query: SerperSearchQueryParams): Promise<SerperImageSearchResponse['images']>;
    doSearch(variant: 'news', query: SerperSearchQueryParams): Promise<SerperNewsSearchResponse['news']>;
    async doSearch(variant: 'web' | 'images' | 'news', query: SerperSearchQueryParams) {
        this.logger.debug(`Doing external search`, query);
        let results;
        switch (variant) {
            case 'images': {
                const r = await this.client.imageSearch(query);

                results = r.parsed.images;
                break;
            }
            case 'news': {
                const r = await this.client.newsSearch(query);

                results = r.parsed.news;
                break;
            }
            case 'web':
            default: {
                const r = await this.client.webSearch(query);

                results = r.parsed.organic;
                break;
            }
        }

        this.blackHoleDetector.itWorked();

        return results;
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

@singleton()
export class SerperBingSearchService extends SerperGoogleSearchService {
    override client!: SerperBingHTTP;

    override async init() {
        await this.dependencyReady();
        this.emit('ready');

        this.client = new SerperBingHTTP(this.secretExposer.SERPER_SEARCH_API_KEY);
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
