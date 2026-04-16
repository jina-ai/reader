import { singleton } from 'tsyringe';
import { randomUUID } from 'crypto';
import _ from 'lodash';
import { Blob, File } from 'buffer';

import {
    assignTransferProtocolMeta, RPCHost, RPCReflection,
    AssertionFailureError, ParamValidationError,
    RawString,
    ApplicationError,
    DataStreamBrokenError,
    OperationNotAllowedError,
    assignMeta,
    extractMeta,
} from 'civkit/civ-rpc';
import { marshalErrorLike } from 'civkit/lang';
import { Defer } from 'civkit/defer';
import { retryWith } from 'civkit/decorators';
import { FancyFile } from 'civkit/fancy-file';

import { CONTENT_FORMAT, CrawlerOptions, CrawlerOptionsHeaderOnly, ENGINE_TYPE, RESPOND_TIMING } from '../dto/crawler-options';

import { OutputServerEventStream } from '../lib/transform-server-event-stream';

import { PageSnapshot, PuppeteerControl, ScrappingOptions } from '../services/puppeteer';
import { JSDomControl } from '../services/jsdom';
import { FormattedPage, FormattedPageDto, md5Hasher, SnapshotFormatter } from '../services/snapshot-formatter';
import { CurlControl, CURLScrappingOptions, REDIRECTION_CODES } from '../services/curl';
import { LmControl } from '../services/lm';
import { tryDecodeURIComponent } from '../utils/misc';
import { CFBrowserRendering } from '../services/cf-browser-rendering';

import { GlobalLogger } from '../services/logger';
import { AsyncLocalContext } from '../services/async-context';
import { Context, Ctx, Method, Param, RPCReflect } from '../services/registry';
import {
    BudgetExceededError,
    SecurityCompromiseError, ServiceBadApproachError, ServiceBadAttemptError,
    ServiceCrashedError,
    ServiceNodeResourceDrainError,
} from '../services/errors';

import { countGPTToken as estimateToken } from '../utils/openai';
import { ProxyProviderService } from '../services/proxy-provider';
// import { JinaEmbeddingsAuthDTO } from '../dto/jina-embeddings-auth';
import { RobotsTxtService } from '../services/robots-text';
import { TempFileManager } from '../services/temp-file';
import { MiscService } from '../services/misc';
import { HTTPServiceError } from 'civkit/http';
import { GeoIPService } from '../services/geoip';
import { readFile } from 'fs/promises';
import { openAsBlob } from 'fs';
import { AltTextService } from '../services/alt-text';
import '../config';
import { AUTH_DTO_CLS } from '../config';
import { Crawled, DomainBlockade } from '../db/models';
import { BaseAuthDTO } from '../dto/base-auth';
import { StorageLayer } from '../db/noop-storage';
import { BinaryExtractorService } from '../services/binary-extractor';
import { HashManager } from 'civkit/hash';
import { detectBuff, extOfMime } from 'civkit/mime';
import { STATUS_CODES } from 'http';
import { fileURLToPath } from 'url';


export const sha256Hasher = new HashManager('sha256', 'hex');

export interface ExtraScrappingOptions extends ScrappingOptions {
    withIframe?: boolean | 'quoted';
    withShadowDom?: boolean;
    targetSelector?: string | string[];
    removeSelector?: string | string[];
    keepImgDataUrl?: boolean;
    engine?: string;
    allocProxy?: string;
    private?: boolean;
    countryHint?: string;
    readabilityRequired?: boolean;
    eligibleForPageIndex?: boolean;
}

const indexProto = {
    toString: function (): string {
        return _(this)
            .toPairs()
            .map(([k, v]) => k ? `[${_.upperFirst(_.lowerCase(k))}] ${v}` : '')
            .value()
            .join('\n') + '\n';
    }
};

const hostTrimerRegexpMap = new Map<string, RegExp>();
const redundantProtocolRegexp = /^(?:(?:https?:\/+)|(?:view-source:))+(https?:\/+)/i;

@singleton()
export class CrawlerHost extends RPCHost {
    logger = this.globalLogger.child({ service: this.constructor.name });

    cacheRetentionMs = 1000 * 3600 * 24 * 7;
    cacheValidMs = 1000 * 3600;
    urlValidMs = 1000 * 3600 * 4;
    abuseBlockMs = 1000 * 3600;
    consecutiveErrorThreshold = 10;
    consecutiveErrorRetentionMs = 1000 * 3600;
    domainProfileRetentionMs = 1000 * 3600 * 24 * 30;

    indexedOpts = new WeakSet<ScrappingOptions | object>();

    constructor(
        protected globalLogger: GlobalLogger,
        protected puppeteerControl: PuppeteerControl,
        protected curlControl: CurlControl,
        protected cfBrowserRendering: CFBrowserRendering,
        protected proxyProvider: ProxyProviderService,
        protected lmControl: LmControl,
        protected jsdomControl: JSDomControl,
        protected snapshotFormatter: SnapshotFormatter,
        protected threadLocal: AsyncLocalContext,
        protected robotsTxtService: RobotsTxtService,
        protected tempFileManager: TempFileManager,
        protected geoIpService: GeoIPService,
        protected miscService: MiscService,
        protected altTextService: AltTextService,
        protected storageLayer: StorageLayer,
        protected binaryExtractorService: BinaryExtractorService,
    ) {
        super(...arguments);

        this.on('index-snapshot', async (targetUrl: URL | undefined, snapshot: PageSnapshot, options: ExtraScrappingOptions, sourceHint?: string) => {
            if (this.indexedOpts.has(options) && sourceHint !== 'pptr' && sourceHint !== 'blob') {
                return;
            } else if (this.indexedOpts.has(options) && sourceHint === 'pptr' && snapshot.blobs?.length) {
                return;
            } else if (sourceHint === 'cache') {
                this.indexedOpts.add(options);
                return;
            } else if (this.indexedOpts.has(this.threadLocal.ctx) && !sourceHint) {
                return;
            }
            this.indexedOpts.add(options);
            this.indexedOpts.add(this.threadLocal.ctx);

            if (!snapshot.title?.trim() && !snapshot.blobs?.length) {
                return;
            }
            if (options.cookies?.length || options.private) {
                // Potential privacy issue, dont cache if cookies are used
                return;
            }
            if (options.injectFrameScripts?.length || options.injectPageScripts?.length || options.viewport) {
                // Potentially mangeled content, dont cache if scripts are injected
                return;
            }
            if (snapshot.elemCount && snapshot.isIntermediate) {
                return;
            }
            if (snapshot.elemCount && !snapshot.lastMutationIdle) {
                // Created by browser but never reached mutationIdle, presumably too short timeout
                return;
            }
            if (options.locale) {
                Reflect.set(snapshot, 'locale', options.locale);
            }

            if (!snapshot.traits?.length) {
                const analyzed = await this.jsdomControl.analyzeHTMLTextLite(snapshot.html);
                if (analyzed.tokens < 200) {
                    // Does not contain enough content
                    if (snapshot.status !== 200) {
                        return;
                    }
                    if (snapshot.html.includes('captcha') || snapshot.html.includes('cf-turnstile')) {
                        return;
                    }
                }
            }

            this.setToCache(targetUrl || new URL(snapshot.href), snapshot, options.eligibleForPageIndex);
        });

        puppeteerControl.on('crawled', async (snapshot: PageSnapshot, options: ExtraScrappingOptions, url: URL) => {
            this.emit('index-snapshot', url, snapshot, options, 'pptr');
        });

        puppeteerControl.on('abuse', async (abuseEvent: { url: URL; reason: string, sn: number; }) => {
            this.logger.warn(`Abuse detected on ${abuseEvent.url}, blocking ${abuseEvent.url.hostname}`, { reason: abuseEvent.reason, sn: abuseEvent.sn });

            await this.storageLayer.storeDomainBlockade(DomainBlockade.from({
                domain: abuseEvent.url.hostname.toLowerCase(),
                triggerReason: `${abuseEvent.reason}`,
                triggerUrl: abuseEvent.url.toString(),
                createdAt: new Date(),
                expireAt: new Date(Date.now() + this.abuseBlockMs),
            })).catch((err) => {
                this.logger.warn(`Failed to save domain blockade for ${abuseEvent.url.hostname}`, { err: marshalErrorLike(err) });
            });

        });
    }

    override async init() {
        await this.dependencyReady();

        if (this.puppeteerControl.effectiveUA) {
            this.curlControl.impersonateChrome(this.puppeteerControl.effectiveUA);
        }

        this.emit('ready');
    }

