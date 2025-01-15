import { marshalErrorLike } from 'civkit/lang';
import { AsyncService } from 'civkit/async-service';
import { singleton } from 'tsyringe';

import { Curl, HeaderInfo } from 'node-libcurl';
import { PageSnapshot, ScrappingOptions } from './puppeteer';
import { Logger } from '../shared/services/logger';
import { JSDomControl } from './jsdom';
import { AssertionFailureError } from 'civkit';

@singleton()
export class CurlControl extends AsyncService {

    logger = this.globalLogger.child({ service: this.constructor.name });

    constructor(
        protected globalLogger: Logger,
        protected jsdomControl: JSDomControl,
    ) {
        super(...arguments);
    }

    override async init() {
        await this.dependencyReady();

        this.emit('ready');
    }

    async urlToSnapshot(urlToCrawl: URL, crawlOpts?: ScrappingOptions) {
        const result = await new Promise<{
            statusCode: number,
            data: string,
            headers: Buffer | HeaderInfo[],
        }>((resolve, reject) => {
            const curl = new Curl();
            curl.setOpt('URL', urlToCrawl.toString());
            curl.setOpt(Curl.option.FOLLOWLOCATION, true);

            if (crawlOpts?.timeoutMs) {
                curl.setOpt(Curl.option.TIMEOUT_MS, crawlOpts.timeoutMs);
            }
            if (crawlOpts?.overrideUserAgent) {
                curl.setOpt(Curl.option.USERAGENT, crawlOpts.overrideUserAgent);
            }
            if (crawlOpts?.extraHeaders) {
                curl.setOpt(Curl.option.HTTPHEADER, Object.entries(crawlOpts.extraHeaders).map(([k, v]) => `${k}: ${v}`));
            }
            if (crawlOpts?.proxyUrl) {
                curl.setOpt(Curl.option.PROXY, crawlOpts.proxyUrl);
            }
            if (crawlOpts?.cookies?.length) {
                const cookieChunks = crawlOpts.cookies.map((cookie) => `${cookie.name}=${cookie.value}`);
                curl.setOpt(Curl.option.COOKIE, cookieChunks.join('; '));
            }
            if (crawlOpts?.referer) {
                curl.setOpt(Curl.option.REFERER, crawlOpts.referer);
            }

            curl.on('end', (statusCode, data, headers) => {
                this.logger.debug(`CURL: [${statusCode}] ${urlToCrawl}`, { statusCode, headers });
                resolve({
                    statusCode,
                    data: data.toString(),
                    headers,
                });
                curl.close();
            });

            curl.on('error', (err) => {
                this.logger.warn(`Failed to curl ${urlToCrawl}`, { err: marshalErrorLike(err) });
                curl.close();
                reject(new AssertionFailureError(`Failed to directly access ${urlToCrawl}: ${err.message}`));
            });

            curl.perform();
        });

        if (result.statusCode && (result.statusCode < 200 || result.statusCode >= 300)) {
            throw new AssertionFailureError(`Failed to directly access ${urlToCrawl}: HTTP ${result.statusCode}`);
        }

        const snapshot = {
            href: urlToCrawl.toString(),
            html: result.data,
            title: '',
            text: '',
        } as PageSnapshot;

        const curlSnapshot = await this.jsdomControl.narrowSnapshot(snapshot, crawlOpts);

        return curlSnapshot!;
    }


}
