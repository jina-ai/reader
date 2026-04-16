import { randomPick } from 'civkit/random';
import { randomBytes } from 'crypto';


const TIER_1_ENGLISH_SPEAKING_COUNTRIES = ['us', 'ca', 'gb', 'au', 'nz', 'sg'];

export class BrightDataProxyProvider {
    baseProxyUrl!: URL;

    constructor(residential: string) {
        this.baseProxyUrl = new URL(residential);
    }

    supports(countryCode: string) {
        if (['cn', 'hk', 'mo'].includes(countryCode.toLowerCase())) {
            return true;
        }
        if (TIER_1_ENGLISH_SPEAKING_COUNTRIES.includes(countryCode.toLowerCase())) {
            return true;
        }

        return false;
    }

    async alloc(inputCountryCode?: string) {
        if (!this.baseProxyUrl) {
            throw new Error(`Proxy provider not available`);
        }
        if (inputCountryCode === 'none') {
            throw new Error(`Proxy opted-out`);
        }
        let countryCode = inputCountryCode?.toLowerCase() || 'any';
        if (countryCode === 'true' || countryCode === 'auto') {
            countryCode = 'any';
        }

        if (countryCode === 'any') {
            countryCode = randomPick(TIER_1_ENGLISH_SPEAKING_COUNTRIES);
        }

        const user = this.getUserName(countryCode, this.baseProxyUrl.username);

        const url = new URL(this.baseProxyUrl);
        url.username = user;

        return url;
    }

    protected getUserName(countryCode: string, username: string) {
        const dyNameChunks = ['brd-customer', username];

        if (countryCode !== 'any') {
            dyNameChunks.push(`country-${countryCode}`);
        }

        dyNameChunks.push(`session-${randomBytes(16).toString('hex')}`);

        dyNameChunks.push('route_err-block');

        return dyNameChunks.join('-');
    }

}