    async getIndex(auth?: BaseAuthDTO) {
        const indexObject: Record<string, string | number | undefined> = Object.create(indexProto);
        Object.assign(indexObject, {
            usage1: 'https://r.jina.ai/YOUR_URL',
            usage2: 'https://s.jina.ai/YOUR_SEARCH_QUERY',
            homepage: 'https://jina.ai/reader',
        });

        // if (auth instanceof JinaEmbeddingsAuthDTO) {
        //     await auth?.solveUID();
        //     if (auth && auth.user) {
        //         indexObject[''] = undefined;
        //         indexObject.authenticatedAs = `${auth.user.user_id} (${auth.user.full_name})`;
        //         indexObject.balanceLeft = auth.user.wallet.total_balance;
        //     }
        // }

        return indexObject;
    }

    @Method({
        name: 'getIndex',
        description: 'Index of the service',
        proto: {
            http: {
                action: 'get',
                path: '/',
            }
        },
        tags: ['misc', 'crawl'],
        returnType: [String, Object],
    })
    async getIndexCtrl(
        @RPCReflect() rpcReflect: RPCReflection,
        @Ctx() ctx: Context,
        @Param({ type: AUTH_DTO_CLS }) auth: BaseAuthDTO,
        crawlerOptionsParamsAllowed: CrawlerOptions,
    ) {
        if (crawlerOptionsParamsAllowed.url || (crawlerOptionsParamsAllowed.file || crawlerOptionsParamsAllowed.pdf || crawlerOptionsParamsAllowed.html)) {
            return this.crawl(rpcReflect, ctx, auth, crawlerOptionsParamsAllowed, crawlerOptionsParamsAllowed);
        }

        const indexObject = await this.getIndex(auth);

        if (!ctx.accepts('text/plain') && (ctx.accepts('text/json') || ctx.accepts('application/json'))) {
            return indexObject;
        }

        return assignTransferProtocolMeta(`${indexObject}`,
            { contentType: 'text/plain; charset=utf-8', envelope: null }
        );
    }


    @Method({
        name: 'crawlByPostingToIndex',
        description: 'Crawl any url into markdown',
        proto: {
            http: {
                action: 'POST',
                path: '/',
            }
        },
        tags: ['crawl'],
        returnType: [String, OutputServerEventStream],
    })
    @Method({
        description: 'Crawl any url into markdown',
        proto: {
            http: {
                action: ['GET', 'POST'],
                path: '::url',
            }
        },
        tags: ['crawl'],
        returnType: [String, OutputServerEventStream, RawString],
    })
    async crawl(
        @RPCReflect() rpcReflect: RPCReflection,
        @Ctx() ctx: Context,
        @Param({ type: AUTH_DTO_CLS }) auth: BaseAuthDTO,
        crawlerOptionsHeaderOnly: CrawlerOptionsHeaderOnly,
        crawlerOptionsParamsAllowed: CrawlerOptions,
    ) {
        let chargeAmount = 0;
        let finalSnapshot: PageSnapshot | undefined;
        const crawlerOptions = ctx.method === 'GET' ? crawlerOptionsHeaderOnly : crawlerOptionsParamsAllowed;
        const tierPolicy = await this.saasAssertTierPolicy(crawlerOptions, auth);
        const futureRateLimit = this.storageLayer.rateLimit(ctx, rpcReflect, auth as any);

        // Use koa ctx.URL, a standard URL object to avoid node.js framework prop naming confusion
        const targetUrl = await this.getTargetUrl(tryDecodeURIComponent(`${ctx.URL.pathname}${ctx.URL.search}`), crawlerOptions, ctx.URL.host);
        if (!targetUrl) {
            return await this.getIndex(auth);
        }
        crawlerOptions.url = targetUrl.toString();

        // Prevent circular crawling
        this.puppeteerControl.circuitBreakerHosts.add(
            ctx.hostname.toLowerCase()
        );

        const {
            isAnonymous,
            uid,
            reportOptions,
            reportUsage
        } = await futureRateLimit;

        rpcReflect.finally(() => {
            reportOptions?.(crawlerOptions.customizedProps());
            if (crawlerOptions.tokenBudget && chargeAmount > crawlerOptions.tokenBudget) {
                return;
            }
            reportUsage?.(chargeAmount, 'reader-crawl');
        });

        if (isAnonymous) {
            // Enforce no proxy is allocated for anonymous users due to abuse.
            crawlerOptions.proxy = 'none';
            if (crawlerOptions.respondWith.includes('html')) {
                crawlerOptions.engine ??= ENGINE_TYPE.CURL;
            }
            const blockade = await this.storageLayer.findDomainBlockade({
                domain: targetUrl.hostname.toLowerCase(),
                expireAt: new Date()
            }).catch((err) => {
                this.logger.warn(`Failed to query domain blockade for ${targetUrl.hostname}`, { err });
                return undefined;
            });

            if (blockade) {
                throw new SecurityCompromiseError(`Anonymous access to domain ${targetUrl.hostname} blocked until ${blockade.expireAt || 'Eternally'} due to previous abuse found on ${blockade.triggerUrl || 'site'}: ${blockade.triggerReason}`);
            }
        }
        const crawlOpts = await this.configure(crawlerOptions);
        if (auth.isInternal) {
            crawlOpts.eligibleForPageIndex = true;
            this.threadLocal.set('isInternal', true);
        }
        this.logger.info(`Accepting request from ${uid || ctx.ip}`, { opts: crawlerOptions });
        rpcReflect.finally(() => {
            if (!finalSnapshot) {
                return;
            }
            this.emit('index-snapshot', targetUrl, finalSnapshot, crawlOpts);
        });
        if (crawlerOptions.robotsTxt) {
            await this.robotsTxtService.assertAccessAllowed(targetUrl, crawlerOptions.robotsTxt);
        }
        if (rpcReflect.signal.aborted) {
            return;
        }
        rpcReflect.catch((err) => {
            if (!(err instanceof AssertionFailureError)) {
                return;
            }
            const nowDate = new Date();
            this.storageLayer.storeConsecutiveError({
                _id: this.getUrlDigest(targetUrl),
                url: targetUrl.toString(),
                lastError: `${err}`,
                updatedAt: nowDate,
                createdAt: nowDate,
                expireAt: new Date(Date.now() + this.abuseBlockMs),
                count: 1,
            }).catch((err) => {
                this.logger.warn(`Failed to save consecutive error for ${targetUrl}`, { err: marshalErrorLike(err) });
            });
        });
        if (!ctx.accepts('text/plain') && ctx.accepts('text/event-stream')) {
            const sseStream = new OutputServerEventStream();
            rpcReflect.return(sseStream);
            let scrapped: PageSnapshot;
            const seenSnapshot = new WeakSet();
            let job;
            const writeToStream = async () => {
                if (seenSnapshot.has(scrapped)) {
                    job = undefined;
                    return;
                }
                const formatted = await this.formatSnapshot(crawlerOptions, scrapped!, targetUrl, this.urlValidMs);
                seenSnapshot.add(scrapped);
                finalSnapshot = scrapped;
                chargeAmount = this.assignChargeAmount(formatted, tierPolicy);
                if (!sseStream.writableEnded) {
                    sseStream.write({
                        event: 'data',
                        data: formatted,
                    });
                }
                job = undefined;
            };

            try {
                for await (const snapshot of this.iterSnapshots(targetUrl, crawlOpts, crawlerOptions)) {
                    if (rpcReflect.signal.aborted || sseStream.writableEnded) {
                        break;
                    }
                    if (!snapshot) {
                        continue;
                    }
                    scrapped = snapshot;
                    if (job) {
                        continue;
                    }
                    job = writeToStream();

                    if (chargeAmount && scrapped.blobs?.length) {
                        break;
                    }
                }
            } catch (err: any) {
                this.logger.error(`Failed to crawl ${targetUrl}`, { err: marshalErrorLike(err) });
                await Promise.allSettled([job]).then(() => {
                    sseStream.end({
                        event: 'error',
                        data: marshalErrorLike(err),
                    });
                });

                return sseStream;
            }
            await writeToStream().catch((err) => {
                sseStream.write({
                    event: 'error',
                    data: marshalErrorLike(err),
                });
            });

            sseStream.end();

            return sseStream;
        }

        let lastScrapped;
        if (!ctx.accepts('text/plain') && (ctx.accepts('text/json') || ctx.accepts('application/json'))) {
            try {
                for await (const scrapped of this.iterSnapshots(targetUrl, crawlOpts, crawlerOptions)) {
                    if (rpcReflect.signal.aborted) {
                        break;
                    }
                    if (!scrapped) {
                        continue;
                    }
                    lastScrapped = scrapped;
                    if (!crawlerOptions.isSnapshotAcceptableForEarlyResponse(scrapped)) {
                        continue;
                    }
                    if (!scrapped.title && !scrapped.blobs?.length) {
                        continue;
                    }

                    const formatted = await this.formatSnapshot(crawlerOptions, scrapped, targetUrl, this.urlValidMs);
                    chargeAmount = this.assignChargeAmount(formatted, tierPolicy);

                    if (scrapped?.blobs?.length && !chargeAmount) {
                        continue;
                    }

                    return formatted;
                }
            } catch (err) {
                if (!lastScrapped) {
                    throw err;
                }
            }

            if (!lastScrapped) {
                if (crawlOpts.targetSelector) {
                    throw new AssertionFailureError(`No content available for URL ${targetUrl} with target selector ${Array.isArray(crawlOpts.targetSelector) ? crawlOpts.targetSelector.join(', ') : crawlOpts.targetSelector}`);
                }
                throw new AssertionFailureError(`No content available for URL ${targetUrl}`);
            }

            const formatted = await this.formatSnapshot(crawlerOptions, lastScrapped, targetUrl, this.urlValidMs);
            chargeAmount = this.assignChargeAmount(formatted, tierPolicy);
            finalSnapshot = lastScrapped;

            return formatted;
        }

        if (crawlerOptions.isRequestingCompoundContentFormat()) {
            throw new ParamValidationError({
                path: 'respondWith',
                message: `Looks like you might be requesting compound content format, please explicitly accept 'text/event-stream' or 'application/json' in header, or check your request.`
            });
        }

        try {
            for await (const scrapped of this.iterSnapshots(targetUrl, crawlOpts, crawlerOptions)) {
                if (rpcReflect.signal.aborted) {
                    break;
                }
                if (!scrapped) {
                    continue;
                }
                lastScrapped = scrapped;
                if (!crawlerOptions.isSnapshotAcceptableForEarlyResponse(scrapped)) {
                    continue;
                }
                if (!scrapped.title && !scrapped.blobs?.length) {
                    continue;
                }

                const formatted = await this.formatSnapshot(crawlerOptions, scrapped, targetUrl, this.urlValidMs);
                chargeAmount = this.assignChargeAmount(formatted, tierPolicy);
                finalSnapshot = lastScrapped;

                return this._finalFormat(crawlerOptions, formatted);
            }
        } catch (err) {
            if (!lastScrapped) {
                throw err;
            }
        }

        if (!lastScrapped) {
            if (crawlOpts.targetSelector) {
                throw new AssertionFailureError(`No content available for URL ${targetUrl} with target selector ${Array.isArray(crawlOpts.targetSelector) ? crawlOpts.targetSelector.join(', ') : crawlOpts.targetSelector}`);
            }
            throw new AssertionFailureError(`No content available for URL ${targetUrl}`);
        }
        const formatted = await this.formatSnapshot(crawlerOptions, lastScrapped, targetUrl, this.urlValidMs);
        chargeAmount = this.assignChargeAmount(formatted, tierPolicy);
        finalSnapshot = lastScrapped;

        return this._finalFormat(crawlerOptions, formatted);
    }

