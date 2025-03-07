import { container, singleton } from 'tsyringe';
import { AsyncService } from 'civkit/async-service';
import { Logger, SecretExposer } from '../shared';
import { CloudFlareHTTP } from '../shared/3rd-party/cloud-flare';

@singleton()
export class CFBrowserRendering extends AsyncService {

    logger = this.globalLogger.child({ service: this.constructor.name });
    client!: CloudFlareHTTP;

    constructor(
        protected globalLogger: Logger,
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
        const r = await this.client.fetchBrowserRenderedHTML({ url });

        return r.parsed.result;
    }

}

const instance = container.resolve(CFBrowserRendering);

export default instance;
