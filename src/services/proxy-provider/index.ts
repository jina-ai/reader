import { singleton } from 'tsyringe';
import { EnvConfig } from '../envconfig';
import { ThorDataProxyProvider } from './thordata';
// import { BrightDataProxyProvider } from './brightdata';
import { AsyncService } from 'civkit/async-service';
import { randomPick } from 'civkit/random';
import { AssertionFailureError } from 'civkit/civ-rpc';


const TIER_1_ENGLISH_SPEAKING_COUNTRIES = ['us', 'ca', 'gb', 'au', 'nz', 'sg'];

interface ProxyProvider {
    alloc(inputCountryCode?: string): Promise<URL>;
    supports(countryCode: string): boolean;
}

@singleton()
export class ProxyProviderService extends AsyncService {
    clients: ProxyProvider[] = [];

    constructor(
        protected envConfig: EnvConfig,
    ) {
        super(...arguments);
    }

    override async init() {
        await this.dependencyReady();
        if (this.envConfig.THORDATA_PROXY_URL) {
            this.clients.push(new ThorDataProxyProvider(
                this.envConfig.THORDATA_PROXY_URL,
                this.envConfig.THORDATA_PROXY_URL_ALT // optional
            ));
        }
        // if (this.envConfig.BRIGHTDATA_PROXY_URL) {
        //     this.clients.push(new BrightDataProxyProvider(this.envConfig.BRIGHTDATA_PROXY_URL));
        // }
        // if (this.envConfig.BRIGHTDATA_ISP_PROXY_URL) {
        //     this.clients.push(new BrightDataProxyProvider(this.envConfig.BRIGHTDATA_ISP_PROXY_URL));
        // }

        this.emit('ready');
    }

    supports(countryCode: string) {
        const normalized = countryCode.toLowerCase();
        return this.clients.some((client) => client.supports(normalized));
    }

    async alloc(inputCountryCode?: string) {
        let countryCode = inputCountryCode?.toLowerCase() || 'any';
        if (countryCode === 'true' || countryCode === 'auto') {
            countryCode = 'any';
        }
        if (countryCode === 'any') {
            countryCode = process.env.PREFERRED_PROXY_COUNTRY || randomPick(TIER_1_ENGLISH_SPEAKING_COUNTRIES);
        }

        const someClient = this.clients.find((client) => client.supports(countryCode));

        if (!someClient) {
            throw new AssertionFailureError(`No proxy provider found that supports the country code: ${countryCode}.`);
        }

        return someClient.alloc(countryCode);
    }

    *loopClients() {
        if  (!this.clients.length) {
            throw new AssertionFailureError('No proxy provider found.');
        }
        while (true) {
            yield* this.clients;
        }
    }

    async *iterAlloc(inputCountryCode?: string, maxAttempt = Infinity): AsyncGenerator<URL> {
        let countryCode = inputCountryCode?.toLowerCase() || 'any';
        if (countryCode === 'true' || countryCode === 'auto') {
            countryCode = 'any';
        }
        if (countryCode === 'any') {
            countryCode = randomPick(TIER_1_ENGLISH_SPEAKING_COUNTRIES);
        }

        if (!this.supports(countryCode)) {
            return;
        }

        let i = 0;

        for (const client of this.loopClients()) {
            if (i > maxAttempt) {
                break;
            }
            if (!client.supports(countryCode)) {
                continue;
            }
            const url = await client.alloc(inputCountryCode);
            yield url;
            i += 1;
        }
    }

}

@singleton()
export class SERPProxyProviderService extends ProxyProviderService {

    override async init() {
        await this.dependencyReady();

        if (this.envConfig.THORDATA_PROXY_URL) {
            this.clients.push(new ThorDataProxyProvider(
                this.envConfig.THORDATA_PROXY_URL,
                this.envConfig.THORDATA_PROXY_URL_ALT // optional
            ));
        }


        this.emit('ready');
    }
}