    private _finalFormat(crawlerOptions: CrawlerOptions, formatted: FormattedPage) {
        const usage = extractMeta(formatted)?.usage?.tokens?.toString() || '0';
        const headerMixin = { 'X-Usage-Tokens': usage };
        if (crawlerOptions.respondWith === 'screenshot') {
            if (formatted.screenshotUrl) {
                return assignTransferProtocolMeta(`${formatted.textRepresentation}`,
                    { code: 302, envelope: null, headers: { Location: Reflect.get(formatted, 'screenshotUrl'), ...headerMixin } }
                );
            }
            if (formatted.screenshot) {
                return assignTransferProtocolMeta(formatted.screenshot,
                    { code: 200, envelope: null, contentType: 'image/png', headers: { ...headerMixin } }
                );
            }
        }
        if (crawlerOptions.respondWith === 'pageshot') {
            if (formatted.pageshotUrl) {
                return assignTransferProtocolMeta(`${formatted.textRepresentation}`,
                    { code: 302, envelope: null, headers: { Location: Reflect.get(formatted, 'pageshotUrl'), ...headerMixin } }
                );
            }
            if (formatted.pageshot) {
                return assignTransferProtocolMeta(formatted.pageshot,
                    { code: 200, envelope: null, contentType: 'image/png', headers: { ...headerMixin } }
                );
            }
        }

        return assignTransferProtocolMeta(`${formatted.textRepresentation}`, { contentType: 'text/plain; charset=utf-8', envelope: null, headers: { ...headerMixin } });
    }

    _attemptURLFix(inputUrl: string, hostname: string = '') {
        let url = inputUrl;
        let hostTrimer = hostTrimerRegexpMap.get(hostname);
        if (!hostTrimer) {
            hostTrimer = new RegExp(`^(https?:/+)?${hostname.replace(/\./g, '\\.')}/`, 'i');
            hostTrimerRegexpMap.set(hostname, hostTrimer);
        }
        url = url.replace(hostTrimer, '').replace(redundantProtocolRegexp, '$1');

        return url;
    }

    async getTargetUrl(originPath: string, crawlerOptions: CrawlerOptions, thisServerHost?: string) {
        let url: string = '';

        const targetUrlFromGet = originPath.slice(1);
        const binaryFile = crawlerOptions.pdf || crawlerOptions.file;
        if (
            binaryFile instanceof FancyFile && (await binaryFile.size) > 0 ||
            (typeof binaryFile === 'string' && binaryFile)
        ) {
            const identifier = binaryFile instanceof FancyFile ? (await binaryFile.sha256Sum) : randomUUID();
            url = `blob:${identifier}`;
            if (crawlerOptions.url && URL.canParse(crawlerOptions.url)) {
                const nominalUrl = new URL(crawlerOptions.url);
                if (nominalUrl.hash) {
                    url += nominalUrl.hash;
                }
            }
            crawlerOptions.url ??= url;
        } else if (targetUrlFromGet) {
            url = targetUrlFromGet.trim();
        } else if (crawlerOptions.url) {
            url = crawlerOptions.url.trim();
        } else if (crawlerOptions.html && !url) {
            url = `blob:${sha256Hasher.hash(crawlerOptions.html)}`;
        }

        url = this._attemptURLFix(url, thisServerHost);

        if (url && URL.canParse(url)) {
            url = new URL(url).href;
        }

        if (!url) {
            throw new ParamValidationError({
                message: 'No URL provided',
                path: 'url'
            });
        }

        const { url: safeURL, ips, hintCountry } = await this.miscService.assertNormalizedUrl(url);
        if (this.puppeteerControl.circuitBreakerHosts.has(safeURL.hostname.toLowerCase())) {
            throw new SecurityCompromiseError({
                message: `Circular hostname: ${safeURL.hostname}`,
                path: 'url'
            });
        }
        crawlerOptions._hintIps = ips;
        crawlerOptions._hintCountry = hintCountry;

        return safeURL;
    }

    getUrlDigest(urlToCrawl: URL) {
        const normalizedURL = new URL(urlToCrawl);
        if (!normalizedURL.hash.startsWith('#/')) {
            normalizedURL.hash = '';
        }
        const normalizedUrl = normalizedURL.toString().toLowerCase();
        const digest = md5Hasher.hash(normalizedUrl.toString());

        return digest;
    }

