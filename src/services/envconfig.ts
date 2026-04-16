import { container, singleton } from 'tsyringe';

export const SPECIAL_COMBINED_ENV_KEY = 'SECRETS_COMBINED';
const CONF_ENV = [
    'GCP_STORAGE_ACCESS_KEY',
    'GCP_STORAGE_SECRET_KEY',
    'GCP_STORAGE_REGION',

    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'OPENROUTER_API_KEY',

    'REPLICATE_API_KEY',
    'GOOGLE_AI_STUDIO_API_KEY',

    'THORDATA_PROXY_URL',
    'THORDATA_PROXY_URL_ALT',
    'THORDATA_SERP_API_KEY',

    'BRIGHTDATA_PROXY_URL',
    'BRIGHTDATA_ISP_PROXY_URL',
    'BRIGHTDATA_SERP_API_KEY',

    'SERPER_SEARCH_API_KEY',
    'BRAVE_SEARCH_API_KEY',
    'CLOUD_FLARE_API_KEY',

] as const;


@singleton()
export class EnvConfig {
    dynamic!: Record<string, string>;

    combined: Record<string, string> = {};
    originalEnv: Record<string, string | undefined> = { ...process.env };

    constructor() {
        if (process.env[SPECIAL_COMBINED_ENV_KEY]) {
            Object.assign(this.combined, JSON.parse(
                Buffer.from(process.env[SPECIAL_COMBINED_ENV_KEY]!, 'base64').toString('utf-8')
            ));
            delete process.env[SPECIAL_COMBINED_ENV_KEY];
        }

        // Static config
        for (const x of CONF_ENV) {
            const s = process.env[x] || this.combined[x] || '';
            Reflect.set(this, x, s);
            if (x in process.env) {
                delete process.env[x];
            }
        }

        // Dynamic config
        this.dynamic = new Proxy({
            get: (_target: any, prop: string) => {
                return this.combined[prop] || process.env[prop] || '';
            }
        }, {}) as any;
    }
}

// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface EnvConfig extends Record<typeof CONF_ENV[number], string> { }

const instance = container.resolve(EnvConfig);
export default instance;