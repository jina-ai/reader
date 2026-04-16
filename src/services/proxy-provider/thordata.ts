import { ParamValidationError } from 'civkit/civ-rpc';
import { randomPick } from 'civkit/random';
import { randomBytes } from 'crypto';

const COUNTRY_SERVER_MAP = new Map([
    ["any", "pr"], ["us", "na"], ["hn", "na"], ["gt", "na"], ["bb", "na"], ["mq", "na"], ["cw", "na"], ["ca", "na"], ["cu", "na"], ["jm", "na"], ["mx", "na"], ["pa", "na"], ["tt", "na"], ["do", "na"], ["sv", "na"], ["pr", "na"], ["cr", "na"], ["ni", "na"], ["lc", "na"], ["bz", "na"], ["gd", "na"], ["ag", "na"], ["ht", "na"], ["bs", "na"], ["vc", "na"], ["dm", "na"], ["ky", "na"], ["gb", "eu"], ["fr", "eu"], ["ru", "eu"], ["al", "eu"], ["rs", "eu"], ["ba", "eu"], ["me", "eu"], ["xk", "eu"], ["dk", "eu"], ["si", "eu"], ["it", "eu"], ["se", "eu"], ["de", "eu"], ["lu", "eu"], ["by", "eu"], ["be", "eu"], ["at", "eu"], ["es", "eu"], ["ie", "eu"], ["fi", "eu"], ["pt", "eu"], ["lv", "eu"], ["pl", "eu"], ["lt", "eu"], ["hu", "eu"], ["md", "eu"], ["nl", "eu"], ["ch", "eu"], ["cz", "eu"], ["no", "eu"], ["is", "eu"], ["gr", "eu"], ["mt", "eu"], ["ee", "eu"], ["ua", "eu"], ["hr", "eu"], ["mk", "eu"], ["sk", "eu"], ["ro", "eu"], ["bg", "eu"], ["je", "eu"], ["ad", "eu"], ["in", "as"], ["id", "as"], ["jp", "as"], ["kr", "as"], ["hk", "as"], ["ph", "as"], ["sg", "as"], ["vn", "as"], ["bn", "as"], ["mn", "as"], ["la", "as"], ["mm", "as"], ["th", "as"], ["my", "as"], ["tw", "as"], ["bd", "as"], ["bt", "as"], ["mv", "as"], ["np", "as"], ["pk", "as"], ["lk", "as"], ["bh", "as"], ["kw", "as"], ["om", "as"], ["qa", "as"], ["sa", "as"], ["ae", "as"], ["ye", "as"], ["cy", "as"], ["iq", "as"], ["il", "as"], ["jo", "as"], ["lb", "as"], ["ps", "as"], ["sy", "as"], ["af", "as"], ["am", "as"], ["az", "as"], ["ir", "as"], ["tr", "as"], ["kz", "as"], ["kg", "as"], ["tj", "as"], ["tm", "as"], ["uz", "as"], ["ge", "as"], ["mo", "as"], ["kh", "as"], ["bo", "na"], ["gy", "na"], ["sr", "na"], ["br", "na"], ["ar", "na"], ["co", "na"], ["cl", "na"], ["ve", "na"], ["pe", "na"], ["ec", "na"], ["py", "na"], ["uy", "na"], ["aw", "na"], ["fj", "eu"], ["nz", "eu"], ["au", "na"], ["gu", "eu"], ["pg", "eu"], ["pf", "eu"], ["ma", "na"], ["tn", "na"], ["eg", "na"], ["ga", "na"], ["bf", "na"], ["cg", "na"], ["ly", "na"], ["bw", "na"], ["tg", "na"], ["so", "na"], ["tz", "na"], ["ug", "na"], ["zw", "na"], ["rw", "na"], ["mu", "na"], ["na", "na"], ["cd", "na"], ["cm", "na"], ["zm", "na"], ["mr", "na"], ["sc", "na"], ["bj", "na"], ["mw", "na"], ["ls", "na"], ["gn", "na"], ["cv", "na"], ["mg", "na"], ["mz", "na"], ["za", "na"], ["et", "na"], ["ke", "na"], ["gh", "na"], ["ng", "na"], ["dz", "na"], ["ml", "na"], ["sn", "na"], ["ao", "na"], ["gm", "na"], ["sz", "na"], ["sd", "na"], ["dj", "na"], ["sl", "na"], ["lr", "na"], ["bi", "na"], ["gw", "na"], ["ne", "na"]
]);