    async *queryCache(urlToCrawl: URL, cacheTolerance: number) {
        const digest = this.getUrlDigest(urlToCrawl);

        const cache = await this.storageLayer.findPageCache({ urlPathDigest: digest }).catch((err) => {
            this.logger.warn(`Failed to query cache, unknown issue`, { err });
            return undefined;
        });

        yield cache;

        if (!cache) {
            return;
        }

        const age = Date.now() - cache.createdAt.valueOf();
        const stale = cache.coerced ? false : cache.createdAt.valueOf() < (Date.now() - cacheTolerance);
        this.logger.info(`${stale ? 'Stale cache exists' : 'Cache hit'}${cache.coerced ? ' (coerced)' : ''} for ${urlToCrawl}, normalized digest: ${digest}, ${age}ms old, tolerance ${cacheTolerance}ms`, {
            url: urlToCrawl, digest, age, stale, cacheTolerance
        });

        let snapshot: PageSnapshot | undefined;

        const loadingOfSnapshot = this.storageLayer.readFile(`snapshots/${cache._id}`).then((r) => {
            snapshot = JSON.parse(r.toString('utf-8'));
            return snapshot;
        });

        const preparations: Promise<unknown>[] = [];

        let screenshotUrl: string | undefined;
        let pageshotUrl: string | undefined;

        if (cache.traits?.includes('blob')) {
            const rawSnapshot = await loadingOfSnapshot;
            const urlHash = urlToCrawl.hash.slice(1);
            let page = parseInt(urlHash, 10);
            if (page) {
                const cachedPage = rawSnapshot?.childFrames?.[page - 1];
                if (cachedPage) {
                    snapshot = cachedPage;
                } else {
                    page = 1;
                }
            } else {
                page = 1;
            }
            preparations.push(this.storageLayer.fileExists(`screenshots/${cache._id}/${page}`).then((r) => {
                if (!r) {
                    return;
                }
                return this.storageLayer.signDownloadUrl(`screenshots/${cache._id}/${page}`, Math.ceil(this.urlValidMs / 1000)).then((r) => {
                    screenshotUrl = r;
                });
            }));
        } else {
            preparations.push(loadingOfSnapshot);
            if (cache.screenshotAvailable) {
                preparations.push(
                    this.storageLayer.signDownloadUrl(`screenshots/${cache._id}`, Math.ceil(this.urlValidMs / 1000)).then((r) => {
                        screenshotUrl = r;
                    })
                );
            }
            if (cache.pageshotAvailable) {
                preparations.push(
                    this.storageLayer.signDownloadUrl(`pageshots/${cache._id}`, Math.ceil(this.urlValidMs / 1000)).then((r) => {
                        pageshotUrl = r;
                    })
                );
            }
        }

        try {
            await Promise.all(preparations);
        } catch (_err) {
            // Swallow cache errors.
            return undefined;
        }

        yield {
            isFresh: !stale,
            ...cache,
            snapshot: {
                ...snapshot,
                screenshot: undefined,
                pageshot: undefined,
                screenshotUrl,
                pageshotUrl,
            } as PageSnapshot
        };
    }

    async setToCache(urlToCrawl: URL, snapshot: PageSnapshot, pageIndex?: boolean) {
        const digest = this.getUrlDigest(urlToCrawl);

        this.storageLayer.clearConsecutiveError({ _id: digest }).catch((err) => {
            this.logger.warn(`Failed to delete consecutive error for ${urlToCrawl}`, { err, digest });
        });

        if (this.storageLayer.constructor !== StorageLayer) {
            this.logger.info(`Caching snapshot of ${urlToCrawl}...`, { url: urlToCrawl, digest, title: snapshot?.title, href: snapshot?.href });
        }
        const nowDate = new Date();

        const cache = Crawled.from({
            _id: digest,
            url: urlToCrawl.toString(),
            createdAt: nowDate,
            expireAt: new Date(nowDate.valueOf() + this.cacheRetentionMs),
            htmlSignificantlyModifiedByJs: snapshot.htmlSignificantlyModifiedByJs,
            urlPathDigest: digest,
            traits: snapshot.traits,
        });

        if (snapshot.childFrames?.length) {
            await Promise.all(snapshot.childFrames.map(async (childFrame, idx) => {
                if (!(childFrame.screenshotUrl && childFrame.screenshotUrl.startsWith('file:'))) {
                    return;
                }
                const furl = childFrame.screenshotUrl;
                delete childFrame.screenshotUrl;
                await this.storageLayer.storeFile(
                    `screenshots/${cache._id}/${idx + 1}`,
                    await readFile(fileURLToPath(furl)),
                    { 'Content-Type': 'image/png' }
                );
            }));
        }

        await this.storageLayer.storeFile(`snapshots/${cache._id}`,
            Buffer.from(
                JSON.stringify({
                    ...snapshot,
                    screenshot: undefined,
                    pageshot: undefined,
                }),
                'utf-8'
            ),
            {
                'Content-Type': 'application/json',
            }
        ).then((r) => {
            cache.snapshotAvailable = true;
            return r;
        });

        if (snapshot.screenshot) {
            await this.storageLayer.storeFile(`screenshots/${cache._id}`, snapshot.screenshot, {
                'Content-Type': 'image/png',
            });
            cache.screenshotAvailable = true;
        }
        if (snapshot.pageshot) {
            await this.storageLayer.storeFile(`pageshots/${cache._id}`, snapshot.pageshot, {
                'Content-Type': 'image/png',
            });
            cache.pageshotAvailable = true;
        }
        this.storageLayer.storePageCache(cache).catch((err) => {
            this.logger.error(`Failed to save cache for ${urlToCrawl}`, { err });

            return undefined;
        });
        if (pageIndex) {
            this.storageLayer.indexSnapshot(digest, {
                ...snapshot,
                screenshot: undefined,
                pageshot: undefined,
            }).catch((err) => {
                this.logger.warn(`Failed to add snapshot to indexedPage collection`, { err });
            });
        }

        return cache;
    }

    async *iterSnapshots(urlToCrawl: URL, crawlOpts?: ExtraScrappingOptions, crawlerOpts?: CrawlerOptions) {
        // if (crawlerOpts?.respondWith.includes(CONTENT_FORMAT.VLM)) {
        //     const finalBrowserSnapshot = await this.getFinalSnapshot(urlToCrawl, {
        //         ...crawlOpts, engine: ENGINE_TYPE.BROWSER
        //     }, crawlerOpts);

        //     yield* this.lmControl.geminiFromBrowserSnapshot(finalBrowserSnapshot);

        //     return;
        // }

        if (crawlerOpts?.respondWith.includes(CONTENT_FORMAT.READER_LM)) {
            const finalAutoSnapshot = await this.getFinalSnapshot(urlToCrawl, {
                ...crawlOpts,
                engine: crawlOpts?.engine || ENGINE_TYPE.AUTO,
            }, CrawlerOptions.from({
                ...crawlerOpts,
                respondWith: 'html',
            }));

            if (!finalAutoSnapshot?.html) {
                throw new AssertionFailureError(`Unexpected non HTML content for ReaderLM: ${urlToCrawl}`);
            }

            if (crawlerOpts?.instruction || crawlerOpts?.jsonSchema) {
                const jsonSchema = crawlerOpts.jsonSchema ? JSON.stringify(crawlerOpts.jsonSchema, undefined, 2) : undefined;
                yield* this.lmControl.readerLMFromSnapshot(crawlerOpts.instruction, jsonSchema, finalAutoSnapshot);

                return;
            }

            try {
                yield* this.lmControl.readerLMMarkdownFromSnapshot(finalAutoSnapshot);
            } catch (err) {
                if (err instanceof HTTPServiceError && err.status === 429) {
                    throw new ServiceNodeResourceDrainError(`Reader LM is at capacity, please try again later.`);
                }
                throw err;
            }

            return;
        }

        try {
            let badBlob = false;
            for await (const snapshot of this.cachedScrap(urlToCrawl, crawlOpts, crawlerOpts)) {
                if (!badBlob && snapshot?.blobs?.[0] && !snapshot.traits?.includes('blob')) {
                    const blobUrl = snapshot.blobs[0].url;
                    try {
                        const equivalentOpts = { ...crawlOpts, engine: ENGINE_TYPE.CURL };

                        yield* this.cachedScrap(new URL(blobUrl), equivalentOpts, crawlerOpts);
                        return;
                    } catch (err) {
                        badBlob = true;
                        this.logger.warn(`Failed to crawl blob URL ${snapshot.blobs[0].url} referenced from ${urlToCrawl}`, { err });
                    }
                }
                yield snapshot;
            }
        } catch (err) {
            if (err instanceof ServiceCrashedError) {
                // ignore this case, give anything at hand
                return;
            }
            throw err;
        }
    }

