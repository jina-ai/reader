import { AsyncService, DownstreamServiceFailureError } from 'civkit';
import { singleton } from 'tsyringe';
import { Logger } from '../shared/services/logger';
import { SecretExposer } from '../shared/services/secrets';
import { BraveSearchHTTP, WebSearchQueryParams } from '../shared/3rd-party/brave-search';
import { GEOIP_SUPPORTED_LANGUAGES, GeoIPService } from './geoip';
import { AsyncContext } from '../shared';
import { WebSearchOptionalHeaderOptions } from '../shared/3rd-party/brave-types';

@singleton()
export class BraveSearchService extends AsyncService {

    logger = this.globalLogger.child({ service: this.constructor.name });

    braveSearchHTTP!: BraveSearchHTTP;

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

        this.braveSearchHTTP = new BraveSearchHTTP(this.secretExposer.BRAVE_SEARCH_API_KEY);
    }

    async webSearch(query: WebSearchQueryParams) {
        const ip = this.threadLocal.get('ip');
        const extraHeaders: WebSearchOptionalHeaderOptions = {};
        if (ip) {
            const geoip = await this.geoipControl.lookupCity(ip, GEOIP_SUPPORTED_LANGUAGES.EN);

            if (geoip?.city) {
                extraHeaders['X-Loc-City'] = geoip.city;
            }
            if (geoip?.country) {
                extraHeaders['X-Loc-Country'] = geoip.country.code;
            }
            if (geoip?.timezone) {
                extraHeaders['X-Loc-Timezone'] = geoip.timezone;
            }
            if (geoip?.coordinates) {
                extraHeaders['X-Loc-Lat'] = `${geoip.coordinates[0]}`;
                extraHeaders['X-Loc-Long'] = `${geoip.coordinates[1]}`;
            }
            if (geoip?.subdivisions?.length) {
                extraHeaders['X-Loc-State'] = geoip.subdivisions[0].code;
                extraHeaders['X-Loc-State-Name'] = geoip.subdivisions[0].name;
            }
        }
        if (this.threadLocal.get('userAgent')) {
            extraHeaders['User-Agent'] = this.threadLocal.get('userAgent');
        }

        try {
            const r = await this.braveSearchHTTP.webSearch(query, { headers: extraHeaders as Record<string, string> });

            return r.parsed;
        } catch (err) {
            throw new DownstreamServiceFailureError({ message: `Search failed`, cause: err });
        }

    }

}
