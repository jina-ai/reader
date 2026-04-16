import { HTTPService } from 'civkit/http';
import _ from 'lodash';

export class CloudFlareHTTP extends HTTPService {
    name = 'CloudFlare';

    constructor(public accountId: string, public apiToken: string) {
        super(`https://api.cloudflare.com/client/v4/accounts/${accountId}`);

        this.baseHeaders['Authorization'] = `Bearer ${apiToken}`;

        this.baseOptions.timeout = 1000 * 60 * 30 * 0.5;
    }

    fetchBrowserRenderedHTML(input: {
        url: string;
        rejectResourceTypes?: string[];
        rejectRequestPattern?: string[];
    }, opts?: typeof this['baseOptions']) {
        return this.postJson<{ success: true; result: string; }>('/browser-rendering/content', input, { responseType: 'json', ...opts });
    }
}