    async *cachedScrap(urlToCrawl: URL, crawlOpts?: ExtraScrappingOptions, crawlerOpts?: CrawlerOptions) {
        if (crawlerOpts?.html) {
            const htmlBuff = Buffer.from(crawlerOpts.html, 'utf-8');
            const digest = sha256Hasher.hash(htmlBuff, 'hex');
            const snapshot = await this.createSnapshotFromBlob(crawlOpts || {}, new URL(`blob:${digest}`), new Blob([htmlBuff], { type: 'text/html' }), 'text/html', `${digest}.html`);
            yield this.jsdomControl.narrowSnapshot(snapshot, crawlOpts);

            return;
        }

        let binaryFile = crawlerOpts?.pdf || crawlerOpts?.file;
        let blob: Blob | undefined;
        let digest: string | undefined;
        if (binaryFile) {
            if (binaryFile instanceof FancyFile && (await binaryFile.size) > 0) {
                const binFilePath = await binaryFile.filePath;
                blob = await openAsBlob(binFilePath, { type: await binaryFile.mimeType }) as any as Blob;
                digest = await binaryFile.sha256Sum;
                blob = new File([blob], await binaryFile.fileName || `${digest}`, { type: blob.type });
            } else if (typeof binaryFile === 'string') {
                const binBuffer = Buffer.from(binaryFile, 'base64');
                digest = sha256Hasher.hash(binBuffer, 'hex') as string;
                blob = new Blob([binBuffer], { type: await detectBuff(binBuffer).catch(() => 'application/octet-stream') });
            }
        }

        const urlDigest = this.getUrlDigest(urlToCrawl);
        const pConsecutiveError = this.storageLayer.findConsecutiveError({ _id: urlDigest, count: this.consecutiveErrorThreshold })
            .catch((err) => {
                this.logger.warn(`Failed to query consecutive error for ${urlToCrawl}`, { err, urlDigest });
                return undefined;
            });

        const cacheTolerance = crawlerOpts?.cacheTolerance ?? this.cacheValidMs;
        const cacheIt = this.queryCache(urlToCrawl, cacheTolerance);

        let cache = (await cacheIt.next()).value;

        if (!crawlerOpts || crawlerOpts.isCacheQueryApplicable()) {
            cache = (await cacheIt.next()).value;

            // Ignore cache if it has a Blob URL with search params.
            // Chances are the URL being temporal.
            let blobUrl = cache?.snapshot?.pdfs?.[0];
            blobUrl ??= cache?.snapshot?.blobs?.[0]?.url;

            if (blobUrl && URL.canParse(blobUrl)) {
                const blobUrlObj = new URL(blobUrl);
                if (blobUrlObj.search) {
                    cache = undefined;
                }
            }
        } else {
            cache = undefined;
        }
        cacheIt.return(undefined);

        if (blob && digest) {
            if (
                cache?.snapshot &&
                (!crawlOpts?.favorScreenshot || cache.snapshot?.screenshotUrl)
            ) {
                cache.snapshot.isFromCache = true;

                this.emit('index-snapshot', urlToCrawl, cache.snapshot, crawlOpts, 'cache');
                yield this.jsdomControl.narrowSnapshot(cache.snapshot, crawlOpts);

                return;
            }

            const snapshot = await this.createSnapshotFromBlob(crawlOpts || {}, urlToCrawl, blob, blob.type, (blob as File).name || `${digest}.${extOfMime(blob.type)}`);
            yield this.jsdomControl.narrowSnapshot(snapshot, crawlOpts);

            return;
        }

        const consecutiveError = await pConsecutiveError;

        if (cache?.isFresh &&
            (!crawlOpts?.favorScreenshot || ((cache.screenshotAvailable && cache.pageshotAvailable) || cache.snapshot?.screenshotUrl)) &&
            (_.get(cache.snapshot, 'locale') === crawlOpts?.locale)
        ) {
            if (cache.snapshot) {
                if ((cache.snapshot.pdfs?.length || cache.snapshot.blobs?.length) && consecutiveError) {
                    this.logger.warn(`Consecutive error for file ${urlToCrawl}, rejecting`, { url: urlToCrawl, digest: urlDigest, count: consecutiveError.count, expireAt: consecutiveError.expireAt });
                    throw new OperationNotAllowedError(`Consecutive error detected on file URL ${urlToCrawl} for too many times${consecutiveError.lastError ? ` (${consecutiveError.lastError})` : ''}, please retry after ${consecutiveError.expireAt?.toISOString()}.`);
                }

                cache.snapshot.isFromCache = true;
            }
            this.emit('index-snapshot', urlToCrawl, cache.snapshot, crawlOpts, 'cache');
            yield this.jsdomControl.narrowSnapshot(cache.snapshot, crawlOpts);

            return;
        }

        if (consecutiveError) {
            this.logger.warn(`Consecutive error for ${urlToCrawl}, rejecting`, { url: urlToCrawl, digest: urlDigest, count: consecutiveError.count, expireAt: consecutiveError.expireAt });
            throw new OperationNotAllowedError(`Consecutive error detected on URL ${urlToCrawl} for too many times${consecutiveError.lastError ? ` (${consecutiveError.lastError})` : ''}, please retry after ${consecutiveError.expireAt?.toISOString()}.`);
        }

        if (
            crawlOpts?.engine === ENGINE_TYPE.CURL ||
            // deprecated name
            crawlOpts?.engine === 'direct'
        ) {
            const equivalentOpts = { ...crawlOpts };
            const potentialPreviousResult = crawlOpts.sideLoad?.impersonate[urlToCrawl.href];
            if (potentialPreviousResult?.status === 200 && potentialPreviousResult.body) {
                let blob: Blob;
                if (potentialPreviousResult.body instanceof Blob) {
                    blob = potentialPreviousResult.body;
                } else {
                    blob = await openAsBlob(await potentialPreviousResult.body.filePath, { type: potentialPreviousResult.contentType || await potentialPreviousResult.body.mimeType }) as any as Blob;
                }

                const draftSnapshot = await this.createSnapshotFromBlob(equivalentOpts, urlToCrawl, blob, potentialPreviousResult.contentType);
                draftSnapshot.status = potentialPreviousResult.status;
                draftSnapshot.statusText = STATUS_CODES[potentialPreviousResult.status];
                draftSnapshot.lastModified = (potentialPreviousResult.headers?.['Last-Modified'] || potentialPreviousResult.headers?.['last-modified']) as string | undefined;
                draftSnapshot.geolocation = equivalentOpts?.countryHint;
                yield this.jsdomControl.narrowSnapshot(draftSnapshot, equivalentOpts);

                return;
            }

            const hint = equivalentOpts.sideLoad?.hint?.[urlToCrawl.href];
            if (hint?.headers) {
                equivalentOpts.extraHeaders ??= hint.headers as Record<string, string>;
            }
            if (hint?.cookies) {
                equivalentOpts.cookies ??= hint?.cookies;
            }

            let sideLoaded;
            try {
                sideLoaded = (equivalentOpts?.allocProxy && !equivalentOpts?.proxyUrl) ?
                    await this.sideLoadWithAllocatedProxy(urlToCrawl, equivalentOpts) :
                    await this.curlControl.sideLoadBlob(urlToCrawl, equivalentOpts);

            } catch (err) {
                if (err instanceof ServiceBadAttemptError) {
                    throw new AssertionFailureError(err.message);
                }
                throw err;
            }
            if (!sideLoaded?.file) {
                throw new AssertionFailureError(`Remote server did not return a body: ${urlToCrawl}`);
            }
            crawlOpts.sideLoad ??= sideLoaded.sideLoadOpts;
            const draftSnapshot = await this.createSnapshotFromBlob(equivalentOpts, sideLoaded.finalURL, sideLoaded.file, sideLoaded.contentType, sideLoaded.fileName);
            draftSnapshot.status = sideLoaded.status;
            draftSnapshot.statusText = sideLoaded.statusText;
            draftSnapshot.lastModified = sideLoaded.headers?.['Last-Modified'] || sideLoaded.headers?.['last-modified'];
            draftSnapshot.geolocation = crawlOpts?.countryHint;
            yield this.jsdomControl.narrowSnapshot(draftSnapshot, crawlOpts);
            return;
        }

        if (crawlOpts?.engine === ENGINE_TYPE.CF_BROWSER_RENDERING) {
            const html = await this.cfBrowserRendering.fetchContent(urlToCrawl.href);
            const snapshot = {
                href: urlToCrawl.toString(),
                html,
                title: '',
                text: '',
            } as PageSnapshot;
            snapshot.geolocation = crawlOpts?.countryHint;
            yield this.jsdomControl.narrowSnapshot(snapshot, crawlOpts);
            return;
        }

        if (cache?.htmlSignificantlyModifiedByJs === false) {
            if (crawlerOpts && crawlerOpts.timeout === undefined) {
                crawlerOpts.respondTiming ??= RESPOND_TIMING.HTML;
            }
        }

        let backUpSideLoadSnapshot;
        if (crawlOpts?.engine !== ENGINE_TYPE.BROWSER && !this.knownUrlThatSideLoadingWouldCrashTheBrowser(urlToCrawl)) {
            const sideLoadSnapshotPermitted = crawlerOpts?.browserIsNotRequired() &&
                [RESPOND_TIMING.HTML, RESPOND_TIMING.VISIBLE_CONTENT].includes(crawlerOpts.presumedRespondTiming);
            try {
                const altOpts = { ...crawlOpts };
                let sideLoaded = (crawlOpts?.allocProxy && !crawlOpts?.proxyUrl) ?
                    await this.sideLoadWithAllocatedProxy(urlToCrawl, altOpts) :
                    await this.curlControl.sideLoadBlob(urlToCrawl, altOpts).catch((err) => {
                        this.logger.warn(`Failed to side load ${urlToCrawl.origin}`, { err: marshalErrorLike(err), href: urlToCrawl.href });

                        if (err instanceof ApplicationError && !(err instanceof ServiceBadAttemptError)) {
                            return Promise.reject(err);
                        }

                        return this.sideLoadWithAllocatedProxy(urlToCrawl, altOpts);
                    });
                if (!sideLoaded.file) {
                    throw new ServiceBadAttemptError(`Remote server did not return a body: ${urlToCrawl}`);
                }
                const draftSnapshot = await this.createSnapshotFromBlob(
                    altOpts,
                    sideLoaded.finalURL, sideLoaded.file, sideLoaded.contentType, sideLoaded.fileName
                ).catch((err) => {
                    if (err instanceof AssertionFailureError) {
                        return Promise.reject(err);
                    }
                    if (err instanceof ApplicationError) {
                        return Promise.reject(new ServiceBadAttemptError(err.message));
                    }
                    return Promise.reject(err);
                });
                draftSnapshot.status = sideLoaded.status;
                draftSnapshot.statusText = sideLoaded.statusText;
                draftSnapshot.lastModified = sideLoaded.headers?.['Last-Modified'] || sideLoaded.headers?.['last-modified'];
                draftSnapshot.geolocation = crawlOpts?.countryHint;
                if (
                    (
                        sideLoaded.status === 200 ||
                        (REDIRECTION_CODES.has(sideLoaded.status) && !sideLoaded.headers?.location && !sideLoaded.headers?.Location)
                    ) &&
                    sideLoaded.contentType &&
                    !sideLoaded.contentType.startsWith('text/html') &&
                    !sideLoaded.contentType.startsWith('application/xhtml+xml')
                ) {
                    if (crawlOpts) {
                        crawlOpts.sideLoad ??= sideLoaded.sideLoadOpts;
                    }
                    yield draftSnapshot;
                    return;
                }

                let analyzed = await this.jsdomControl.analyzeHTMLTextLite(draftSnapshot.html);
                draftSnapshot.title ??= analyzed.title;
                draftSnapshot.isIntermediate = true;
                if (sideLoadSnapshotPermitted) {
                    yield this.jsdomControl.narrowSnapshot(draftSnapshot, crawlOpts);
                } else {
                    backUpSideLoadSnapshot = draftSnapshot;
                }
                let fallbackProxyIsUsed = false;
                if (
                    (!crawlOpts?.allocProxy || crawlOpts.allocProxy !== 'none') &&
                    !crawlOpts?.proxyUrl &&
                    (analyzed.tokens < 42 || sideLoaded.status !== 200) &&

                    // No point retrying with proxy in these cases
                    ![201, 202, 404, 405].includes(sideLoaded.status)
                ) {
                    const proxyLoaded = await this.sideLoadWithAllocatedProxy(urlToCrawl, altOpts);
                    if (!proxyLoaded.file) {
                        throw new ServiceBadAttemptError(`Remote server did not return a body: ${urlToCrawl}`);
                    }
                    const proxySnapshot = await this.createSnapshotFromBlob(
                        altOpts, sideLoaded.finalURL, proxyLoaded.file, proxyLoaded.contentType, proxyLoaded.fileName
                    ).catch((err) => {
                        if (err instanceof AssertionFailureError) {
                            return Promise.reject(err);
                        }
                        if (err instanceof ApplicationError) {
                            return Promise.reject(new ServiceBadAttemptError(err.message));
                        }
                        return Promise.reject(err);
                    });
                    proxySnapshot.status = proxyLoaded.status;
                    proxySnapshot.statusText = proxyLoaded.statusText;
                    proxySnapshot.lastModified = proxyLoaded.headers?.['Last-Modified'] || proxyLoaded.headers?.['last-modified'];
                    proxySnapshot.geolocation = crawlOpts?.countryHint;
                    if (proxyLoaded.status == 200 && proxyLoaded.contentType && !proxyLoaded.contentType.startsWith('text/html') && !proxyLoaded.contentType.startsWith('application/xhtml+xml')) {
                        if (crawlOpts) {
                            crawlOpts.sideLoad ??= sideLoaded.sideLoadOpts;
                        }
                        yield proxySnapshot;
                        return;
                    }
                    analyzed = await this.jsdomControl.analyzeHTMLTextLite(proxySnapshot.html);
                    if (proxyLoaded.status === 200 || analyzed.tokens >= 200) {
                        proxySnapshot.isIntermediate = true;
                        if (sideLoadSnapshotPermitted) {
                            if (crawlOpts) {
                                crawlOpts.sideLoad ??= proxyLoaded.sideLoadOpts;
                            }
                            yield this.jsdomControl.narrowSnapshot(proxySnapshot, crawlOpts);
                        } else {
                            backUpSideLoadSnapshot = proxySnapshot;
                        }
                        sideLoaded = proxyLoaded;
                        fallbackProxyIsUsed = true;
                    }
                }

                if (crawlOpts && (sideLoaded.status === 200 || analyzed.tokens >= 200 || crawlOpts.allocProxy)) {
                    this.logger.info(`Side load seems to work, applying to crawler.`, { url: urlToCrawl.href });
                    crawlOpts.sideLoad ??= sideLoaded.sideLoadOpts;
                    if (fallbackProxyIsUsed) {
                        this.logger.info(`Proxy seems to salvage the page`, { url: urlToCrawl.href });
                    }
                }
            } catch (err: any) {
                this.logger.warn(`Failed to side load ${urlToCrawl.origin}`, { err: marshalErrorLike(err), href: urlToCrawl.href });
                if (err instanceof ApplicationError &&
                    !(err instanceof ServiceBadAttemptError) &&
                    !(err instanceof DataStreamBrokenError)
                ) {
                    throw err;
                }
            }
        } else if (crawlOpts?.allocProxy && crawlOpts.allocProxy !== 'none' && !crawlOpts.proxyUrl) {
            const proxyUrl = await this.proxyProvider.alloc(this.figureOutBestProxyCountry(crawlOpts));
            crawlOpts.proxyUrl = proxyUrl.href;
        }

        let anythingYielded = false;
        try {
            if (crawlOpts?.targetSelector || crawlOpts?.removeSelector || crawlOpts?.withIframe || crawlOpts?.withShadowDom) {
                for await (const x of this.puppeteerControl.scrap(urlToCrawl, crawlOpts)) {
                    anythingYielded = true;
                    if (x) {
                        x.geolocation = crawlOpts?.countryHint;
                    }
                    yield this.jsdomControl.narrowSnapshot(x, crawlOpts);
                }

                if (!anythingYielded && backUpSideLoadSnapshot) {
                    yield this.jsdomControl.narrowSnapshot(backUpSideLoadSnapshot, crawlOpts);
                }

                return;
            }

            for await (const x of this.puppeteerControl.scrap(urlToCrawl, crawlOpts)) {
                anythingYielded = true;
                if (x) {
                    x.geolocation = crawlOpts?.countryHint;
                }
                yield x;
            }
            if (!anythingYielded && backUpSideLoadSnapshot) {
                yield this.jsdomControl.narrowSnapshot(backUpSideLoadSnapshot, crawlOpts);
            }

        } catch (err: any) {
            if (cache && !(err instanceof SecurityCompromiseError)) {
                this.logger.warn(`Failed to scrap ${urlToCrawl}, but a stale cache is available. Falling back to cache`, { err: marshalErrorLike(err) });
                yield this.jsdomControl.narrowSnapshot(cache.snapshot, crawlOpts);
                return;
            }
            if (!anythingYielded && backUpSideLoadSnapshot) {
                yield this.jsdomControl.narrowSnapshot(backUpSideLoadSnapshot, crawlOpts);
                this.logger.warn(`Failed to scrap ${urlToCrawl}, but a side-load is available. Falling back to side-load`, { err: marshalErrorLike(err) });
                return;
            }
            throw err;
        }
    }

