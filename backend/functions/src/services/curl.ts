import { marshalErrorLike } from 'civkit/lang';
import { AsyncService } from 'civkit/async-service';
import { singleton } from 'tsyringe';

import { Curl, CurlFeature, HeaderInfo } from 'node-libcurl';
import { PageSnapshot, ScrappingOptions } from './puppeteer';
import { Logger } from '../shared/services/logger';
import { JSDomControl } from './jsdom';
import { AssertionFailureError, FancyFile } from 'civkit';
import { TempFileManager } from '../shared';
import { readFile } from 'fs/promises';
import { pathToFileURL } from 'url';
import { createBrotliDecompress, createInflate, createGunzip } from 'zlib';
import { ZSTDDecompress } from 'simple-zstd';

@singleton()
export class CurlControl extends AsyncService {

    logger = this.globalLogger.child({ service: this.constructor.name });

    constructor(
        protected globalLogger: Logger,
        protected jsdomControl: JSDomControl,
        protected tempFileManager: TempFileManager,
    ) {
        super(...arguments);
    }

    override async init() {
        await this.dependencyReady();

        this.emit('ready');
    }

    curlImpersonateHeader(curl: Curl, headers?: object, chromeVersion: number = 132) {
        const mixinHeaders = {
            'sch-ch-ua': `Not A(Brand";v="8", "Chromium";v="${chromeVersion}", "Google Chrome";v="${chromeVersion}"`,
            'sec-ch-ua-mobile': '?0',
            'sec-ch-ua-platform': 'Windows',
            'Upgrade-Insecure-Requests': '1',
            'User-Agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion}.0.0.0 Safari/537.36`,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
            'Sec-Fetch-Site': 'none',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-User': '?1',
            'Sec-Fetch-Dest': 'document',
            'Accept-Encoding': 'gzip, deflate, br, zstd',
            'Accept-Language': 'en-US,en;q=0.9',
        };

        curl.setOpt(Curl.option.HTTPHEADER, Object.entries({ ...mixinHeaders, ...headers }).map(([k, v]) => `${k}: ${v}`));

        return curl;
    }

