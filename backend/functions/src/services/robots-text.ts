import { singleton } from 'tsyringe';
import { DownstreamServiceFailureError, ResourcePolicyDenyError } from 'civkit/civ-rpc';
import { AsyncService } from 'civkit/async-service';
import { HashManager } from 'civkit/hash';
import { marshalErrorLike } from 'civkit/lang';

import { Logger } from '../shared/services/logger';
import { BraveSearchHTTP } from '../shared/3rd-party/brave-search';
import { FirebaseStorageBucketControl } from '../shared';
import { URL } from 'url';
import { Threaded } from '../services/threaded';


export const md5Hasher = new HashManager('md5', 'hex');

@singleton()
export class RobotsTxtService extends AsyncService {

    logger = this.globalLogger.child({ service: this.constructor.name });

    braveSearchHTTP!: BraveSearchHTTP;

    constructor(
        protected globalLogger: Logger,
        protected firebaseStorageBucketControl: FirebaseStorageBucketControl,
    ) {
        super(...arguments);
    }

    override async init() {
        await this.dependencyReady();
        this.emit('ready');
    }

    async getCachedRobotTxt(origin: string) {
        const digest = md5Hasher.hash(origin.toLowerCase());
        const cacheLoc = `/robot-txt/${digest}`;
        let buff;
        buff = await this.firebaseStorageBucketControl.downloadFile(cacheLoc).catch(() => undefined);
        if (buff) {
            return buff.toString();
        }

        const r = await fetch(new URL('robots.txt', origin).href, { signal: AbortSignal.timeout(5000) });
        if (!r.ok) {
            throw new DownstreamServiceFailureError(`Failed to fetch robots.txt from ${origin}`);
        }
        buff = Buffer.from(await r.arrayBuffer());

        this.firebaseStorageBucketControl.saveFile(cacheLoc, buff, {
            contentType: 'text/plain'
        }).catch((err) => {
            this.logger.warn(`Failed to save robots.txt to cache: ${err}`, { err: marshalErrorLike(err) });
        });

        return buff.toString();
    }

    @Threaded()
    async assertAccessAllowed(url: URL, inputMyUa = '*') {
        let robotTxt: string = '';
        try {
            robotTxt = await this.getCachedRobotTxt(url.origin);
        } catch (err) {
            if (err instanceof DownstreamServiceFailureError) {
                return true;
            }
            throw err;
        }
        const myUa = inputMyUa.toLowerCase();
        const lines = robotTxt.split(/\r?\n/g);

        let currentUa = myUa || '*';
        let uaLine = 'User-Agent: *';
        const pathNormalized = `${url.pathname}?`;

        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith('#') || !trimmed) {
                continue;
            }
            const [k, ...rest] = trimmed.split(':');
            const key = k.trim().toLowerCase();
            const value = rest.join(':').trim();

            if (key === 'user-agent') {
                currentUa = value.toLowerCase();
                if (value === '*') {
                    currentUa = myUa;
                }
                uaLine = line;
                continue;
            }

            if (currentUa !== myUa) {
                continue;
            }

            if (key === 'disallow') {
                if (!value) {
                    return true;
                }
                if (value.includes('*')) {
                    const [head, tail] = value.split('*');
                    if (url.pathname.startsWith(head) && url.pathname.endsWith(tail)) {
                        throw new ResourcePolicyDenyError(`Access to ${url.href} is disallowed by site robots.txt: For ${uaLine}, ${line}`);
                    }
                } else if (pathNormalized.startsWith(value)) {
                    throw new ResourcePolicyDenyError(`Access to ${url.href} is disallowed by site robots.txt: For ${uaLine}, ${line}`);
                }

                continue;
            }

            if (key === 'allow') {
                if (!value) {
                    return true;
                }
                if (pathNormalized.startsWith(value)) {
                    return true;
                }
                continue;
            }
        }

        return true;
    }

}