    assignChargeAmount(formatted: FormattedPage, saasTierPolicy?: Parameters<typeof this.saasApplyTierPolicy>[0]) {
        if (!formatted) {
            return 0;
        }

        let amount = 0;
        if (formatted.content) {
            amount = estimateToken(formatted.content);
        } else if (formatted.description) {
            amount += estimateToken(formatted.description);
        }

        if (formatted.text) {
            amount += estimateToken(formatted.text);
        }

        if (formatted.html) {
            amount += estimateToken(formatted.html);
        }
        if (formatted.screenshotUrl || formatted.screenshot) {
            // OpenAI image token count for 1024x1024 image
            amount += 765;
        }

        if (isNaN(amount)) {
            // A flat rate is charged if anything goes wrong with token estimation.
            amount = 1000;
        }

        if (saasTierPolicy) {
            amount = this.saasApplyTierPolicy(saasTierPolicy, amount);
        }

        if (amount > 2_000_000) {
            // We decided it's not fair to charge above 2M tokens even though the page contains more.
            amount = 2_000_000;
        }

        Object.assign(formatted, { usage: { tokens: amount } });
        assignMeta(formatted, { usage: { tokens: amount } });

        return amount;
    }


    async *scrapMany(urls: URL[], options?: ExtraScrappingOptions, crawlerOpts?: CrawlerOptions) {
        const iterators = urls.map((url) => this.cachedScrap(url, options, crawlerOpts));

        const results: (PageSnapshot | undefined)[] = iterators.map((_x) => undefined);

        let nextDeferred = Defer();
        let concluded = false;

        const handler = async (it: AsyncGenerator<PageSnapshot | undefined>, idx: number) => {
            try {
                for await (const x of it) {
                    results[idx] = x;

                    if (x) {
                        nextDeferred.resolve();
                        nextDeferred = Defer();
                    }

                }
            } catch (err: any) {
                this.logger.warn(`Failed to scrap ${urls[idx]}`, { err: marshalErrorLike(err) });
            }
        };

        Promise.allSettled(
            iterators.map((it, idx) => handler(it, idx))
        ).finally(() => {
            concluded = true;
            nextDeferred.resolve();
        });

        yield results;

        try {
            while (!concluded) {
                await nextDeferred.promise;

                yield results;
            }
            yield results;
        } finally {
            for (const x of iterators) {
                x.return();
            }
        }
    }

