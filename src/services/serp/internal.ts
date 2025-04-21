
import { singleton } from 'tsyringe';
import { GlobalLogger } from '../logger';
import { SecretExposer } from '../../shared/services/secrets';
import { AsyncLocalContext } from '../async-context';
import { SerperSearchQueryParams } from '../../shared/3rd-party/serper-search';
import { BlackHoleDetector } from '../blackhole-detector';
import { AsyncService } from 'civkit/async-service';
import { JinaSerpApiHTTP } from '../../shared/3rd-party/internal-serp';
import { WebSearchEntry } from './compat';

@singleton()
export class InternalJinaSerpService extends AsyncService {

    logger = this.globalLogger.child({ service: this.constructor.name });

    client!: JinaSerpApiHTTP;

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

        this.client = new JinaSerpApiHTTP(this.secretExposer.JINA_SERP_API_KEY);
    }


    async doSearch(variant: 'web' | 'images' | 'news', query: SerperSearchQueryParams) {
        this.logger.debug(`Doing external search`, query);
        let results;
        switch (variant) {
            // case 'images': {
            //     const r = await this.client.imageSearch(query);

            //     results = r.parsed.images;
            //     break;
            // }
            // case 'news': {
            //     const r = await this.client.newsSearch(query);

            //     results = r.parsed.news;
            //     break;
            // }
            case 'web':
            default: {
                const r = await this.client.webSearch(query);

                results = r.parsed.results?.map((x) => ({ ...x, link: x.url }));
                break;
            }
        }

        this.blackHoleDetector.itWorked();

        return results as WebSearchEntry[];
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
