import { marshalErrorLike } from 'civkit/lang';
import { AsyncService } from 'civkit/async-service';
import { singleton } from 'tsyringe';

import { Curl, CurlCode, CurlFeature, HeaderInfo } from 'node-libcurl';
import { PageSnapshot, ScrappingOptions } from './puppeteer';
import { Logger } from '../shared/services/logger';
import { AssertionFailureError, FancyFile } from 'civkit';
import { ServiceBadAttemptError, TempFileManager } from '../shared';
import { readFile } from 'fs/promises';
import { pathToFileURL } from 'url';
import { createBrotliDecompress, createInflate, createGunzip } from 'zlib';
import { ZSTDDecompress } from 'simple-zstd';
import _ from 'lodash';
import { isReadable, Readable } from 'stream';

export interface CURLScrappingOptions extends ScrappingOptions {
    method?: string;
    body?: string | Buffer;
}

@singleton()
export class CurlControl extends AsyncService {

    logger = this.globalLogger.child({ service: this.constructor.name });

    chromeVersion: string = `132`;
    safariVersion: string = `537.36`;
    platform: string = `Linux`;
    ua: string = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/${this.safariVersion} (KHTML, like Gecko) Chrome/${this.chromeVersion}.0.0.0 Safari/${this.safariVersion}`;

    constructor(
        protected globalLogger: Logger,
        protected tempFileManager: TempFileManager,
    ) {
        super(...arguments);
    }

    override async init() {
        await this.dependencyReady();

        if (process.platform === 'darwin') {
            this.platform = `macOS`;
        } else if (process.platform === 'win32') {
            this.platform = `Windows`;
        }

        this.emit('ready');
    }

    impersonateChrome(ua: string) {
        this.chromeVersion = ua.match(/Chrome\/(\d+)/)![1];
        this.safariVersion = ua.match(/AppleWebKit\/([\d\.]+)/)![1];
        this.ua = ua;
    }

    curlImpersonateHeader(curl: Curl, headers?: object) {
        const mixinHeaders: Record<string, string> = {
            'sch-ch-ua': `Not A(Brand";v="8", "Chromium";v="${this.chromeVersion}", "Google Chrome";v="${this.chromeVersion}"`,
            'sec-ch-ua-mobile': '?0',
            'sec-ch-ua-platform': this.platform,
            'Upgrade-Insecure-Requests': '1',
            'User-Agent': this.ua,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
            'Sec-Fetch-Site': 'none',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-User': '?1',
            'Sec-Fetch-Dest': 'document',
            'Accept-Encoding': 'gzip, deflate, br, zstd',
            'Accept-Language': 'en-US,en;q=0.9',
        };
        const headersCopy: Record<string, string | undefined> = { ...headers };
        for (const k of Object.keys(mixinHeaders)) {
            const lowerK = k.toLowerCase();
            if (headersCopy[lowerK]) {
                mixinHeaders[k] = headersCopy[lowerK];
                delete headersCopy[lowerK];
            }
        }
        Object.assign(mixinHeaders, headersCopy);

        curl.setOpt(Curl.option.HTTPHEADER, Object.entries(mixinHeaders).map(([k, v]) => `${k}: ${v}`));

