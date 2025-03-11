import { singleton } from 'tsyringe';
import { AsyncService } from 'civkit/async-service';
import { ParamValidationError } from 'civkit/civ-rpc';
import { SecurityCompromiseError } from '../shared/lib/errors';
import { isIP } from 'node:net';
import { isIPInNonPublicRange } from '../utils/ip';
import { GlobalLogger } from './logger';
import { lookup } from 'node:dns/promises';
import { Threaded } from './threaded';

const normalizeUrl = require('@esm2cjs/normalize-url').default;

@singleton()
export class MiscService extends AsyncService {

    logger = this.globalLogger.child({ service: this.constructor.name });

    constructor(
        protected globalLogger: GlobalLogger,
    ) {
        super(...arguments);
    }

    override async init() {
        await this.dependencyReady();

        this.emit('ready');
    }

    @Threaded()
    async assertNormalizedUrl(input: string) {
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
        const isIp = isIP(normalizedHostname);
        if (
            (result.hostname === 'localhost') ||
            (isIp && isIPInNonPublicRange(normalizedHostname))
        ) {
            this.logger.warn(`Suspicious action: Request to localhost or non-public IP: ${normalizedHostname}`, { href: result.href });
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
                        this.logger.warn(`Suspicious action: Domain resolved to non-public IP: ${result.hostname} => ${x.address}`, { href: result.href, ip: x.address });
                        throw new SecurityCompromiseError({
                            message: `Suspicious action: Domain resolved to non-public IP: ${x.address}`,
                            path: 'url'
                        });
                    }
                }

            }
        }

        return result;
    }

}