    async configure(opts: CrawlerOptions) {

        this.threadLocal.set('withGeneratedAlt', opts.withGeneratedAlt);
        this.threadLocal.set('withLinksSummary', opts.withLinksSummary);
        this.threadLocal.set('withImagesSummary', opts.withImagesSummary);
        this.threadLocal.set('keepImgDataUrl', opts.keepImgDataUrl);
        this.threadLocal.set('cacheTolerance', opts.cacheTolerance);
        this.threadLocal.set('withIframe', opts.withIframe);
        this.threadLocal.set('withShadowDom', opts.withShadowDom);
        this.threadLocal.set('userAgent', opts.userAgent);
        if (opts.timeout) {
            this.threadLocal.set('timeout', opts.timeout * 1000);
        }
        this.threadLocal.set('retainImages', opts.retainImages);
        this.threadLocal.set('retainLinks', opts.retainLinks);
        this.threadLocal.set('noGfm', opts.noGfm);
        this.threadLocal.set('DNT', Boolean(opts.doNotTrack));
        if (opts.maxTokens) {
            this.threadLocal.set('maxTokens', opts.maxTokens);
        }
        if (opts.markdown) {
            this.threadLocal.set('turndownOpts', opts.markdown);
        }
        this.threadLocal.set('viewport', opts.viewport);
        if (opts.instruction) {
            this.threadLocal.set('instruction', opts.instruction);
        }
        if (opts.markdownChunking) {
            if (opts.markdown?.headingStyle) {
                opts.markdown.headingStyle = 'atx';
            }
            if (opts.markdownChunking.startsWith('s')) {
                this.threadLocal.set('markdownChunking', 'contextual');
            } else {
                this.threadLocal.set('markdownChunking', 'simple');
            }
            if (parseInt(opts.markdownChunking.substring(opts.markdownChunking.length - 1)) > 0) {
                this.threadLocal.set('markdownChunkingDepth', parseInt(opts.markdownChunking.substring(opts.markdownChunking.length - 1)));
            }
        }

        const crawlOpts: ExtraScrappingOptions = {
            proxyUrl: opts.proxyUrl,
            cookies: opts.setCookies,
            favorScreenshot: ['screenshot', 'pageshot'].some((x) => opts.respondWith.includes(x)),
            removeSelector: opts.removeSelector,
            targetSelector: opts.targetSelector,
            waitForSelector: opts.waitForSelector,
            overrideUserAgent: opts.userAgent,
            timeoutMs: opts.timeout ? opts.timeout * 1000 : undefined,
            withIframe: opts.withIframe,
            withShadowDom: opts.withShadowDom,
            locale: opts.locale,
            referer: opts.referer,
            viewport: opts.viewport,
            engine: opts.engine,
            allocProxy: opts.proxy?.endsWith('+') ? opts.proxy.slice(0, -1) : opts.proxy,
            proxyResources: (opts.proxyUrl || opts.proxy?.endsWith('+')) ? true : false,
            private: Boolean(opts.doNotTrack),
            readabilityRequired: opts.readabilityRequired(),
            extraHeaders: opts.customHeader,
        };

        if (crawlOpts.targetSelector?.length) {
            if (typeof crawlOpts.targetSelector === 'string') {
                crawlOpts.targetSelector = [crawlOpts.targetSelector];
            }
            for (const s of crawlOpts.targetSelector) {
                for (const e of s.split(',').map((x) => x.trim())) {
                    if (e.startsWith('*') || e.startsWith(':') || e.includes('*:')) {
                        throw new ParamValidationError({
                            message: `Unacceptable selector: '${e}'. We cannot accept match-all selector for performance reasons. Sorry.`,
                            path: 'targetSelector'
                        });
                    }
                }
            }
        }

        if (opts._hintCountry) {
            crawlOpts.countryHint = opts._hintCountry.toLowerCase();
        }

        if (opts.locale) {
            crawlOpts.extraHeaders ??= {};
            crawlOpts.extraHeaders['Accept-Language'] = opts.locale;
        }

        if (opts.respondWith.includes(CONTENT_FORMAT.VLM)) {
            crawlOpts.favorScreenshot = true;
        }

        if (opts.injectFrameScript?.length) {
            crawlOpts.injectFrameScripts = (await Promise.all(
                opts.injectFrameScript.map((x) => {
                    if (URL.canParse(x)) {
                        return fetch(x).then((r) => r.text());
                    }

                    return x;
                })
            )).filter(Boolean);
        }

        if (opts.injectPageScript?.length) {
            crawlOpts.injectPageScripts = (await Promise.all(
                opts.injectPageScript.map((x) => {
                    if (URL.canParse(x)) {
                        return fetch(x).then((r) => r.text());
                    }

                    return x;
                })
            )).filter(Boolean);
        }
        if (opts.removeOverlay) {
            crawlOpts.injectPageScripts ??= [];
            crawlOpts.injectPageScripts.push(`
(() => {
    const handler = ()=> {
        let overlay;
        while (overlay = detectOverlay()) {
            let elem = overlay.parentElement;
            overlay.remove();
            while (elem !== document.body) {
                const boundingRect = elem.getBoundingClientRect();
                if (boundingRect.width * boundingRect.height === 0) {
                    const tmp = elem;
                    elem = elem.parentElement;
                    tmp.remove();
                    continue;
                }
                break;
            }
        }
    };
    window.addEventListener('load', handler);
    document.addEventListener('DOMContentLoaded', handler);
    document.addEventListener('mutationIdle', handler);
})();
`);
        }

        (crawlOpts as CURLScrappingOptions).maxSize ??= 1024 * 1024 * 1024; // 1GB

        return crawlOpts;
    }

