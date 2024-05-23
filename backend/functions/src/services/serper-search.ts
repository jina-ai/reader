import { AsyncService, DownstreamServiceFailureError, marshalErrorLike } from 'civkit';
import { singleton } from 'tsyringe';
import { Logger } from '../shared/services/logger';
import { SecretExposer } from '../shared/services/secrets';
import { GEOIP_SUPPORTED_LANGUAGES, GeoIPService } from './geoip';
import { AsyncContext } from '../shared';
import { WebSearchQueryParams } from '../shared/3rd-party/brave-search';
import axios from "axios";

@singleton()
export class SerperSearchService extends AsyncService {

    logger = this.globalLogger.child({ service: this.constructor.name });
    private api = axios.create({baseURL: 'https://google.serper.dev'})

    constructor(
        protected globalLogger: Logger,
        protected secretExposer: SecretExposer,
        protected geoipControl: GeoIPService,
        protected threadLocal: AsyncContext,
    ) {
        super(...arguments);
    }

    override async init() {
        await this.dependencyReady();
        this.emit('ready');
        this.api.defaults.headers.common['X-API-KEY'] = this.secretExposer.SERPER_API_KEY;;
    }

    async webSearch(query: WebSearchQueryParams) {

        const ip = this.threadLocal.get('ip');
        let location: string | undefined;
        if (ip) {
            const geoip = await this.geoipControl.lookupCity(ip, GEOIP_SUPPORTED_LANGUAGES.EN);

            if (geoip?.city && geoip?.country?.code) {
                let locationParts = [geoip.city]
                if (geoip.subdivisions?.[0]?.code) {
                    locationParts.push(geoip.subdivisions[0].code)
                }
                locationParts.push(geoip.country.code)
                location = locationParts.join(', ')
            }
        }

        const params = {
            q: query.query,
            gl: query.country,
            hl: query.search_lang,
            num: query.count || 10,
            page: query.offset ? query.offset + 1 : 1,
            location
        };

        try {
            const {data} = await this.api.post('/search', params);
            const transformed = {
                web: {
                    type: 'search',
                    results: data.organic.map((r: { link: string; title?: string; snippet?: string; }) => ({
                        url: r.link,
                        title: r.title,
                        description: r.snippet,
                    })),
                },
            };
            return transformed;
        } catch (err: any) {
            this.logger.error(`Web search failed: ${err?.message}`, { err: marshalErrorLike(err) });

            throw new DownstreamServiceFailureError({ message: `Search failed` });
        }

    }

}
