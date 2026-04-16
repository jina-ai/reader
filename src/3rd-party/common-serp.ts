import { HTTPService, HTTPServiceRequestOptions } from 'civkit/http';
import _ from 'lodash';
import { Agent, RetryAgent } from 'undici';
import secretExposer from '../services/envconfig';
import { parseJSONText } from 'civkit/vectorize';

export interface CommonSerpWebResponse {
    organic: {
        title: string;
        link: string;
        description: string;
        display_link?: string;
        siteLinks?: { title: string; link: string; }[];
        position: number,
    }[];
}
export interface CommonSerpImageResponse {
    images: {
        title: string;
        image: string;
        link: string;
        source?: string;
        image_alt?: string;
    }[];
}
export interface CommonSerpNewsResponse {
    news: {
        title: string;
        link: string;
        date?: string;
        description?: string;
        image?: string;
        source?: string;
    }[];
}

export type CommonSerpSearchResponse = CommonSerpWebResponse | CommonSerpImageResponse | CommonSerpNewsResponse;

export abstract class CommonSerpBaseHTTP extends HTTPService {

    get name() {
        return this.constructor.name;
    }

    abstract queryJSON(url: string, opts?: typeof this['baseOptions']): Promise<CommonSerpSearchResponse>;
    abstract queryHTML(url: string, opts?: typeof this['baseOptions']): Promise<string>;
}

// For retry of `Retry-After` header
const overrideAgent = new RetryAgent(
    new Agent({
        allowH2: true
    }),
    {
        statusCodes: [429, 503, 500],
        maxRetries: 3,
        retryAfter: true,
        minTimeout: 200,
    }
);


export class ThorDataSerp extends CommonSerpBaseHTTP {
    constructor(public apiKey: string) {
        super('https://scraperapi.thordata.com');

        Reflect.set(this.baseOptions, 'dispatcher', overrideAgent);
    }

    async queryJSON(url: string, opts?: this['baseOptions'] | undefined) {
        const parsed = new URL(url);
        parsed.searchParams.set('json', '1');
        const r = await this.postJson('/request', {
            url: parsed.href,
        }, {
            ...opts,
            responseType: 'json',
            headers: {
                ...opts?.headers,
                'Authorization': `Bearer ${this.apiKey}`,
                // This is wrong but the server expects it
                'Content-Type': 'application/json',
            }
        });

        return r.parsed.data.result;
    }

    async queryHTML(url: string, opts?: this['baseOptions'] | undefined) {
        const parsed = new URL(url);
        parsed.searchParams.set('json', '0');
        const r = await this.postJson('/request', {
            url: parsed.href,
        }, {
            ...opts,
            responseType: 'json',
            headers: {
                ...opts?.headers,
                'Authorization': `Bearer ${this.apiKey}`,
                // This is wrong but the server expects it
                'Content-Type': 'text/html',
            }
        });

        return r.parsed.html;
    }

    override async __processResponse(options: HTTPServiceRequestOptions, r: Response): Promise<any> {
        if (r.status !== 200) {
            throw await r.json();
        }

        return super.__processResponse(options, r);
    }
}

export class BrightDataSerp extends CommonSerpBaseHTTP {
    public apiKey: string;
    public zone = 'serp_api1';
    constructor(apiKey: string) {
        super('https://api.brightdata.com');

        this.apiKey = apiKey.split(':')[0];
        this.zone = apiKey.split(':')[1] || this.zone;

        Reflect.set(this.baseOptions, 'dispatcher', overrideAgent);
    }

    async queryJSON(url: string, opts?: this['baseOptions'] | undefined) {
        const parsed = new URL(url);
        parsed.searchParams.set('brd_json', '1');
        const r = await this.postJson('/request', {
            url: parsed.href,
            zone: this.zone,
            format: 'json'
        }, {
            ...opts,
            responseType: 'json',
            headers: {
                ...opts?.headers,
                'Authorization': `Bearer ${this.apiKey}`,
            }
        });

        return parseJSONText(r.parsed.body);
    }

    async queryHTML(url: string, opts?: this['baseOptions'] | undefined) {
        const parsed = new URL(url);
        parsed.searchParams.set('json', '0');
        const r = await this.postJson('/request', {
            url: parsed.href,
            zone: this.zone,
            format: 'raw'
        }, {
            ...opts,
            responseType: 'json',
            headers: {
                ...opts?.headers,
                'Authorization': `Bearer ${this.apiKey}`,
                // This is wrong but the server expects it
                'Content-Type': 'text/html',
            }
        });

        return r.parsed.body;
    }
}

export const commonSerpClients: CommonSerpBaseHTTP[] = [];

if (secretExposer.THORDATA_SERP_API_KEY) {
    commonSerpClients.push(new ThorDataSerp(secretExposer.THORDATA_SERP_API_KEY));
}
if (secretExposer.BRIGHTDATA_SERP_API_KEY) {
    commonSerpClients.push(new BrightDataSerp(secretExposer.BRIGHTDATA_SERP_API_KEY));
}

export default commonSerpClients;