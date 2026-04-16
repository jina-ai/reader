import { HTTPService } from 'civkit/http';
import _ from 'lodash';


export interface JinaWallet {
    trial_balance: number;
    trial_start: Date;
    trial_end: Date;
    regular_balance: number;
    total_balance: number;
}


export interface JinaUserBrief {
    user_id: string;
    email: string | null;
    full_name: string | null;
    customer_id: string | null;
    avatar_url?: string;
    billing_address: Partial<{
        address: string;
        city: string;
        state: string;
        country: string;
        postal_code: string;
    }>;
    payment_method: Partial<{
        brand: string;
        last4: string;
        exp_month: number;
        exp_year: number;
    }>;
    wallet: JinaWallet;
    metadata: {
        [k: string]: any;
    };
}

export interface JinaUsageReport {
    model_name: string;
    api_endpoint: string;
    consumer: {
        user_id: string;
        customer_plan?: string;
        [k: string]: any;
    };
    usage: {
        total_tokens: number;
    };
    labels: {
        user_type?: string;
        model_name?: string;
        [k: string]: any;
    };
}

export class JinaEmbeddingsDashboardHTTP extends HTTPService {
    name = 'JinaEmbeddingsDashboardHTTP';

    constructor(
        public apiKey: string,
        public baseUri: string = process.env.OVERRIDE_MANAGE_SERVER_URL || 'https://dash.jina.ai/api'
    ) {
        super(baseUri);

        this.baseOptions.timeout = 30_000;  // 30 sec
    }

    async authorization(token: string) {
        const r = await this.get<JinaUserBrief>('/v1/authorization', {
            headers: {
                Authorization: `Bearer ${token}`
            },
            responseType: 'json',
        });

        return r;
    }

    async validateToken(token: string) {
        const r = await this.getWithSearchParams<JinaUserBrief>('/v1/api_key/user', {
            api_key: token,
        }, {
            responseType: 'json',
        });

        return r;
    }

    async reportUsage(token: string, query: JinaUsageReport) {
        const r = await this.postJson('/v1/usage', query, {
            headers: {
                Authorization: `Bearer ${token}`,
                'x-api-key': this.apiKey,
            },
            responseType: 'text',
        });

        return r;
    }

}
