import { container, singleton } from 'tsyringe';
import { AsyncService } from 'civkit/async-service';
import { SecretExposer } from '../shared/services/secrets';
import { GlobalLogger } from './logger';
import { CloudFlareHTTP } from '../shared/3rd-party/cloud-flare';
import { HTTPServiceError } from 'civkit/http';
import { ServiceNodeResourceDrainError } from './errors';

@singleton()
export class CFBrowserRendering extends AsyncService {

    logger = this.globalLogger.child({ service: this.constructor.name });
    client!: CloudFlareHTTP;

    constructor(
        protected globalLogger: GlobalLogger,
        protected secretExposer: SecretExposer,
    ) {
        super(...arguments);
    }


    override async init() {
        await this.dependencyReady();
        const [account, key] = this.secretExposer.CLOUD_FLARE_API_KEY?.split(':');
        this.client = new CloudFlareHTTP(account, key);

        this.emit('ready');
    }

    async fetchContent(url: string) {
        try {
            const r = await this.client.fetchBrowserRenderedHTML({ url });

            return r.parsed.result;
        } catch (err) {
            if (err instanceof HTTPServiceError) {
                if (err.status === 429) {
                    // Rate limit exceeded, return empty result
                    this.logger.warn('Cloudflare browser rendering rate limit exceeded', { url });

                    throw new ServiceNodeResourceDrainError(`Cloudflare browser rendering (our account) is at capacity, please try again later or switch to another engine.`,);
                }
            }

            throw err;
        }
    }

}

const instance = container.resolve(CFBrowserRendering);

export default instance;
