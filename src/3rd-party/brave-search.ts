import { Agent, RetryAgent } from 'undici';

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

export interface BraveWebResult {
    title: string;
    url: string;
    description?: string;
    profile?: { name?: string; };
    age?: string;
    thumbnail?: { src?: string; };
    extra_snippets?: string[];
}

export interface BraveWebSearchResponse {
    web?: {
        results?: BraveWebResult[];
    };
}

export interface BraveNewsResult {
    title: string;
    url: string;
    description?: string;
    source?: { name?: string; };
    age?: string;
    thumbnail?: { src?: string; };
}

export interface BraveNewsSearchResponse {
    results?: BraveNewsResult[];
}

export interface BraveImageResult {
    title: string;
    url: string;
    thumbnail?: { src?: string; width?: number; height?: number; };
    properties?: { url?: string; };
    source?: string;
}

export interface BraveImageSearchResponse {
    results?: BraveImageResult[];
}

export class BraveSearchHTTP {
    name = 'BraveSearch';
    baseUrl = 'https://api.search.brave.com/res/v1';

    constructor(public apiKey: string) { }

    private async getJson<T>(path: string, params: Record<string, string | number | undefined>): Promise<T> {
        const url = new URL(`${this.baseUrl}${path}`);
        for (const [k, v] of Object.entries(params)) {
            if (v !== undefined && v !== null && v !== '') {
                url.searchParams.set(k, `${v}`);
            }
        }

        const response = await fetch(url.href, {
            headers: {
                'Accept': 'application/json',
                'Accept-Encoding': 'gzip',
                'X-Subscription-Token': this.apiKey,
            },
            // @ts-ignore
            dispatcher: overrideAgent,
        });

        if (!response.ok) {
            throw new Error(`Brave Search API error: ${response.status} ${response.statusText}`);
        }

        return response.json() as Promise<T>;
    }

    async webSearch(params: {
        q: string;
        count?: number;
        country?: string;
        search_lang?: string;
        offset?: number;
        safesearch?: 'off' | 'moderate' | 'strict';
    }): Promise<BraveWebSearchResponse> {
        return this.getJson<BraveWebSearchResponse>('/web/search', {
            q: params.q,
            count: params.count,
            country: params.country,
            search_lang: params.search_lang,
            offset: params.offset,
            safesearch: params.safesearch,
        });
    }

    async newsSearch(params: {
        q: string;
        count?: number;
        country?: string;
        search_lang?: string;
        offset?: number;
    }): Promise<BraveNewsSearchResponse> {
        return this.getJson<BraveNewsSearchResponse>('/news/search', {
            q: params.q,
            count: params.count,
            country: params.country,
            search_lang: params.search_lang,
            offset: params.offset,
        });
    }

    async imageSearch(params: {
        q: string;
        count?: number;
        country?: string;
        search_lang?: string;
        offset?: number;
        safesearch?: 'off' | 'moderate' | 'strict';
    }): Promise<BraveImageSearchResponse> {
        return this.getJson<BraveImageSearchResponse>('/images/search', {
            q: params.q,
            count: params.count,
            country: params.country,
            search_lang: params.search_lang,
            offset: params.offset,
            safesearch: params.safesearch,
        });
    }
}
