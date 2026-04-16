import { singleton } from 'tsyringe';
import { AsyncService } from 'civkit/async-service';
import { GlobalLogger } from '../logger';
import { AsyncLocalContext } from '../async-context';
import { BlackHoleDetector } from '../blackhole-detector';
import { EnvConfig } from '../envconfig';
import { BraveSearchHTTP } from '../../3rd-party/brave-search';
import { WebSearchEntry } from './compat';

@singleton()
export class BraveSearchService extends AsyncService {

    logger = this.globalLogger.child({ service: this.constructor.name });

    client!: BraveSearchHTTP;

    constructor(
        protected globalLogger: GlobalLogger,
        protected envConfig: EnvConfig,
        protected threadLocal: AsyncLocalContext,
        protected blackHoleDetector: BlackHoleDetector,
    ) {
        super(...arguments);
    }

    override async init() {
        await this.dependencyReady();
        this.emit('ready');

        if (this.envConfig.BRAVE_SEARCH_API_KEY) {
            this.client = new BraveSearchHTTP(this.envConfig.BRAVE_SEARCH_API_KEY);
        }
    }

    async webSearch(query: { q: string; num?: number; gl?: string; hl?: string; page?: number; nfpr?: boolean; }) {
        const count = query.num || 10;
        const offset = query.page && query.page > 1 ? (query.page - 1) * count : undefined;
        const r = await this.client.webSearch({
            q: query.q,
            count,
            country: query.gl?.toUpperCase(),
            search_lang: query.hl,
            offset,
        });

        this.blackHoleDetector.itWorked();

        return (r.web?.results || []).map((x) => ({
            link: x.url,
            title: x.title,
            snippet: x.description,
            source: x.profile?.name,
            date: x.age,
            imageUrl: x.thumbnail?.src,
            variant: 'web',
        })) as WebSearchEntry[];
    }

    async newsSearch(query: { q: string; num?: number; gl?: string; hl?: string; page?: number; }) {
        const count = query.num || 10;
        const offset = query.page && query.page > 1 ? (query.page - 1) * count : undefined;
        const r = await this.client.newsSearch({
            q: query.q,
            count,
            country: query.gl?.toUpperCase(),
            search_lang: query.hl,
            offset,
        });

        this.blackHoleDetector.itWorked();

        return (r.results || []).map((x) => ({
            link: x.url,
            title: x.title,
            snippet: x.description,
            source: x.source?.name,
            date: x.age,
            imageUrl: x.thumbnail?.src,
            variant: 'news',
        })) as WebSearchEntry[];
    }

    async imageSearch(query: { q: string; num?: number; gl?: string; hl?: string; page?: number; }) {
        const count = query.num || 10;
        const offset = query.page && query.page > 1 ? (query.page - 1) * count : undefined;
        const r = await this.client.imageSearch({
            q: query.q,
            count,
            country: query.gl?.toUpperCase(),
            search_lang: query.hl,
            offset,
        });

        this.blackHoleDetector.itWorked();

        return (r.results || []).map((x) => ({
            link: x.url,
            title: x.title,
            snippet: undefined,
            source: x.source,
            imageUrl: x.properties?.url || x.thumbnail?.src,
            imageWidth: x.thumbnail?.width,
            imageHeight: x.thumbnail?.height,
            variant: 'images',
        })) as WebSearchEntry[];
    }
}
