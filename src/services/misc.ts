import { singleton } from 'tsyringe';
import { AsyncService } from 'civkit/async-service';
import { ParamValidationError } from 'civkit/civ-rpc';
import { isIP } from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import { isIPInNonPublicRange } from '../utils/ip';
import { GlobalLogger } from './logger';
import { Threaded } from './threaded';
import { SecurityCompromiseError } from './errors';
import { GeoIPService } from './geoip';
import _ from 'lodash';

const normalizeUrl = require('@esm2cjs/normalize-url').default;

export const privateIpNotAcceptable = Boolean(process.env['NODE_ENV']?.toLowerCase()?.includes('prod') && process.env['GCLOUD_PROJECT']);

export type DnsLookupAll = (hostname: string, options: { all: true }) => Promise<LookupAddress[]>;

export type AssertNormalizedUrlContext = {
    logger: { warn: (msg: string, extra?: Record<string, unknown>) => void };
    geoIpService: { lookupCities: (ips: string[]) => Promise<Array<{ country?: { code?: string } }>> };
    lookup?: DnsLookupAll;
};

/**
 * Core URL normalization + SSRF checks. Kept undecorated so unit tests can inject
 * a DNS lookup without going through the @Threaded worker pool.
 */
export async function assertNormalizedUrlImpl(input: string, ctx: AssertNormalizedUrlContext) {
    const lookup = ctx.lookup ?? ((hostname: string, options: { all: true }) => dnsLookup(hostname, options));
    let result: URL;
    try {
        result = new URL(
            normalizeUrl(
                input,
                {
                    stripWWW: false,
                    removeTrailingSlash: false,
                    removeSingleSlash: false,
                    sortQueryParameters: false,
                }
            )
        );
    } catch (err) {
        throw new ParamValidationError({
            message: `${err}`,
            path: 'url'
        });
    }

    if (!['http:', 'https:', 'blob:'].includes(result.protocol)) {
        throw new ParamValidationError({
            message: `Invalid protocol ${result.protocol}`,
            path: 'url'
        });
    }

    const normalizedHostname = result.hostname.startsWith('[') ? result.hostname.slice(1, -1) : result.hostname;
    let ips: string[] = [];
    const isIp = isIP(normalizedHostname);
    if (isIp) {
        ips.push(normalizedHostname);
    }
    if (
        privateIpNotAcceptable &&
        (result.hostname === 'localhost') ||
        (isIp && isIPInNonPublicRange(normalizedHostname))
    ) {
        ctx.logger.warn(`Suspicious action: Request to localhost or non-public IP: ${normalizedHostname}`, { href: result.href });
        throw new SecurityCompromiseError({
            message: `Suspicious action: Request to localhost or non-public IP: ${normalizedHostname}`,
            path: 'url'
        });
    }
    if (!isIp && result.protocol !== 'blob:') {
        const resolved = await lookup(result.hostname, { all: true }).catch((err) => {
            if (err.code === 'ENOTFOUND') {
                return Promise.reject(new ParamValidationError({
                    message: `Domain '${result.hostname}' could not be resolved`,
                    path: 'url'
                }));
            }

            return;
        });
        if (resolved) {
            for (const x of resolved) {
                if (isIPInNonPublicRange(x.address)) {
                    ctx.logger.warn(`Suspicious action: Domain resolved to non-public IP: ${result.hostname} => ${x.address}`, { href: result.href, ip: x.address });
                    throw new SecurityCompromiseError({
                        message: `Suspicious action: Domain resolved to non-public IP: ${x.address}`,
                        path: 'url'
                    });
                }
                ips.push(x.address);
            }

        }
    }

    let hintCountry: string | undefined;
    if (ips.length) {
        const hints = await ctx.geoIpService.lookupCities(ips);
        const board: Record<string, number> = {};
        for (const x of hints) {
            if (x.country?.code) {
                board[x.country.code] = (board[x.country.code] || 0) + 1;
            }
        }
        hintCountry = _.maxBy(Array.from(Object.entries(board)), 1)?.[0];
    }

    return {
        url: result,
        ips,
        hintCountry,
    };
}

@singleton()
export class MiscService extends AsyncService {

    logger = this.globalLogger.child({ service: this.constructor.name });

    constructor(
        protected globalLogger: GlobalLogger,
        protected geoIpService: GeoIPService,
    ) {
        super(...arguments);
    }

    override async init() {
        await this.dependencyReady();

        this.emit('ready');
    }

    @Threaded()
    async assertNormalizedUrl(input: string) {
        return assertNormalizedUrlImpl(input, {
            logger: this.logger,
            geoIpService: this.geoIpService,
        });
    }

}