const TIER_1_ENGLISH_SPEAKING_COUNTRIES = ['us', 'ca', 'gb', 'au', 'nz', 'sg'];

const ALT_COUNTRIES = new Set(['HN', 'GT', 'JM', 'MX', 'PA', 'DO', 'SV', 'CR', 'NI', 'RU', 'AL', 'RS', 'BA', 'XK', 'BY', 'AT', 'MD', 'CZ', 'GR', 'UA', 'MK', 'BG', 'BN', 'MN', 'BD', 'NP', 'PK', 'LK', 'BH', 'KW', 'OM', 'QA', 'AE', 'IQ', 'IL', 'LB', 'JO', 'PS', 'SY', 'AM', 'AZ', 'IR', 'TR', 'KZ', 'UZ', 'GE', 'KH', 'BO', 'GY', 'BR', 'AR', 'CO', 'CL', 'VE', 'PE', 'EC', 'PY', 'UY', 'MA', 'TN', 'EG', 'GA', 'CG', 'BW', 'TG', 'ZA', 'KE', 'NG', 'DZ', 'ML', 'SN', 'AO'].map((x) => x.toLowerCase()));
const RANDOM_ALT_COUNTRIES = ['mx', 'at', 'cz', 'gr', 'kw', 'qa', 'ae', 'tr'];

export class ThorDataProxyProvider {
    baseProxyUrl!: URL;
    altProxyUrl?: URL;

    sessionTTLMinutes: number = 35;

    constructor(residential: string, unlimited?: string) {
        this.baseProxyUrl = new URL(residential);
        if (unlimited) {
            this.altProxyUrl = new URL(unlimited);
        }
    }

    supports(countryCode: string) {
        return COUNTRY_SERVER_MAP.has(countryCode);
    }

    async alloc(inputCountryCode?: string, stickyTimeoutMins: number = this.sessionTTLMinutes) {
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

        if (this.altProxyUrl && (countryCode === 'any' || ALT_COUNTRIES.has(countryCode))) {
            if (countryCode === 'any') {
                countryCode = randomPick(RANDOM_ALT_COUNTRIES);
            }
            const user = this.getUserName(countryCode, this.altProxyUrl.username, stickyTimeoutMins);

            const url = new URL(this.altProxyUrl);
            url.username = user;

            return url;
        }

        if (countryCode === 'any') {
            countryCode = randomPick(TIER_1_ENGLISH_SPEAKING_COUNTRIES);
        }

        const srv = COUNTRY_SERVER_MAP.get(countryCode);
        if (!srv) {
            throw new ParamValidationError({
                path: 'proxy',
                message: `Country code ${countryCode.toUpperCase()} is not supported.`,
            });
        }

        const user = this.getUserName(countryCode, this.baseProxyUrl.username, stickyTimeoutMins);
        const dv = this.baseProxyUrl.hostname.split('.');
        dv.splice(1, 0, srv);

        const url = new URL(`${this.baseProxyUrl.protocol}//${dv.join('.')}`);
        url.username = user;
        url.password = this.baseProxyUrl.password;
        url.port = this.baseProxyUrl.port;
        url.pathname = this.baseProxyUrl.pathname;
        url.search = this.baseProxyUrl.search;

        return url;
    }

    protected getUserName(countryCode: string, username: string, stickyTimeoutMins: number) {
        const dyNameChunks = ['td-customer', username];

        if (countryCode !== 'any') {
            dyNameChunks.push(`country-${countryCode}`);
        }

        if (stickyTimeoutMins > 0) {
            const randomStr = randomBytes(16).toString('hex');
            dyNameChunks.push(`sessid-${countryCode}${randomStr}`);
            dyNameChunks.push(`sesstime-${stickyTimeoutMins}`);
        }
        return dyNameChunks.join('-');
    }

}
