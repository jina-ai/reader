import { AsyncService, AutoCastable, DownstreamServiceFailureError, Prop, RPC_CALL_ENVIRONMENT, delay, marshalErrorLike } from 'civkit';
import type { Request, Response } from 'express';
import { singleton } from 'tsyringe';
import { Logger } from '../shared/services/logger';
import { SecretExposer } from '../shared/services/secrets';
import { GEOIP_SUPPORTED_LANGUAGES, GeoIPService } from './geoip';
import { AsyncContext } from '../shared';
import { SerperGoogleHTTP, SerperSearchQueryParams, WORLD_COUNTRIES } from '../shared/3rd-party/serper-search';

@singleton()
export class SerperSearchService extends AsyncService {

    logger = this.globalLogger.child({ service: this.constructor.name });

    serperSearchHTTP!: SerperGoogleHTTP;

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

        this.serperSearchHTTP = new SerperGoogleHTTP(this.secretExposer.SERPER_SEARCH_API_KEY);
    }

    async webSearch(query: SerperSearchQueryParams) {
        const ip = this.threadLocal.get('ip');
        if (ip) {
            const geoip = await this.geoipControl.lookupCity(ip, GEOIP_SUPPORTED_LANGUAGES.EN);
            const locationChunks = [];
            if (geoip?.city) {
                locationChunks.push(geoip.city);
            }
            if (geoip?.subdivisions?.length) {
                for (const x of geoip.subdivisions) {
                    locationChunks.push(x.name);
                }
            }
            if (geoip?.country) {
                const code = geoip.country.code?.toLowerCase();
                if (code && code.toUpperCase() in WORLD_COUNTRIES) {
                    query.gl ??= code;
                }
                locationChunks.push(geoip.country.name);
            }
            if (locationChunks.length) {
                query.location ??= locationChunks.join(', ');
            }
        }

        let maxTries = 3;

        while (maxTries--) {
            try {
                this.logger.debug(`Doing external search`, query);
                const r = await this.serperSearchHTTP.webSearch(query);

                return r.parsed;
            } catch (err: any) {
                this.logger.error(`Web search failed: ${err?.message}`, { err: marshalErrorLike(err) });
                if (err?.status === 429) {
                    await delay(500 + 1000 * Math.random());
                    continue;
                }

                throw new DownstreamServiceFailureError({ message: `Search failed` });
            }
        }

        throw new DownstreamServiceFailureError({ message: `Search failed` });
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
        const ctx = Reflect.get(input, RPC_CALL_ENVIRONMENT) as {
            req: Request,
            res: Response,
        } | undefined;

        const params = ['ext', 'filetype', 'intitle', 'loc', 'site'];

        for (const p of params) {
            const customValue = ctx?.req.get(`x-${p}`) || ctx?.req.get(`${p}`);
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
