import { singleton } from 'tsyringe';
import { AssertionFailureError,  DownstreamServiceFailureError } from 'civkit/civ-rpc';
import { AsyncService } from 'civkit/async-service';
import { HashManager } from 'civkit/hash';
import { marshalErrorLike } from 'civkit/lang';

import { Logger } from '../shared/services/logger';
import { BraveSearchHTTP } from '../shared/3rd-party/brave-search';
import { FirebaseStorageBucketControl } from '../shared';
import { URL } from 'url';


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
        if (await this.firebaseStorageBucketControl.fileExists(cacheLoc).catch(() => false)) {
            buff = await this.firebaseStorageBucketControl.downloadFile(cacheLoc);

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

    async assertAccessAllowed(url: URL, myUa = '*') {
        const robotTxt = await this.getCachedRobotTxt(url.origin);

        const lines = robotTxt.split('\n');

        let currentUa = myUa || '*';

        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith('#') || !trimmed){
                continue;
            }
            const [k, ...rest] = trimmed.split(':');
            const key = k.trim().toLowerCase();
            const value = rest.join(':').trim();

            if (key === 'user-agent') {
                currentUa = value;
                if (value === '*') {
                    currentUa = myUa;
                }
                continue;
            }

            if (currentUa !== myUa) {
                continue;
            }

            if (key === 'disallow') {
                if (url.pathname.startsWith(value)) {
                    throw new AssertionFailureError(`Access to ${url.href} is disallowed by robots.txt: (${line})`);
                }
                continue;
            }

            if (key === 'allow') {
                if (url.pathname.startsWith(value)) {
                    return true;
                }
                continue;
            }
        }

        return true;
    }

}
