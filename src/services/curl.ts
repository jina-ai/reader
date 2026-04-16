import { AsyncService } from 'civkit/async-service';
import { singleton } from 'tsyringe';
import { Blob } from 'buffer';

import { Curl, CurlCode, CurlFeature, HeaderInfo, Browser, getChromeConfig } from '@nomagick/node-libcurl-impersonate';
import { parseString as parseSetCookieString } from 'set-cookie-parser';

import { ScrappingOptions } from './puppeteer';
import { GlobalLogger } from './logger';
import { AssertionFailureError } from 'civkit/civ-rpc';
import { FancyFile } from 'civkit/fancy-file';

import { ServiceBadAttemptError, ServiceBadApproachError, TargetFileTooLargeError } from './errors';
import { TempFileManager } from '../services/temp-file';
import _ from 'lodash';
import { PassThrough, Readable } from 'stream';
import { AsyncLocalContext } from './async-context';
import { BlackHoleDetector } from './blackhole-detector';
import { humanReadableDataSize } from 'civkit/readability';

export interface CURLScrappingOptions<T = any> extends ScrappingOptions<T> {
    method?: string;
    body?: string | Buffer;
    maxSize?: number;
}

export const REDIRECTION_CODES = new Set([301, 302, 303, 307, 308]);

@singleton()
export class CurlControl extends AsyncService {

    logger = this.globalLogger.child({ service: this.constructor.name });