        return curl;
    }

    async download(urlToDownload: URL, crawlOpts?: CURLScrappingOptions) {
        let contentType = '';
        const result = await new Promise<{
            statusCode: number,
            data?: FancyFile,
            headers: Buffer | HeaderInfo[],
        }>((resolve, reject) => {
            const curl = new Curl();
            curl.enable(CurlFeature.StreamResponse);
            curl.setOpt('URL', urlToDownload.toString());
            curl.setOpt(Curl.option.FOLLOWLOCATION, true);
            curl.setOpt(Curl.option.SSL_VERIFYPEER, false);
            curl.setOpt(Curl.option.TIMEOUT_MS, Math.min(30_000, crawlOpts?.timeoutMs || 30_000));
            if (crawlOpts?.method) {
                curl.setOpt(Curl.option.CUSTOMREQUEST, crawlOpts.method.toUpperCase());
            }
            if (crawlOpts?.body) {
                curl.setOpt(Curl.option.POSTFIELDS, crawlOpts.body.toString());
            }

            const headersToSet = { ...crawlOpts?.extraHeaders };
            if (crawlOpts?.cookies?.length) {
                const cookieChunks = crawlOpts.cookies.map((cookie) => `${cookie.name}=${cookie.value}`);
                headersToSet.cookie ??= cookieChunks.join('; ');
            }
            if (crawlOpts?.referer) {
                headersToSet.referer ??= crawlOpts.referer;
            }
            if (crawlOpts?.overrideUserAgent) {
                headersToSet['user-agent'] ??= crawlOpts.overrideUserAgent;
            }

            this.curlImpersonateHeader(curl, headersToSet);
            if (crawlOpts?.proxyUrl) {
                const proxyUrlCopy = new URL(crawlOpts.proxyUrl);
                curl.setOpt(Curl.option.PROXY, proxyUrlCopy.href);
                curl.setOpt(Curl.option.PROXY_SSL_VERIFYPEER, false);
            }

            curl.on('end', (statusCode, _data, _headers) => {
                this.logger.debug(`CURL: [${statusCode}] ${urlToDownload.origin}`, { statusCode });
                curl.close();
            });

            let curlStream: Readable | undefined;
            curl.on('error', (err, errCode) => {
                curl.close();
                this.logger.warn(`Curl ${urlToDownload}: ${err}`, { err: marshalErrorLike(err) });
                if (curlStream) {
                    // For some reason, manually emitting error event is required for curlStream.
                    curlStream.emit('error', err);
                    curlStream.destroy(err);
                }
                const err2 = this.digestCurlCode(errCode, err.message);
                if (err2) {
                    reject(err2);
                    return;
                }
                reject(new AssertionFailureError(`Failed to download ${urlToDownload}: ${err.message}`));
            });
            curl.setOpt(Curl.option.MAXFILESIZE, 1024 * 1024 * 1024); // 1GB
            let status = -1;
            let contentEncoding = '';
            curl.on('stream', (stream, statusCode, headers) => {
                status = statusCode;
                curlStream = stream;
                const lastResHeaders = headers[headers.length - 1];
                for (const [k, v] of Object.entries(lastResHeaders)) {
                    const kl = k.toLowerCase();
                    if (kl === 'content-type') {
                        contentType = v.toLowerCase();
                    }
                    if (kl === 'content-encoding') {
                        contentEncoding = v.toLowerCase();
                    }
                    if (contentType && contentEncoding) {
                        break;
                    }
                }

                if (!contentType) {
                    reject(new AssertionFailureError(`Failed to download ${urlToDownload}: no content-type`));
                    stream.destroy();
                    return;
                }

                switch (contentEncoding) {
                    case 'gzip': {
                        const decompressed = createGunzip();
                        stream.pipe(decompressed);
                        stream.once('error', (err) => decompressed.destroy(err));
                        stream = decompressed;
                        break;
                    }
                    case 'deflate': {
                        const decompressed = createInflate();
                        stream.pipe(decompressed);
                        stream.once('error', (err) => decompressed.destroy(err));
                        stream = decompressed;
                        break;
                    }
                    case 'br': {
                        const decompressed = createBrotliDecompress();
                        stream.pipe(decompressed);
                        stream.once('error', (err) => decompressed.destroy(err));
                        stream = decompressed;
                        break;
                    }
                    case 'zstd': {
                        const decompressed = ZSTDDecompress();
                        stream.pipe(decompressed);
                        stream.once('error', (err) => decompressed.destroy(err));
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

        if (result.statusCode && (result.statusCode < 200 || result.statusCode >= 300)) {
            throw new AssertionFailureError(`Failed to download ${urlToDownload}: HTTP ${result.statusCode}`);
        }

        return result!;
    }

    async urlToSnapshot(urlToCrawl: URL, crawlOpts?: CURLScrappingOptions, throwOnNon200 = false): Promise<PageSnapshot> {
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
            curl.setOpt(Curl.option.SSL_VERIFYPEER, false);
            curl.setOpt(Curl.option.TIMEOUT_MS, Math.min(30_000, crawlOpts?.timeoutMs || 30_000));
            curl.setOpt(Curl.option.CONNECTTIMEOUT_MS, 3_000);
            if (crawlOpts?.method) {
                curl.setOpt(Curl.option.CUSTOMREQUEST, crawlOpts.method.toUpperCase());
            }
            if (crawlOpts?.body) {
                curl.setOpt(Curl.option.POSTFIELDS, crawlOpts.body.toString());
            }

            const headersToSet = { ...crawlOpts?.extraHeaders };
            if (crawlOpts?.cookies?.length) {
                const cookieChunks = crawlOpts.cookies.map((cookie) => `${cookie.name}=${cookie.value}`);
                headersToSet.cookie ??= cookieChunks.join('; ');
            }
            if (crawlOpts?.referer) {
                headersToSet.referer ??= crawlOpts.referer;
            }
            if (crawlOpts?.overrideUserAgent) {
                headersToSet['user-agent'] ??= crawlOpts.overrideUserAgent;
            }

            this.curlImpersonateHeader(curl, headersToSet);
            if (crawlOpts?.proxyUrl) {
                const proxyUrlCopy = new URL(crawlOpts.proxyUrl);
                curl.setOpt(Curl.option.PROXY, proxyUrlCopy.href);
                curl.setOpt(Curl.option.PROXY_SSL_VERIFYPEER, false);
            }

            curl.on('end', (statusCode, _data, _headers) => {
                this.logger.debug(`CURL: [${statusCode}] ${urlToCrawl.origin}`, { statusCode });
                curl.close();
            });

            let curlStream: Readable | undefined;
            curl.on('error', (err, errCode) => {
                curl.close();
                this.logger.warn(`Curl ${urlToCrawl.origin}: ${err}`, { err: marshalErrorLike(err), href: urlToCrawl.href });
                if (curlStream) {
                    // For some reason, manually emitting error event is required for curlStream.
                    curlStream.emit('error', err);
                    curlStream.destroy(err);
                }
                const err2 = this.digestCurlCode(errCode, err.message);
                if (err2) {
                    reject(err2);
                    return;
                }
                reject(new AssertionFailureError(`Failed to directly access ${urlToCrawl}: ${err.message}`));
            });
            curl.setOpt(Curl.option.MAXFILESIZE, 1024 * 1024 * 1024); // 1GB
            let status = -1;
            let contentEncoding = '';
            curl.on('stream', (stream, statusCode, headers) => {
                status = statusCode;
                curlStream = stream;
                const lastResHeaders = headers[headers.length - 1];
                for (const [k, v] of Object.entries(lastResHeaders)) {
                    const kl = k.toLowerCase();
                    if (kl === 'content-type') {
                        contentType = v.toLowerCase();
                    }
                    if (kl === 'content-encoding') {
                        contentEncoding = v.toLowerCase();
                    }
                    if (contentType && contentEncoding) {
                        break;
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
                        stream.once('error', (err) => decompressed.destroy(err));
                        stream = decompressed;
                        break;
                    }
                    case 'deflate': {
                        const decompressed = createInflate();
                        stream.pipe(decompressed);
                        stream.once('error', (err) => decompressed.destroy(err));
                        stream = decompressed;
                        break;
                    }
                    case 'br': {
                        const decompressed = createBrotliDecompress();
                        stream.pipe(decompressed);
                        stream.once('error', (err) => decompressed.destroy(err));
                        stream = decompressed;
                        break;
                    }
                    case 'zstd': {
                        const decompressed = ZSTDDecompress();
                        stream.pipe(decompressed);
                        stream.once('error', (err) => decompressed.destroy(err));
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

        return snapshot;
    }

    async urlToFile(urlToCrawl: URL, crawlOpts?: CURLScrappingOptions) {
        let contentType = '';
        const result = await new Promise<{
            statusCode: number,
            data: FancyFile,
            headers: HeaderInfo[],
        }>((resolve, reject) => {
            const curl = new Curl();
            curl.enable(CurlFeature.StreamResponse);
            curl.setOpt('URL', urlToCrawl.toString());
            curl.setOpt(Curl.option.FOLLOWLOCATION, true);
            curl.setOpt(Curl.option.SSL_VERIFYPEER, false);
            curl.setOpt(Curl.option.TIMEOUT_MS, Math.min(30_000, crawlOpts?.timeoutMs || 30_000));
            curl.setOpt(Curl.option.CONNECTTIMEOUT_MS, 3_000);
            if (crawlOpts?.method) {
                curl.setOpt(Curl.option.CUSTOMREQUEST, crawlOpts.method.toUpperCase());
            }
            if (crawlOpts?.body) {
                curl.setOpt(Curl.option.POSTFIELDS, crawlOpts.body.toString());
            }

            const headersToSet = { ...crawlOpts?.extraHeaders };
            if (crawlOpts?.cookies?.length) {
                const cookieChunks = crawlOpts.cookies.map((cookie) => `${cookie.name}=${cookie.value}`);
                headersToSet.cookie ??= cookieChunks.join('; ');
            }
            if (crawlOpts?.referer) {
                headersToSet.referer ??= crawlOpts.referer;
            }
            if (crawlOpts?.overrideUserAgent) {
                headersToSet['user-agent'] ??= crawlOpts.overrideUserAgent;
            }

            this.curlImpersonateHeader(curl, headersToSet);

            if (crawlOpts?.proxyUrl) {
                const proxyUrlCopy = new URL(crawlOpts.proxyUrl);
                curl.setOpt(Curl.option.PROXY, proxyUrlCopy.href);
                // const username = proxyUrlCopy.username;
                // const password = proxyUrlCopy.password;
                // proxyUrlCopy.username = '';
                // proxyUrlCopy.password = '';
                // curl.setOpt(Curl.option.PROXY_SSL_VERIFYPEER, false);
                // if (username && password) {
                //     curl.setOpt(Curl.option.PROXYUSERNAME, username);
                //     curl.setOpt(Curl.option.PROXYPASSWORD, password);
                // }
            }

            curl.on('end', (statusCode, data, _headers) => {
                this.logger.debug(`CURL: [${statusCode}] ${urlToCrawl.origin}`, { statusCode });
                if (typeof data === 'string' || Buffer.isBuffer(data)) {
                    curl.close();
                } else if (isReadable(data)) {
                    (data as any).once('end', () => curl.close());
                }
            });

            let curlStream: Readable | undefined;
            curl.on('error', (err, errCode) => {
                this.logger.warn(`Curl ${urlToCrawl}: ${err}`, { err: marshalErrorLike(err) });
                if (curlStream) {
                    // For some reason, manually emitting error event is required for curlStream.
                    curlStream.emit('error', err);
                    curlStream.destroy(err);
                }
                const err2 = this.digestCurlCode(errCode, err.message);
                if (err2) {
                    reject(err2);
                    return;
                }
                reject(new AssertionFailureError(`Failed to access ${urlToCrawl.origin}: ${err.message}`));
                curl.close();
            });
            curl.setOpt(Curl.option.MAXFILESIZE, 1024 * 1024 * 1024); // 1GB
            let status = -1;
            let contentEncoding = '';
            curl.on('stream', (stream, statusCode, headers) => {
                for (const headerSet of (headers as HeaderInfo[])) {
                    for (const [k, v] of Object.entries(headerSet)) {
                        if (k.trim().endsWith(':')) {
                            Reflect.set(headerSet, k.slice(0, k.indexOf(':')), v || '');
                            Reflect.deleteProperty(headerSet, k);
                            continue;
                        }
                        if (v === undefined) {
                            Reflect.set(headerSet, k, '');
                            continue;
                        }
                        if (k.toLowerCase() === 'content-type' && typeof v === 'string') {
                            contentType = v.toLowerCase();
                        }
                    }
                }
                status = statusCode;
                curlStream = stream;
                const lastResHeaders = headers[headers.length - 1];
                for (const [k, v] of Object.entries(lastResHeaders)) {
                    const kl = k.toLowerCase();
                    if (kl === 'content-type') {
                        contentType = v.toLowerCase();
                    }
                    if (kl === 'content-encoding') {
                        contentEncoding = v.toLowerCase();
                    }
                    if (contentType && contentEncoding) {
                        break;
                    }
                }

                switch (contentEncoding) {
                    case 'gzip': {
                        const decompressed = createGunzip();
                        stream.pipe(decompressed);
                        stream.once('error', (err) => {
                            decompressed.destroy(err);
                        });
                        stream = decompressed;
                        break;
                    }
                    case 'deflate': {
                        const decompressed = createInflate();
                        stream.pipe(decompressed);
                        stream.once('error', (err) => {
                            decompressed.destroy(err);
                        });
                        stream = decompressed;
                        break;
                    }
                    case 'br': {
                        const decompressed = createBrotliDecompress();
                        stream.pipe(decompressed);
                        stream.once('error', (err) => {
                            decompressed.destroy(err);
                        });
                        stream = decompressed;
                        break;
                    }
                    case 'zstd': {
                        const decompressed = ZSTDDecompress();
                        stream.pipe(decompressed);
                        stream.once('error', (err) => {
                            decompressed.destroy(err);
                        });
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
                    headers: headers as HeaderInfo[],
                });
            });

            curl.perform();
        });

        return result;
    }

    async sideLoad(targetUrl: URL, crawlOpts?: CURLScrappingOptions) {
        const curlResult = await this.urlToFile(targetUrl, crawlOpts);

        let finalURL = targetUrl;
        const sideLoadOpts: CURLScrappingOptions['sideLoad'] = {
            impersonate: {},
            proxyOrigin: {},
        };
        for (const headers of curlResult.headers) {
            sideLoadOpts.impersonate[finalURL.href] = {
                status: headers.result?.code || -1,
                headers: _.omit(headers, 'result'),
                contentType: headers['Content-Type'] || headers['content-type'],
            };
            if (crawlOpts?.proxyUrl) {
                sideLoadOpts.proxyOrigin[finalURL.origin] = crawlOpts.proxyUrl;
            }
            if (headers.result?.code && [301, 302, 307, 308].includes(headers.result.code)) {
                const location = headers.Location || headers.location;
                if (!location) {
                    throw new Error(`Bad redirection: ${curlResult.headers.length} times`);
                }
                finalURL = new URL(location, finalURL);
            }
        }
        const lastHeaders = curlResult.headers[curlResult.headers.length - 1];
        const contentType = (lastHeaders['Content-Type'] || lastHeaders['content-type']).toLowerCase() || await curlResult.data.mimeType;
        const contentDisposition = lastHeaders['Content-Disposition'] || lastHeaders['content-disposition'];
        const fileName = contentDisposition?.match(/filename="([^"]+)"/i)?.[1] || finalURL.pathname.split('/').pop();

        if (sideLoadOpts.impersonate[finalURL.href] && await curlResult.data.size) {
            sideLoadOpts.impersonate[finalURL.href].body = curlResult.data;
        }

        return {
            sideLoadOpts,
            chain: curlResult.headers,
            status: curlResult.statusCode,
            headers: lastHeaders,
            contentType,
            contentDisposition,
            fileName,
            file: curlResult.data
        };
    }

    digestCurlCode(code: CurlCode, msg: string) {
        switch (code) {
            // 400 User errors
            case CurlCode.CURLE_COULDNT_RESOLVE_HOST:
            case CurlCode.CURLE_REMOTE_ACCESS_DENIED: {
                return new AssertionFailureError(msg);
            }

            // Retryable errors
            case CurlCode.CURLE_SSL_CONNECT_ERROR:
            case CurlCode.CURLE_QUIC_CONNECT_ERROR:
            case CurlCode.CURLE_COULDNT_RESOLVE_PROXY:
            case CurlCode.CURLE_COULDNT_CONNECT:
            case CurlCode.CURLE_PARTIAL_FILE:
            case CurlCode.CURLE_OPERATION_TIMEDOUT: {
                return new ServiceBadAttemptError(msg);
            }

            default: {
                return undefined;
            }
        }
    }
}
