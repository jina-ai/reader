import { AsyncService } from 'civkit/async-service';
import { singleton } from 'tsyringe';

import { Curl, CurlCode, CurlFeature, HeaderInfo } from 'node-libcurl';
import { parseString as parseSetCookieString } from 'set-cookie-parser';

import { ScrappingOptions } from './puppeteer';
import { GlobalLogger } from './logger';
import { AssertionFailureError, FancyFile } from 'civkit';
import { ServiceBadAttemptError, ServiceBadApproachError } from './errors';
import { TempFileManager } from '../services/temp-file';
import { createBrotliDecompress, createInflate, createGunzip } from 'zlib';
import { ZSTDDecompress } from 'simple-zstd';
import _ from 'lodash';
import { Readable } from 'stream';
import { AsyncLocalContext } from './async-context';
import { BlackHoleDetector } from './blackhole-detector';

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

    lifeCycleTrack = new WeakMap();

    constructor(
        protected globalLogger: GlobalLogger,
        protected tempFileManager: TempFileManager,
        protected asyncLocalContext: AsyncLocalContext,
        protected blackHoleDetector: BlackHoleDetector,
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

        curl.setOpt(Curl.option.HTTPHEADER, Object.entries(mixinHeaders).flatMap(([k, v]) => {
            if (Array.isArray(v) && v.length) {
                return v.map((v2) => `${k}: ${v2}`);
            }
            return [`${k}: ${v}`];
        }));

        return curl;
    }

    urlToFile1Shot(urlToCrawl: URL, crawlOpts?: CURLScrappingOptions) {
        return new Promise<{
            statusCode: number,
            data?: FancyFile,
            headers: HeaderInfo[],
        }>((resolve, reject) => {
            let contentType = '';
            const curl = new Curl();
            curl.enable(CurlFeature.StreamResponse);
            curl.setOpt('URL', urlToCrawl.toString());
            curl.setOpt(Curl.option.FOLLOWLOCATION, false);
            curl.setOpt(Curl.option.SSL_VERIFYPEER, false);
            curl.setOpt(Curl.option.TIMEOUT_MS, crawlOpts?.timeoutMs || 30_000);
            curl.setOpt(Curl.option.CONNECTTIMEOUT_MS, 3_000);
            if (crawlOpts?.method) {
                curl.setOpt(Curl.option.CUSTOMREQUEST, crawlOpts.method.toUpperCase());
            }
            if (crawlOpts?.body) {
                curl.setOpt(Curl.option.POSTFIELDS, crawlOpts.body.toString());
            }

            const headersToSet = { ...crawlOpts?.extraHeaders };
            if (crawlOpts?.cookies?.length) {
                const cookieKv: Record<string, string> = {};
                for (const cookie of crawlOpts.cookies) {
                    cookieKv[cookie.name] = cookie.value;
                }
                for (const cookie of crawlOpts.cookies) {
                    if (cookie.maxAge && cookie.maxAge < 0) {
                        delete cookieKv[cookie.name];
                        continue;
                    }
                    if (cookie.expires && cookie.expires < new Date()) {
                        delete cookieKv[cookie.name];
                        continue;
                    }
                    if (cookie.secure && urlToCrawl.protocol !== 'https:') {
                        delete cookieKv[cookie.name];
                        continue;
                    }
                    if (cookie.domain && !urlToCrawl.hostname.endsWith(cookie.domain)) {
                        delete cookieKv[cookie.name];
                        continue;
                    }
                    if (cookie.path && !urlToCrawl.pathname.startsWith(cookie.path)) {
                        delete cookieKv[cookie.name];
                        continue;
                    }
                }
                const cookieChunks = Object.entries(cookieKv).map(([k, v]) => `${k}=${encodeURIComponent(v)}`);
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
            }

            let curlStream: Readable | undefined;
            curl.on('error', (err, errCode) => {
                curl.close();
                this.logger.warn(`Curl ${urlToCrawl.origin}: ${err}`, { err, urlToCrawl });
                const err2 = this.digestCurlCode(errCode, err.message) ||
                    new AssertionFailureError(`Failed to access ${urlToCrawl.origin}: ${err.message}`);
                err2.cause ??= err;
                if (curlStream) {
                    // For some reason, manually emitting error event is required for curlStream.
                    curlStream.emit('error', err2);
                    curlStream.destroy(err2);
                }
                reject(err2);
            });
            curl.setOpt(Curl.option.MAXFILESIZE, 4 * 1024 * 1024 * 1024); // 4GB
            let status = -1;
            let contentEncoding = '';
            curl.once('end', () => {
                if (curlStream) {
                    curlStream.once('end', () => curl.close());
                    return;
                }
                curl.close();
            });
            curl.on('stream', (stream, statusCode, headers) => {
                this.logger.debug(`CURL: [${statusCode}] ${urlToCrawl.origin}`, { statusCode });
                status = statusCode;
                curlStream = stream;
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
                const lastResHeaders = headers[headers.length - 1];
                for (const [k, v] of Object.entries(lastResHeaders)) {
                    const kl = k.toLowerCase();
                    if (kl === 'content-type') {
                        contentType = (v || '').toLowerCase();
                    }
                    if (kl === 'content-encoding') {
                        contentEncoding = (v || '').toLowerCase();
                    }
                    if (contentType && contentEncoding) {
                        break;
                    }
                }

                if ([301, 302, 307, 308].includes(statusCode)) {
                    if (stream) {
                        stream.resume();
                    }
                    resolve({
                        statusCode: status,
                        data: undefined,
                        headers: headers as HeaderInfo[],
                    });
                    return;
                }

                if (!stream) {
                    resolve({
                        statusCode: status,
                        data: undefined,
                        headers: headers as HeaderInfo[],
                    });
                    return;
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
    }

    async urlToFile(urlToCrawl: URL, crawlOpts?: CURLScrappingOptions) {
        let leftRedirection = 6;
        let cookieRedirects = 0;
        let opts = { ...crawlOpts };
        let nextHopUrl = urlToCrawl;
        const fakeHeaderInfos: HeaderInfo[] = [];
        do {
            const r = await this.urlToFile1Shot(nextHopUrl, opts);

            if ([301, 302, 307, 308].includes(r.statusCode)) {
                fakeHeaderInfos.push(...r.headers);
                const headers = r.headers[r.headers.length - 1];
                const location: string | undefined = headers.Location || headers.location;

                const setCookieHeader = headers['Set-Cookie'] || headers['set-cookie'];
                if (setCookieHeader) {
                    const cookieAssignments = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
                    const parsed = cookieAssignments.filter(Boolean).map((x) => parseSetCookieString(x, { decodeValues: true }));
                    if (parsed.length) {
                        opts.cookies = [...(opts.cookies || []), ...parsed];
                    }
                    if (!location) {
                        cookieRedirects += 1;
                    }
                }

                if (!location && !setCookieHeader) {
                    // Follow curl behavior
                    return {
                        statusCode: r.statusCode,
                        data: r.data,
                        headers: fakeHeaderInfos.concat(r.headers),
                    };
                }
                if (!location && cookieRedirects > 1) {
                    throw new ServiceBadApproachError(`Failed to access ${urlToCrawl}: Browser required to solve complex cookie preconditions.`);
                }

                nextHopUrl = new URL(location || '', nextHopUrl);
                leftRedirection -= 1;
                continue;
            }

            return {
                statusCode: r.statusCode,
                data: r.data,
                headers: fakeHeaderInfos.concat(r.headers),
            };
        } while (leftRedirection > 0);

        throw new ServiceBadAttemptError(`Failed to access ${urlToCrawl}: Too many redirections.`);
    }

    async sideLoad(targetUrl: URL, crawlOpts?: CURLScrappingOptions) {
        const curlResult = await this.urlToFile(targetUrl, crawlOpts);
        this.blackHoleDetector.itWorked();
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
                if (location) {
                    finalURL = new URL(location, finalURL);
                }
            }
        }
        const lastHeaders = curlResult.headers[curlResult.headers.length - 1];
        const contentType = (lastHeaders['Content-Type'] || lastHeaders['content-type'])?.toLowerCase() || (await curlResult.data?.mimeType) || 'application/octet-stream';
        const contentDisposition = lastHeaders['Content-Disposition'] || lastHeaders['content-disposition'];
        const fileName = contentDisposition?.match(/filename="([^"]+)"/i)?.[1] || finalURL.pathname.split('/').pop();

        if (sideLoadOpts.impersonate[finalURL.href] && (await curlResult.data?.size)) {
            sideLoadOpts.impersonate[finalURL.href].body = curlResult.data;
        }

        // This should keep the file from being garbage collected and deleted until this asyncContext/request is done.
        this.lifeCycleTrack.set(this.asyncLocalContext.ctx, curlResult.data);

        return {
            finalURL,
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
            {
                return new AssertionFailureError(msg);
            }

            // Retryable errors
            case CurlCode.CURLE_REMOTE_ACCESS_DENIED:
            case CurlCode.CURLE_RECV_ERROR:
            case CurlCode.CURLE_GOT_NOTHING:
            case CurlCode.CURLE_OPERATION_TIMEDOUT:
            case CurlCode.CURLE_SSL_CONNECT_ERROR:
            case CurlCode.CURLE_QUIC_CONNECT_ERROR:
            case CurlCode.CURLE_COULDNT_RESOLVE_PROXY:
            case CurlCode.CURLE_COULDNT_CONNECT:
            case CurlCode.CURLE_PARTIAL_FILE: {
                return new ServiceBadAttemptError(msg);
            }

            default: {
                return undefined;
            }
        }
    }
}