    chromeVersion: string = `136`;
    safariVersion: string = `537.36`;
    platform: string = `Linux`;
    ua: string = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/${this.safariVersion} (KHTML, like Gecko) Chrome/${this.chromeVersion}.0.0.0 Safari/${this.safariVersion}`;

    lifeCycleTrack = new WeakMap();

    impersonateCfg?: ReturnType<typeof getChromeConfig>;

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
        this.impersonateCfg = getChromeConfig({
            version: this.chromeVersion,
            fingerprint: {
                ja3: '771,4865-4866-4867-49195-49199-49196-49200-52393-52392-49171-49172-156-157-47-53,10-16-17613-23-43-65037-13-65281-45-11-18-27-51-5-35-0-41,4588-29-23-24,0',
                ja4: 't13d1517h2_002f,0035,009c,009d,1301,1302,1303,c013,c014,c02b,c02c,c02f,c030,cca8,cca9_0000,0005,000a,000b,000d,0012,0017,001b,0023,0029,002b,002d,0033,44cd,fe0d,ff01_0403,0804,0401,0503,0805,0501,0806,0601',
                akami: '1:65536;2:0;4:6291456;6:262144|15663105|0|m,a,s,p'
            }
        });
    }

    curlImpersonateHeader(curl: Curl, headers?: object) {
        let uaPlatform = this.platform;
        if (this.ua.includes('Windows')) {
            uaPlatform = 'Windows';
        } else if (this.ua.includes('Android')) {
            uaPlatform = 'Android';
        } else if (this.ua.includes('iPhone') || this.ua.includes('iPad') || this.ua.includes('iPod')) {
            uaPlatform = 'iOS';
        } else if (this.ua.includes('CrOS')) {
            uaPlatform = 'Chrome OS';
        } else if (this.ua.includes('Macintosh')) {
            uaPlatform = 'macOS';
        }

        const mixinHeaders: Record<string, string> = {
            'sec-ch-ua': `"Chromium";v="${this.chromeVersion}", "Google Chrome";v="${this.chromeVersion}", "Not.A/Brand";v="99"`,
            'sec-ch-ua-mobile': '?0',
            'sec-ch-ua-platform': `"${uaPlatform}"`,
            'Upgrade-Insecure-Requests': '1',
            'User-Agent': this.ua,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
            'Sec-Fetch-Site': 'none',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-User': '?1',
            'Sec-Fetch-Dest': 'document',
            // 'Accept-Encoding': 'gzip, deflate, br, zstd',
            'Accept-Language': 'en-US,en;q=0.9',
            'Priority': 'u=0, i'
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

    urlToStream(urlToCrawl: URL, crawlOpts?: CURLScrappingOptions) {
        return new Promise<{
            statusCode: number,
            statusText?: string,
            data?: Readable,
            headers: HeaderInfo[],
        }>((resolve, reject) => {
            const actx = this.asyncLocalContext.ctx;
            let contentType = '';
            const curl = Curl.impersonate(this.impersonateCfg || Browser.Chrome);
            curl.enable(CurlFeature.StreamResponse);
            curl.setOpt('URL', urlToCrawl.toString());
            curl.setOpt(Curl.option.FOLLOWLOCATION, false);
            curl.setOpt(Curl.option.SSL_VERIFYPEER, false);
            curl.setOpt(Curl.option.TIMEOUT_MS, crawlOpts?.timeoutMs || 30_000);
            curl.setOpt(Curl.option.CONNECTTIMEOUT_MS, 3_000);
            curl.setOpt(Curl.option.LOW_SPEED_LIMIT, 32768);
            curl.setOpt(Curl.option.LOW_SPEED_TIME, 5_000);
            if (crawlOpts?.method) {
                curl.setOpt(Curl.option.CUSTOMREQUEST, crawlOpts.method.toUpperCase());
            }
            if (crawlOpts?.body) {
                // @ts-ignore
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
                curl.setOpt(Curl.option.CONNECTTIMEOUT_MS, 6_000);
            }

            let curlStream: Readable | undefined;
            let streamRecvCounter = 0;
            curl.on('error', (err, errCode) => {
                this.asyncLocalContext.bridge(actx, () => {
                    curl.close();
                    const err2 = this.digestCurlCode(errCode, err.message) ||
                        new AssertionFailureError(`Failed to access ${urlToCrawl.origin}: ${err.message}`);
                    err2.cause ??= err;
                    if (curlStream) {
                        // For some reason, manually emitting error event is required for curlStream.
                        if (errCode === CurlCode.CURLE_HTTP2_STREAM && streamRecvCounter) {
                            this.logger.warn(`Curl(${errCode}) ${urlToCrawl.origin}: ${err}, but some data was received, not emitting error to the stream.`, { err, urlToCrawl });
                            curlStream.push(null);
                            return;
                        }
                        curlStream.emit('error', err2);
                        curlStream.destroy(err2);
                    } else {
                        this.logger.warn(`Curl(${errCode}) ${urlToCrawl.origin}: ${err}`, { err, urlToCrawl });
                    }
                    reject(err2);
                });
            });
            curl.setOpt(Curl.option.MAXFILESIZE, 4 * 1024 * 1024 * 1024); // 4GB
            let status = -1;
            let statusText: string | undefined;
            let contentEncoding = '';
            curl.once('end', () => {
                if (curlStream) {
                    curlStream.once('end', () => curl.close());
                    return;
                }
                curl.close();
            });
            curl.on('stream', (stream, statusCode, headers) => {
                status = statusCode;
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
                statusText = (lastResHeaders as HeaderInfo).result?.reason;
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

                curlStream = stream;
                stream.on('data', (buf) => {
                    if (buf.length > 0) {
                        streamRecvCounter += buf.length;
                    }
                });
                const passThrough = new PassThrough();
                stream.pipe(passThrough);
                stream.once('error', (err) => {
                    passThrough.destroy(err);
                });
                stream = passThrough;
                stream.once('end', () => {
                    this.asyncLocalContext.bridge(actx, () => {
                        this.logger.debug(`CURL: [${statusCode}${statusText ? ` ${statusText}` : ''}] ${urlToCrawl.origin} ${humanReadableDataSize(streamRecvCounter)} ${contentType} ${contentEncoding}`, {
                            statusCode, statusText, traffic: streamRecvCounter, contentType, contentEncoding
                        });
                    });
                });

                if (
                    REDIRECTION_CODES.has(statusCode) &&
                    headers.some((h) => h.hasOwnProperty('Location') || h.hasOwnProperty('location'))
                ) {
                    stream.resume();
                    stream.once('end', () => {
                        resolve({
                            statusCode: status,
                            statusText,
                            data: undefined,
                            headers: headers as HeaderInfo[],
                        });
                    });
                    return;
                }

                resolve({
                    statusCode: status,
                    statusText,
                    data: stream,
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
            const s = await this.urlToStream(nextHopUrl, opts);
            const r = { ...s } as {
                statusCode: number,
                statusText?: string,
                data?: FancyFile,
                headers: HeaderInfo[],
            };

            const headers = r.headers[r.headers.length - 1];
            const claimedSize = parseInt(headers['Content-Length'] || headers['content-length']);
            if (crawlOpts?.maxSize && claimedSize > crawlOpts.maxSize) {
                throw new TargetFileTooLargeError(`Target file is too large: ${humanReadableDataSize(claimedSize)} > ${humanReadableDataSize(crawlOpts.maxSize)}`);
            }
            if (r.data) {
                const fpath = this.tempFileManager.alloc();
                const fancyFile = FancyFile.auto(r.data, fpath);
                this.tempFileManager.bindPathTo(fancyFile, fpath);
                r.data = fancyFile;
            }
            if (REDIRECTION_CODES.has(r.statusCode)) {
                fakeHeaderInfos.push(...r.headers);
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
                    let sizeAcc = 0;
                    s.data!.on('data', (chunk) => {
                        sizeAcc += chunk.length;
                        if (crawlOpts?.maxSize && sizeAcc > crawlOpts.maxSize) {
                            s.data!.destroy(new TargetFileTooLargeError(`Max size exceeded: ${humanReadableDataSize(sizeAcc)}`));
                        }
                    });
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

            let sizeAcc = 0;
            s.data!.on('data', (chunk) => {
                sizeAcc += chunk.length;
                if (crawlOpts?.maxSize && sizeAcc > crawlOpts.maxSize) {
                    s.data!.destroy(new TargetFileTooLargeError(`Max size exceeded: ${humanReadableDataSize(sizeAcc)}`));
                }
            });

            return {
                statusCode: r.statusCode,
                statusText: r.statusText,
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
        const sideLoadOpts: CURLScrappingOptions<FancyFile>['sideLoad'] = {
            impersonate: {},
            proxyOrigin: {},
        };
        for (const headers of curlResult.headers) {
            const potentialLastResult = sideLoadOpts.impersonate[finalURL.href];
            sideLoadOpts.impersonate[finalURL.href] = {
                status: headers.result?.code || -1,
                headers: _.mergeWith(potentialLastResult?.headers || {}, _.omit(headers, 'result'), (objValue, srcValue) => {
                    if (Array.isArray(objValue) && Array.isArray(srcValue)) {
                        return [...objValue, ...srcValue];
                    }
                    return undefined;
                }),
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
            statusText: curlResult.statusText,
            headers: lastHeaders,
            contentType,
            contentDisposition,
            fileName,
            file: curlResult.data
        };
    }

    async urlToBlob(urlToCrawl: URL, crawlOpts?: CURLScrappingOptions) {
        let leftRedirection = 6;
        let cookieRedirects = 0;
        let opts = { ...crawlOpts };
        let nextHopUrl = urlToCrawl;
        const fakeHeaderInfos: HeaderInfo[] = [];
        do {
            const s = await this.urlToStream(nextHopUrl, opts);
            const r = { ...s } as {
                statusCode: number,
                statusText?: string,
                data?: Blob,
                headers: HeaderInfo[],
            };


            const headers = r.headers[r.headers.length - 1];
            const claimedSize = parseInt(headers['Content-Length'] || headers['content-length']);
            if (crawlOpts?.maxSize && claimedSize > crawlOpts.maxSize) {
                throw new TargetFileTooLargeError(`Target file is too large: ${humanReadableDataSize(claimedSize)} > ${humanReadableDataSize(crawlOpts.maxSize)}`);
            }
            if (REDIRECTION_CODES.has(r.statusCode)) {
                fakeHeaderInfos.push(...r.headers);
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
                    if (s.data) {
                        const chunks: Buffer[] = [];
                        let sizeAcc = 0;
                        s.data.on('data', (chunk) => {
                            chunks.push(chunk);
                            sizeAcc += chunk.length;
                            if (crawlOpts?.maxSize && sizeAcc > crawlOpts.maxSize) {
                                s.data!.destroy(new TargetFileTooLargeError(`Max size exceeded: ${humanReadableDataSize(sizeAcc)}`));
                            }
                        });
                        await new Promise((resolve, reject) => {
                            s.data!.once('end', resolve);
                            s.data!.once('error', reject);
                        });
                        r.data = new Blob(chunks, { type: headers['Content-Type'] || headers['content-type'] });
                    }
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

            if (s.data) {
                const chunks: Buffer[] = [];
                let sizeAcc = 0;
                s.data.on('data', (chunk) => {
                    chunks.push(chunk);
                    sizeAcc += chunk.length;
                    if (crawlOpts?.maxSize && sizeAcc > crawlOpts.maxSize) {
                        s.data!.destroy(new TargetFileTooLargeError(`Max size exceeded: ${humanReadableDataSize(sizeAcc)}`));
                    }
                });
                await new Promise((resolve, reject) => {
                    s.data!.once('end', resolve);
                    s.data!.once('error', reject);
                });
                r.data = new Blob(chunks, { type: headers['Content-Type'] || headers['content-type'] });
            }

            return {
                statusCode: r.statusCode,
                statusText: r.statusText,
                data: r.data,
                headers: fakeHeaderInfos.concat(r.headers),
            };
        } while (leftRedirection > 0);

        throw new ServiceBadAttemptError(`Failed to access ${urlToCrawl}: Too many redirections.`);
    }

    async sideLoadBlob(targetUrl: URL, crawlOpts?: CURLScrappingOptions) {
        const curlResult = await this.urlToBlob(targetUrl, crawlOpts);
        this.blackHoleDetector.itWorked();
        let finalURL = targetUrl;
        const sideLoadOpts: CURLScrappingOptions<Blob>['sideLoad'] = {
            impersonate: {},
            proxyOrigin: {},
        };
        for (const headers of curlResult.headers) {
            const potentialLastResult = sideLoadOpts.impersonate[finalURL.href];
            sideLoadOpts.impersonate[finalURL.href] = {
                status: headers.result?.code || -1,
                headers: _.mergeWith(potentialLastResult?.headers || {}, _.omit(headers, 'result'), (objValue, srcValue) => {
                    if (Array.isArray(objValue) && Array.isArray(srcValue)) {
                        return [...objValue, ...srcValue];
                    }
                    return undefined;
                }),
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
        const contentType = (lastHeaders['Content-Type'] || lastHeaders['content-type'])?.toLowerCase() || (curlResult.data?.type) || 'application/octet-stream';
        const contentDisposition = lastHeaders['Content-Disposition'] || lastHeaders['content-disposition'];
        const fileName = contentDisposition?.match(/filename="([^"]+)"/i)?.[1] || finalURL.pathname.split('/').pop();

        if (sideLoadOpts.impersonate[finalURL.href] && (curlResult.data?.size)) {
            sideLoadOpts.impersonate[finalURL.href].body = curlResult.data;
        }

        // This should keep the file from being garbage collected and deleted until this asyncContext/request is done.
        this.lifeCycleTrack.set(this.asyncLocalContext.ctx, curlResult.data);

        return {
            finalURL,
            sideLoadOpts,
            chain: curlResult.headers,
            status: curlResult.statusCode,
            statusText: curlResult.statusText,
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
            case CurlCode.CURLE_COULDNT_RESOLVE_HOST: {
                return new AssertionFailureError(msg);
            }

            // Maybe retry but dont retry with curl again
            case CurlCode.CURLE_OPERATION_TIMEDOUT:
            case CurlCode.CURLE_UNSUPPORTED_PROTOCOL:
            case CurlCode.CURLE_PEER_FAILED_VERIFICATION: {
                return new ServiceBadApproachError(msg);
            }

            // Retryable errors
            case CurlCode.CURLE_PROXY:
            case CurlCode.CURLE_REMOTE_ACCESS_DENIED:
            case CurlCode.CURLE_SEND_ERROR:
            case CurlCode.CURLE_RECV_ERROR:
            case CurlCode.CURLE_GOT_NOTHING:
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
