import { AsyncService, AutoCastable, DownstreamServiceFailureError, Prop, RPC_CALL_ENVIRONMENT, delay, marshalErrorLike } from 'civkit';
import { singleton } from 'tsyringe';
import { Logger } from '../shared/services/logger';
import { SecretExposer } from '../shared/services/secrets';
import { BraveSearchHTTP, WebSearchQueryParams } from '../shared/3rd-party/brave-search';
import { GEOIP_SUPPORTED_LANGUAGES, GeoIPService } from './geoip';
import { AsyncContext } from '../shared';
import { WebSearchOptionalHeaderOptions } from '../shared/3rd-party/brave-types';
import type { Request, Response } from 'express';

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
                extraHeaders['X-Loc-City'] = encodeURIComponent(geoip.city);
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
                extraHeaders['X-Loc-State'] = encodeURIComponent(`${geoip.subdivisions[0].code}`);
                extraHeaders['X-Loc-State-Name'] = encodeURIComponent(`${geoip.subdivisions[0].name}`);
            }
        }
        if (this.threadLocal.get('userAgent')) {
            extraHeaders['User-Agent'] = this.threadLocal.get('userAgent');
        }

        const encoded = { ...query };
        if (encoded.q) {
            encoded.q = (Buffer.from(encoded.q).toString('ascii') === encoded.q) ? encoded.q : encodeURIComponent(encoded.q);
        }

        let maxTries = 11;

        while (maxTries--) {
            try {
                const r = await this.braveSearchHTTP.webSearch(encoded, { headers: extraHeaders as Record<string, string> });

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


export class BraveSearchExplicitOperatorsDto extends AutoCastable {
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
        desc: `Returns web pages containing the specified term in the body of the page. Example: to find information about the Nvidia GeForce GTX 1080 Ti, making sure the page contains the keywords “founders edition” in the body, type “nvidia 1080 ti inbody:“founders edition””.`
    })
    inbody?: string | string[];

    @Prop({
        arrayOf: String,
        desc: `Returns webpages containing the specified term in the title of the page. Example: to find pages about SEO conferences making sure the results contain 2023 in the title, type “seo conference intitle:2023”.`
    })
    intitle?: string | string[];

    @Prop({
        arrayOf: String,
        desc: `Returns webpages containing the specified term either in the title or in the body of the page. Example: to find pages about the 2024 Oscars containing the keywords “best costume design” in the page, type “oscars 2024 inpage:“best costume design””.`
    })
    inpage?: string | string[];

    @Prop({
        arrayOf: String,
        desc: `Returns web pages written in the specified language. The language code must be in the ISO 639-1 two-letter code format. Example: to find information on visas only in Spanish, type “visas lang:es”.`
    })
    lang?: string | string[];

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
        const instance = super.from(input) as BraveSearchExplicitOperatorsDto;
        const ctx = Reflect.get(input, RPC_CALL_ENVIRONMENT) as {
            req: Request,
            res: Response,
        } | undefined;

        const params = ['ext', 'filetype', 'inbody', 'intitle', 'inpage', 'lang', 'loc', 'site'];

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