    protected async formatSnapshot(
        crawlerOptions: CrawlerOptions,
        snapshot: PageSnapshot & {
            screenshotUrl?: string;
            pageshotUrl?: string;
        },
        nominalUrl: URL,
        urlValidMs?: number,
    ) {
        const presumedURL = crawlerOptions.base === 'final' ? new URL(snapshot.href) : nominalUrl;

        const respondWith = crawlerOptions.respondWith;
        if (respondWith === CONTENT_FORMAT.READER_LM || respondWith === CONTENT_FORMAT.VLM) {
            const output: FormattedPage = {
                title: snapshot.title,
                content: snapshot.parsed?.textContent,
                url: presumedURL?.href || snapshot.href,
            };

            return FormattedPageDto.from(output);
        }

        if (snapshot.imgs?.length && crawlerOptions.withGeneratedAlt) {
            const tasks = _.uniqBy((snapshot.imgs || []), 'src').map(async (x) => {
                const r = await this.altTextService.getAltText(x).catch((err: any) => {
                    this.logger.warn(`Failed to get alt text for ${x.src}`, { err });
                    return undefined;
                });
                if (r && x.src) {
                    return [x.src, r];
                }

                return undefined;
            });

            const pairs = (await Promise.all(tasks)).filter(Boolean) as [string, string][];
            const imgAltDict = _.fromPairs(pairs);

            for (const x of snapshot.imgs) {
                x.alt = imgAltDict[x.src] || x.alt;
            }
        }

        return this.snapshotFormatter.formatSnapshot(respondWith, snapshot, presumedURL, urlValidMs);
    }

    async getFinalSnapshot(url: URL, opts?: ExtraScrappingOptions, crawlerOptions?: CrawlerOptions): Promise<PageSnapshot | undefined> {
        const it = this.cachedScrap(url, opts, crawlerOptions);

        let lastSnapshot;
        let lastError;
        try {
            for await (const x of it) {
                lastSnapshot = x;
            }
        } catch (err) {
            lastError = err;
        }

        if (!lastSnapshot && lastError) {
            throw lastError;
        }

        if (!lastSnapshot) {
            throw new AssertionFailureError(`No content available`);
        }

        return lastSnapshot;
    }

    async simpleCrawl(mode: string, url: URL, opts?: ExtraScrappingOptions) {
        const it = this.iterSnapshots(url, { ...opts, minIntervalMs: 500 });

        let lastSnapshot;
        let goodEnough = false;
        try {
            for await (const x of it) {
                lastSnapshot = x;

                if (goodEnough) {
                    break;
                }

                if (lastSnapshot?.parsed?.content) {
                    // After it's good enough, wait for next snapshot;
                    goodEnough = true;
                }
            }

        } catch (err) {
            if (lastSnapshot) {
                return this.snapshotFormatter.formatSnapshot(mode, lastSnapshot, url, this.urlValidMs);
            }

            throw err;
        }

        if (!lastSnapshot) {
            throw new AssertionFailureError(`No content available`);
        }

        return this.snapshotFormatter.formatSnapshot(mode, lastSnapshot, url, this.urlValidMs);
    }

    getDomainProfileUrlDigest(url: URL) {
        const pathname = url.pathname;
        const pathVec = pathname.split('/');
        const parentPath = pathVec.slice(0, -1).join('/');

        const finalPath = parentPath || pathname;

        const key = url.origin.toLocaleLowerCase() + finalPath;

        return {
            digest: md5Hasher.hash(key),
            path: finalPath,
        };
    }

    proxyIterMap = new WeakMap<ExtraScrappingOptions, ReturnType<ProxyProviderService['iterAlloc']>>();
    @retryWith((err) => {
        if (err instanceof ServiceBadApproachError) {
            return false;
        }
        if (err instanceof ServiceBadAttemptError) {
            // Keep trying
            return true;
        }
        if (err instanceof ApplicationError) {
            // Quit with this error
            return false;
        }
        return undefined;
    }, 3)
    async sideLoadWithAllocatedProxy(url: URL, opts?: ExtraScrappingOptions) {
        if (opts?.allocProxy === 'none') {
            return this.curlControl.sideLoadBlob(url, opts);
        }
        let proxy;
        if (opts) {
            let it = this.proxyIterMap.get(opts);
            if (!it) {
                it = this.proxyProvider.iterAlloc(this.figureOutBestProxyCountry(opts));
                this.proxyIterMap.set(opts, it);
            }
            proxy = (await it.next()).value;
        }

        proxy ??= await this.proxyProvider.alloc(this.figureOutBestProxyCountry(opts));
        this.logger.debug(`Proxy allocated`, { proxy: proxy.href });
        const r = await this.curlControl.sideLoadBlob(url, {
            ...opts,
            proxyUrl: proxy.href,
        });

        if (opts && opts.allocProxy) {
            opts.proxyUrl ??= proxy.href;
        }

        return { ...r, proxy };
    }

    protected figureOutBestProxyCountry(opts?: ExtraScrappingOptions) {
        if (!opts) {
            return 'auto';
        }

        let draft;

        if (opts.allocProxy) {
            if (this.proxyProvider.supports(opts.allocProxy)) {
                draft = opts.allocProxy;
            } else if (opts.allocProxy === 'none') {
                return 'none';
            }
        }

        if (opts.countryHint) {
            if (this.proxyProvider.supports(opts.countryHint)) {
                draft ??= opts.countryHint;
            }
        }

        draft ??= opts.allocProxy || 'auto';

        return draft;
    }

    knownUrlThatSideLoadingWouldCrashTheBrowser(url: URL) {
        if (url.hostname === 'chromewebstore.google.com') {
            return true;
        }

        return false;
    }

    async saasAssertTierPolicy(opts: CrawlerOptions, auth: BaseAuthDTO) {
        let chargeScalar = 1;
        let minimalCharge = 0;

        if (opts.withGeneratedAlt) {
            await auth.assertTier(0, 'Alt text generation');
            minimalCharge = 765;
        }

        if (opts.injectPageScript || opts.injectFrameScript) {
            await auth.assertTier(0, 'Script injection');
            minimalCharge = 4_000;
        }

        if (opts.withIframe) {
            await auth.assertTier(0, 'Iframe');
        }

        if (opts.engine === ENGINE_TYPE.CF_BROWSER_RENDERING) {
            await auth.assertTier(0, 'Cloudflare browser rendering');
            minimalCharge = 4_000;
        }

        if (opts.engine === ENGINE_TYPE.BROWSER && opts.respondWith.includes('html')) {
            await auth.assertTier(0, 'Browser rendered HTML');
        }

        if (opts.respondWith.includes('lm') || opts.engine?.includes('lm')) {
            await auth.assertTier(0, 'Language model');
            minimalCharge = 4_000;
            chargeScalar = 3;
        }

        if (opts.proxy && opts.proxy !== 'none') {
            await auth.assertTier(['auto', 'any'].includes(opts.proxy) ? 0 : 2, 'Proxy allocation');
            chargeScalar = 5;
        }

        return {
            budget: opts.tokenBudget || 0,
            chargeScalar,
            minimalCharge,
        };
    }

    saasApplyTierPolicy(policy: Awaited<ReturnType<typeof this.saasAssertTierPolicy>>, chargeAmount: number) {
        const effectiveChargeAmount = policy.chargeScalar * Math.max(chargeAmount, policy.minimalCharge);
        if (policy.budget && policy.budget < effectiveChargeAmount) {
            throw new BudgetExceededError(`Token budget (${policy.budget}) exceeded, intended charge amount ${effectiveChargeAmount}`);
        }

        return effectiveChargeAmount;
    }

    async createSnapshotFromBlob(scrappingOptions: ExtraScrappingOptions, url: URL, blob: Blob, contentType?: string, fileName?: string) {
        const rawSnapshot = await this.binaryExtractorService.createSnapshotFromBlob(url, blob, contentType, fileName);

        process.nextTick(
            this.threadLocal.bridged(
                () => {
                    this.emit('index-snapshot', url, rawSnapshot, scrappingOptions, 'blob');
                }
            )
        );

        if (!rawSnapshot.childFrames?.length) {
            return rawSnapshot;
        }

        const urlHash = url.hash.slice(1);
        const page = parseInt(urlHash, 10);
        if (page >= 1 && page <= rawSnapshot.childFrames.length) {
            return rawSnapshot.childFrames[page - 1];
        }

        return rawSnapshot;
    }

}