    async urlToSnapshot(urlToCrawl: URL, crawlOpts?: ScrappingOptions, throwOnNon200 = false): Promise<PageSnapshot> {
        const snapshot = {
            href: urlToCrawl.toString(),
            html: '',
            title: '',
            text: '',
        } as PageSnapshot;

        let contentType = '';
        const result = await new Promise<{
            statusCode: number,
            data?: FancyFile,
            headers: Buffer | HeaderInfo[],
        }>((resolve, reject) => {
            const curl = new Curl();
            curl.enable(CurlFeature.StreamResponse);
            curl.setOpt('URL', urlToCrawl.toString());
            curl.setOpt(Curl.option.FOLLOWLOCATION, true);

            curl.setOpt(Curl.option.TIMEOUT_MS, Math.min(10_000, crawlOpts?.timeoutMs || 10_000));

            if (crawlOpts?.overrideUserAgent) {
                curl.setOpt(Curl.option.USERAGENT, crawlOpts.overrideUserAgent);
            }

            this.curlImpersonateHeader(curl, crawlOpts?.extraHeaders);
            // if (crawlOpts?.extraHeaders) {
            //     curl.setOpt(Curl.option.HTTPHEADER, Object.entries(crawlOpts.extraHeaders).map(([k, v]) => `${k}: ${v}`));
            // }
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

            curl.on('end', (statusCode, _data, headers) => {
                this.logger.debug(`CURL: [${statusCode}] ${urlToCrawl}`, { statusCode, headers });
                curl.close();
            });

            curl.on('error', (err) => {
                curl.close();
                this.logger.warn(`Curl ${urlToCrawl}: ${err} (Not necessarily an error)`, { err: marshalErrorLike(err) });
                reject(new AssertionFailureError(`Failed to directly access ${urlToCrawl}: ${err.message}`));
            });
            curl.setOpt(Curl.option.MAXFILESIZE, 1024 * 1024 * 1024); // 1GB
            let status = -1;
            let contentEncoding = '';
            curl.on('stream', (stream, statusCode, headers) => {
                status = statusCode;
                outerLoop:
                for (const headerVec of headers) {
                    for (const [k, v] of Object.entries(headerVec)) {
                        const kl = k.toLowerCase();
                        if (kl === 'content-type') {
                            contentType = v.toLowerCase();
                        }
                        if (kl === 'content-encoding') {
                            contentEncoding = v.toLowerCase();
                        }
                        if (contentType && contentEncoding) {
                            break outerLoop;
                        }
                    }
                }

                if (!contentType) {
                    reject(new AssertionFailureError(`Failed to directly access ${urlToCrawl}: no content-type`));
                    stream.destroy();
                    return;
                }
                if (contentType.startsWith('image/')) {
                    snapshot.html = `<html style="height: 100%;"><head><meta name="viewport" content="width=device-width, minimum-scale=0.1"><title>${urlToCrawl.origin}${urlToCrawl.pathname}</title></head><body style="margin: 0px; height: 100%; background-color: rgb(14, 14, 14);"><img style="display: block;-webkit-user-select: none;margin: auto;background-color: hsl(0, 0%, 90%);transition: background-color 300ms;" src="${urlToCrawl.href}"></body></html>`;
                    stream.destroy();
                    resolve({
                        statusCode: status,
                        headers,
                    });
                    return;
                }

                switch (contentEncoding) {
                    case 'gzip': {
                        const decompressed = createGunzip();
                        stream.pipe(decompressed);
                        stream = decompressed;
                        break;
                    }
                    case 'deflate': {
                        const decompressed = createInflate();
                        stream.pipe(decompressed);
                        stream = decompressed;
                        break;
                    }
                    case 'br': {
                        const decompressed = createBrotliDecompress();
                        stream.pipe(decompressed);
                        stream = decompressed;
                        break;
                    }
                    case 'zstd': {
                        const decompressed = ZSTDDecompress();
                        stream.pipe(decompressed);
                        stream = decompressed;
                        break;
                    }
                    default: {
                        break;
                    }
                }

                const fpath = this.tempFileManager.alloc();
                const fancyFile = FancyFile.auto(stream, fpath);
                this.tempFileManager.bindPathTo(fancyFile, fpath);
                resolve({
                    statusCode: status,
                    data: fancyFile,
                    headers,
                });
            });

            curl.perform();
        });

        if (throwOnNon200 && result.statusCode && (result.statusCode < 200 || result.statusCode >= 300)) {
            throw new AssertionFailureError(`Failed to access ${urlToCrawl}: HTTP ${result.statusCode}`);
        }

        if (contentType === 'application/octet-stream') {
            // Content declared as binary is same as unknown.
            contentType = '';
        }

        if (result.data) {
            const mimeType: string = contentType || await result.data.mimeType;
            if (mimeType.startsWith('text/html')) {
                if ((await result.data.size) > 1024 * 1024 * 32) {
                    throw new AssertionFailureError(`Failed to access ${urlToCrawl}: file too large`);
                }
                snapshot.html = await readFile(await result.data.filePath, { encoding: 'utf-8' });
            } else if (mimeType.startsWith('text/') || mimeType.startsWith('application/json')) {
                if ((await result.data.size) > 1024 * 1024 * 32) {
                    throw new AssertionFailureError(`Failed to access ${urlToCrawl}: file too large`);
                }
                snapshot.text = await readFile(await result.data.filePath, { encoding: 'utf-8' });
                snapshot.html = `<html><head><meta name="color-scheme" content="light dark"></head><body><pre style="word-wrap: break-word; white-space: pre-wrap;">${snapshot.text}</pre></body></html>`;
            } else if (mimeType.startsWith('application/pdf')) {
                snapshot.pdfs = [pathToFileURL(await result.data.filePath).href];
            } else {
                throw new AssertionFailureError(`Failed to access ${urlToCrawl}: unexpected type ${mimeType}`);
            }
        }

        const curlSnapshot = await this.jsdomControl.narrowSnapshot(snapshot, crawlOpts);

        return curlSnapshot!;
    }


}
