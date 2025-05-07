import { singleton } from 'tsyringe';
import { pathToFileURL } from 'url';
import { randomUUID } from 'crypto';
import _ from 'lodash';

import {
    assignTransferProtocolMeta, RPCHost, RPCReflection,
    AssertionFailureError, ParamValidationError,
    RawString,
    ApplicationError,
    DataStreamBrokenError,
    assignMeta,
} from 'civkit/civ-rpc';
import { marshalErrorLike } from 'civkit/lang';
import { Defer } from 'civkit/defer';
import { retryWith } from 'civkit/decorators';
import { FancyFile } from 'civkit/fancy-file';

import { CONTENT_FORMAT, CrawlerOptions, CrawlerOptionsHeaderOnly, ENGINE_TYPE, RESPOND_TIMING } from '../dto/crawler-options';

import { Crawled } from '../db/crawled';
import { DomainBlockade } from '../db/domain-blockade';
import { OutputServerEventStream } from '../lib/transform-server-event-stream';

import { PageSnapshot, PuppeteerControl, ScrappingOptions } from '../services/puppeteer';
import { JSDomControl } from '../services/jsdom';
import { FormattedPage, md5Hasher, SnapshotFormatter } from '../services/snapshot-formatter';
import { CurlControl } from '../services/curl';
import { LmControl } from '../services/lm';
import { tryDecodeURIComponent } from '../utils/misc';
import { CFBrowserRendering } from '../services/cf-browser-rendering';

import { GlobalLogger } from '../services/logger';
import { RateLimitControl, RateLimitDesc } from '../shared/services/rate-limit';
import { AsyncLocalContext } from '../services/async-context';
import { Context, Ctx, Method, Param, RPCReflect } from '../services/registry';
import {
    BudgetExceededError, InsufficientBalanceError,
    SecurityCompromiseError, ServiceBadApproachError, ServiceBadAttemptError,
    ServiceNodeResourceDrainError
} from '../services/errors';

import { countGPTToken as estimateToken } from '../shared/utils/openai';
import { ProxyProviderService } from '../shared/services/proxy-provider';
import { FirebaseStorageBucketControl } from '../shared/services/firebase-storage-bucket';
import { JinaEmbeddingsAuthDTO } from '../dto/jina-embeddings-auth';
import { RobotsTxtService } from '../services/robots-text';
import { TempFileManager } from '../services/temp-file';
import { MiscService } from '../services/misc';
import { HTTPServiceError } from 'civkit/http';
import { GeoIPService } from '../services/geoip';

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

@singleton()
export class CrawlerHost extends RPCHost {
    logger = this.globalLogger.child({ service: this.constructor.name });

    cacheRetentionMs = 1000 * 3600 * 24 * 7;
    cacheValidMs = 1000 * 3600;
    urlValidMs = 1000 * 3600 * 4;
    abuseBlockMs = 1000 * 3600;
    domainProfileRetentionMs = 1000 * 3600 * 24 * 30;

    batchedCaches: Crawled[] = [];

    constructor(
        protected globalLogger: GlobalLogger,
        protected puppeteerControl: PuppeteerControl,
        protected curlControl: CurlControl,
        protected cfBrowserRendering: CFBrowserRendering,
        protected proxyProvider: ProxyProviderService,
        protected lmControl: LmControl,
        protected jsdomControl: JSDomControl,
        protected snapshotFormatter: SnapshotFormatter,
        protected firebaseObjectStorage: FirebaseStorageBucketControl,
        protected rateLimitControl: RateLimitControl,
        protected threadLocal: AsyncLocalContext,
        protected robotsTxtService: RobotsTxtService,
        protected tempFileManager: TempFileManager,
        protected geoIpService: GeoIPService,
        protected miscService: MiscService,
    ) {
        super(...arguments);

        puppeteerControl.on('crawled', async (snapshot: PageSnapshot, options: ExtraScrappingOptions & { url: URL; }) => {
            if (!snapshot.title?.trim() && !snapshot.pdfs?.length) {
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
            if (snapshot.isIntermediate) {
                return;
            }
            if (!snapshot.lastMutationIdle) {
                // Never reached mutationIdle, presumably too short timeout
                return;
            }
            if (options.locale) {
                Reflect.set(snapshot, 'locale', options.locale);
            }

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

            await this.setToCache(options.url, snapshot);
        });

        puppeteerControl.on('abuse', async (abuseEvent: { url: URL; reason: string, sn: number; }) => {
            this.logger.warn(`Abuse detected on ${abuseEvent.url}, blocking ${abuseEvent.url.hostname}`, { reason: abuseEvent.reason, sn: abuseEvent.sn });

            await DomainBlockade.save(DomainBlockade.from({
                domain: abuseEvent.url.hostname.toLowerCase(),
                triggerReason: `${abuseEvent.reason}`,
                triggerUrl: abuseEvent.url.toString(),
                createdAt: new Date(),
                expireAt: new Date(Date.now() + this.abuseBlockMs),
            })).catch((err) => {
                this.logger.warn(`Failed to save domain blockade for ${abuseEvent.url.hostname}`, { err: marshalErrorLike(err) });
            });

        });

        setInterval(() => {
            const thisBatch = this.batchedCaches;
            this.batchedCaches = [];
            if (!thisBatch.length) {
                return;
            }
            const batch = Crawled.DB.batch();

            for (const x of thisBatch) {
                batch.set(Crawled.COLLECTION.doc(x._id), x.degradeForFireStore(), { merge: true });
            }

            batch.commit()
                .then(() => {
                    this.logger.debug(`Saved ${thisBatch.length} caches by batch`);
                })
                .catch((err) => {
                    this.logger.warn(`Failed to save cache in batch`, { err });
                });
        }, 1000 * 10 + Math.round(1000 * Math.random())).unref();
    }

    override async init() {
        await this.dependencyReady();

        if (this.puppeteerControl.effectiveUA) {
            this.curlControl.impersonateChrome(this.puppeteerControl.effectiveUA);
        }

        this.emit('ready');
    }

    async getIndex(auth?: JinaEmbeddingsAuthDTO) {
        const indexObject: Record<string, string | number | undefined> = Object.create(indexProto);
        Object.assign(indexObject, {
            usage1: 'https://r.jina.ai/YOUR_URL',
            usage2: 'https://s.jina.ai/YOUR_SEARCH_QUERY',
            homepage: 'https://jina.ai/reader',
        });

        await auth?.solveUID();
        if (auth && auth.user) {
            indexObject[''] = undefined;
            indexObject.authenticatedAs = `${auth.user.user_id} (${auth.user.full_name})`;
            indexObject.balanceLeft = auth.user.wallet.total_balance;
        }

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
    async getIndexCtrl(@Ctx() ctx: Context, @Param({ required: false }) auth?: JinaEmbeddingsAuthDTO) {
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
        auth: JinaEmbeddingsAuthDTO,
        crawlerOptionsHeaderOnly: CrawlerOptionsHeaderOnly,
        crawlerOptionsParamsAllowed: CrawlerOptions,
    ) {
        const uid = await auth.solveUID();
        let chargeAmount = 0;
        const crawlerOptions = ctx.method === 'GET' ? crawlerOptionsHeaderOnly : crawlerOptionsParamsAllowed;
        const tierPolicy = await this.saasAssertTierPolicy(crawlerOptions, auth);

        // Use koa ctx.URL, a standard URL object to avoid node.js framework prop naming confusion
        const targetUrl = await this.getTargetUrl(tryDecodeURIComponent(`${ctx.URL.pathname}${ctx.URL.search}`), crawlerOptions);
        if (!targetUrl) {
            return await this.getIndex(auth);
        }

        // Prevent circular crawling
        this.puppeteerControl.circuitBreakerHosts.add(
            ctx.hostname.toLowerCase()
        );

        if (uid) {
            const user = await auth.assertUser();
            if (!(user.wallet.total_balance > 0)) {
                throw new InsufficientBalanceError(`Account balance not enough to run this query, please recharge.`);
            }

            const rateLimitPolicy = auth.getRateLimits('CRAWL') || [
                parseInt(user.metadata?.speed_level) >= 2 ?
                    RateLimitDesc.from({
                        occurrence: 5000,
                        periodSeconds: 60
                    }) :
                    RateLimitDesc.from({
                        occurrence: 500,
                        periodSeconds: 60
                    })
            ];

            const apiRoll = await this.rateLimitControl.simpleRPCUidBasedLimit(
                rpcReflect, uid, ['CRAWL'],
                ...rateLimitPolicy
            );

            rpcReflect.finally(() => {
                if (crawlerOptions.tokenBudget && chargeAmount > crawlerOptions.tokenBudget) {
                    return;
                }
                if (chargeAmount) {
                    auth.reportUsage(chargeAmount, `reader-crawl`).catch((err) => {
                        this.logger.warn(`Unable to report usage for ${uid}`, { err: marshalErrorLike(err) });
                    });
                    apiRoll.chargeAmount = chargeAmount;
                }
            });
        } else if (ctx.ip) {
            const apiRoll = await this.rateLimitControl.simpleRpcIPBasedLimit(rpcReflect, ctx.ip, ['CRAWL'],
                [
                    // 20 requests per minute
                    new Date(Date.now() - 60 * 1000), 20
                ]
            );

            rpcReflect.finally(() => {
                if (crawlerOptions.tokenBudget && chargeAmount > crawlerOptions.tokenBudget) {
                    return;
                }
                apiRoll.chargeAmount = chargeAmount;
            });
        }

        if (!uid) {
            // Enforce no proxy is allocated for anonymous users due to abuse.
            crawlerOptions.proxy = 'none';
            const blockade = (await DomainBlockade.fromFirestoreQuery(
                DomainBlockade.COLLECTION
                    .where('domain', '==', targetUrl.hostname.toLowerCase())
                    .where('expireAt', '>=', new Date())
                    .limit(1)
            ))[0];
            if (blockade) {
                throw new SecurityCompromiseError(`Domain ${targetUrl.hostname} blocked until ${blockade.expireAt || 'Eternally'} due to previous abuse found on ${blockade.triggerUrl || 'site'}: ${blockade.triggerReason}`);
            }
        }
        const crawlOpts = await this.configure(crawlerOptions);
        if (crawlerOptions.robotsTxt) {
            await this.robotsTxtService.assertAccessAllowed(targetUrl, crawlerOptions.robotsTxt);
        }
        if (rpcReflect.signal.aborted) {
            return;
        }
        if (!ctx.accepts('text/plain') && ctx.accepts('text/event-stream')) {
            const sseStream = new OutputServerEventStream();
            rpcReflect.return(sseStream);

            try {
                for await (const scrapped of this.iterSnapshots(targetUrl, crawlOpts, crawlerOptions)) {
                    if (!scrapped) {
                        continue;
                    }
                    if (rpcReflect.signal.aborted) {
                        break;
                    }

                    const formatted = await this.formatSnapshot(crawlerOptions, scrapped, targetUrl, this.urlValidMs, crawlOpts);
                    chargeAmount = this.assignChargeAmount(formatted, tierPolicy);
                    sseStream.write({
                        event: 'data',
                        data: formatted,
                    });
                    if (chargeAmount && scrapped.pdfs?.length) {
                        break;
                    }
                }
            } catch (err: any) {
                this.logger.error(`Failed to crawl ${targetUrl}`, { err: marshalErrorLike(err) });
                sseStream.write({
                    event: 'error',
                    data: marshalErrorLike(err),
                });
            }

            sseStream.end();

            return sseStream;
        }

        let lastScrapped;
        if (!ctx.accepts('text/plain') && (ctx.accepts('text/json') || ctx.accepts('application/json'))) {
            try {
                for await (const scrapped of this.iterSnapshots(targetUrl, crawlOpts, crawlerOptions)) {
                    lastScrapped = scrapped;
                    if (rpcReflect.signal.aborted) {
                        break;
                    }
                    if (!scrapped || !crawlerOptions.isSnapshotAcceptableForEarlyResponse(scrapped)) {
                        continue;
                    }
                    if (!scrapped.title) {
                        continue;
                    }

                    const formatted = await this.formatSnapshot(crawlerOptions, scrapped, targetUrl, this.urlValidMs, crawlOpts);
                    chargeAmount = this.assignChargeAmount(formatted, tierPolicy);

                    if (scrapped?.pdfs?.length && !chargeAmount) {
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

            const formatted = await this.formatSnapshot(crawlerOptions, lastScrapped, targetUrl, this.urlValidMs, crawlOpts);
            chargeAmount = this.assignChargeAmount(formatted, tierPolicy);

            return formatted;
        }

        if (crawlerOptions.isRequestingCompoundContentFormat()) {
            throw new ParamValidationError({
                path: 'respondWith',
                message: `You are requesting compound content format, please explicitly accept 'text/event-stream' or 'application/json' in header.`
            });
        }

        try {
            for await (const scrapped of this.iterSnapshots(targetUrl, crawlOpts, crawlerOptions)) {
                lastScrapped = scrapped;
                if (rpcReflect.signal.aborted) {
                    break;
                }
                if (!scrapped || !crawlerOptions.isSnapshotAcceptableForEarlyResponse(scrapped)) {
                    continue;
                }
                if (!scrapped.title) {
                    continue;
                }

                const formatted = await this.formatSnapshot(crawlerOptions, scrapped, targetUrl, this.urlValidMs, crawlOpts);
                chargeAmount = this.assignChargeAmount(formatted, tierPolicy);

                if (crawlerOptions.respondWith === 'screenshot' && Reflect.get(formatted, 'screenshotUrl')) {
                    return assignTransferProtocolMeta(`${formatted.textRepresentation}`,
                        { code: 302, envelope: null, headers: { Location: Reflect.get(formatted, 'screenshotUrl') } }
                    );
                }
                if (crawlerOptions.respondWith === 'pageshot' && Reflect.get(formatted, 'pageshotUrl')) {
                    return assignTransferProtocolMeta(`${formatted.textRepresentation}`,
                        { code: 302, envelope: null, headers: { Location: Reflect.get(formatted, 'pageshotUrl') } }
                    );
                }

                return assignTransferProtocolMeta(`${formatted.textRepresentation}`, { contentType: 'text/plain; charset=utf-8', envelope: null });
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
        const formatted = await this.formatSnapshot(crawlerOptions, lastScrapped, targetUrl, this.urlValidMs, crawlOpts);
        chargeAmount = this.assignChargeAmount(formatted, tierPolicy);

        if (crawlerOptions.respondWith === 'screenshot' && Reflect.get(formatted, 'screenshotUrl')) {

            return assignTransferProtocolMeta(`${formatted.textRepresentation}`,
                { code: 302, envelope: null, headers: { Location: Reflect.get(formatted, 'screenshotUrl') } }
            );
        }
        if (crawlerOptions.respondWith === 'pageshot' && Reflect.get(formatted, 'pageshotUrl')) {

            return assignTransferProtocolMeta(`${formatted.textRepresentation}`,
                { code: 302, envelope: null, headers: { Location: Reflect.get(formatted, 'pageshotUrl') } }
            );
        }

        return assignTransferProtocolMeta(`${formatted.textRepresentation}`, { contentType: 'text/plain; charset=utf-8', envelope: null });

    }

    async getTargetUrl(originPath: string, crawlerOptions: CrawlerOptions) {
        let url: string = '';

        const targetUrlFromGet = originPath.slice(1);
        if (crawlerOptions.pdf) {
            const pdfFile = crawlerOptions.pdf;
            const identifier = pdfFile instanceof FancyFile ? (await pdfFile.sha256Sum) : randomUUID();
            url = `blob://pdf/${identifier}`;
            crawlerOptions.url ??= url;
        } else if (targetUrlFromGet) {
            url = targetUrlFromGet.trim();
        } else if (crawlerOptions.url) {
            url = crawlerOptions.url.trim();
        }

        if (!url) {
            throw new ParamValidationError({
                message: 'No URL provided',
                path: 'url'
            });
        }

        const { url: safeURL, ips } = await this.miscService.assertNormalizedUrl(url);
        if (this.puppeteerControl.circuitBreakerHosts.has(safeURL.hostname.toLowerCase())) {
            throw new SecurityCompromiseError({
                message: `Circular hostname: ${safeURL.protocol}`,
                path: 'url'
            });
        }
        crawlerOptions._hintIps = ips;

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

        const cache = (
            await
                (Crawled.fromFirestoreQuery(
                    Crawled.COLLECTION.where('urlPathDigest', '==', digest).orderBy('createdAt', 'desc').limit(1)
                ).catch((err) => {
                    this.logger.warn(`Failed to query cache, unknown issue`, { err });
                    // https://github.com/grpc/grpc-node/issues/2647
                    // https://github.com/googleapis/nodejs-firestore/issues/1023
                    // https://github.com/googleapis/nodejs-firestore/issues/1023

                    return undefined;
                }))
        )?.[0];

        yield cache;

        if (!cache) {
            return;
        }

        const age = Date.now() - cache.createdAt.valueOf();
        const stale = cache.createdAt.valueOf() < (Date.now() - cacheTolerance);
        this.logger.info(`${stale ? 'Stale cache exists' : 'Cache hit'} for ${urlToCrawl}, normalized digest: ${digest}, ${age}ms old, tolerance ${cacheTolerance}ms`, {
            url: urlToCrawl, digest, age, stale, cacheTolerance
        });

        let snapshot: PageSnapshot | undefined;
        let screenshotUrl: string | undefined;
        let pageshotUrl: string | undefined;
        const preparations = [
            this.firebaseObjectStorage.downloadFile(`snapshots/${cache._id}`).then((r) => {
                snapshot = JSON.parse(r.toString('utf-8'));
            }),
            cache.screenshotAvailable ?
                this.firebaseObjectStorage.signDownloadUrl(`screenshots/${cache._id}`, Date.now() + this.urlValidMs).then((r) => {
                    screenshotUrl = r;
                }) :
                Promise.resolve(undefined),
            cache.pageshotAvailable ?
                this.firebaseObjectStorage.signDownloadUrl(`pageshots/${cache._id}`, Date.now() + this.urlValidMs).then((r) => {
                    pageshotUrl = r;
                }) :
                Promise.resolve(undefined)
        ];
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
            } as PageSnapshot & { screenshotUrl?: string; pageshotUrl?: string; }
        };
    }

    async setToCache(urlToCrawl: URL, snapshot: PageSnapshot) {
        const digest = this.getUrlDigest(urlToCrawl);

        this.logger.info(`Caching snapshot of ${urlToCrawl}...`, { url: urlToCrawl, digest, title: snapshot?.title, href: snapshot?.href });
        const nowDate = new Date();

        const cache = Crawled.from({
            _id: randomUUID(),
            url: urlToCrawl.toString(),
            createdAt: nowDate,
            expireAt: new Date(nowDate.valueOf() + this.cacheRetentionMs),
            htmlSignificantlyModifiedByJs: snapshot.htmlSignificantlyModifiedByJs,
            urlPathDigest: digest,
        });

        const savingOfSnapshot = this.firebaseObjectStorage.saveFile(`snapshots/${cache._id}`,
            Buffer.from(
                JSON.stringify({
                    ...snapshot,
                    screenshot: undefined,
                    pageshot: undefined,
                }),
                'utf-8'
            ),
            {
                metadata: {
                    contentType: 'application/json',
                }
            }
        ).then((r) => {
            cache.snapshotAvailable = true;
            return r;
        });

        if (snapshot.screenshot) {
            await this.firebaseObjectStorage.saveFile(`screenshots/${cache._id}`, snapshot.screenshot, {
                metadata: {
                    contentType: 'image/png',
                }
            });
            cache.screenshotAvailable = true;
        }
        if (snapshot.pageshot) {
            await this.firebaseObjectStorage.saveFile(`pageshots/${cache._id}`, snapshot.pageshot, {
                metadata: {
                    contentType: 'image/png',
                }
            });
            cache.pageshotAvailable = true;
        }
        await savingOfSnapshot;
        this.batchedCaches.push(cache);
        // const r = await Crawled.save(cache.degradeForFireStore()).catch((err) => {
        //     this.logger.error(`Failed to save cache for ${urlToCrawl}`, { err: marshalErrorLike(err) });

        //     return undefined;
        // });

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

        yield* this.cachedScrap(urlToCrawl, crawlOpts, crawlerOpts);
    }

    async *cachedScrap(urlToCrawl: URL, crawlOpts?: ExtraScrappingOptions, crawlerOpts?: CrawlerOptions) {
        if (crawlerOpts?.html) {
            const snapshot = {
                href: urlToCrawl.toString(),
                html: crawlerOpts.html,
                title: '',
                text: '',
            } as PageSnapshot;
            yield this.jsdomControl.narrowSnapshot(snapshot, crawlOpts);

            return;
        }

        if (crawlerOpts?.pdf) {
            const pdfFile = crawlerOpts.pdf instanceof FancyFile ? crawlerOpts.pdf : this.tempFileManager.cacheBuffer(Buffer.from(crawlerOpts.pdf, 'base64'));
            const pdfLocalPath = pathToFileURL((await pdfFile.filePath));
            const snapshot = {
                href: urlToCrawl.toString(),
                html: `<!DOCTYPE html><html><head></head><body style="height: 100%; width: 100%; overflow: hidden; margin:0px; background-color: rgb(82, 86, 89);"><embed style="position:absolute; left: 0; top: 0;" width="100%" height="100%" src="${crawlerOpts.url}"></body></html>`,
                title: '',
                text: '',
                pdfs: [pdfLocalPath.href],
            } as PageSnapshot;

            yield this.jsdomControl.narrowSnapshot(snapshot, crawlOpts);

            return;
        }

        if (
            crawlOpts?.engine === ENGINE_TYPE.CURL ||
            // deprecated name
            crawlOpts?.engine === 'direct'
        ) {
            let sideLoaded;
            try {
                sideLoaded = (crawlOpts?.allocProxy && !crawlOpts?.proxyUrl) ?
                    await this.sideLoadWithAllocatedProxy(urlToCrawl, crawlOpts) :
                    await this.curlControl.sideLoad(urlToCrawl, crawlOpts);

            } catch (err) {
                if (err instanceof ServiceBadAttemptError) {
                    throw new AssertionFailureError(err.message);
                }
                throw err;
            }
            if (!sideLoaded?.file) {
                throw new AssertionFailureError(`Remote server did not return a body: ${urlToCrawl}`);
            }
            const draftSnapshot = await this.snapshotFormatter.createSnapshotFromFile(urlToCrawl, sideLoaded.file, sideLoaded.contentType, sideLoaded.fileName);
            draftSnapshot.status = sideLoaded.status;
            draftSnapshot.statusText = sideLoaded.statusText;
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
            yield this.jsdomControl.narrowSnapshot(snapshot, crawlOpts);
            return;
        }

        const cacheTolerance = crawlerOpts?.cacheTolerance ?? this.cacheValidMs;
        const cacheIt = this.queryCache(urlToCrawl, cacheTolerance);

        let cache = (await cacheIt.next()).value;
        if (cache?.htmlSignificantlyModifiedByJs === false) {
            if (crawlerOpts && crawlerOpts.timeout === undefined) {
                crawlerOpts.respondTiming ??= RESPOND_TIMING.HTML;
            }
        }

        if (!crawlerOpts || crawlerOpts.isCacheQueryApplicable()) {
            cache = (await cacheIt.next()).value;
        }
        cacheIt.return(undefined);

        if (cache?.isFresh &&
            (!crawlOpts?.favorScreenshot || (crawlOpts?.favorScreenshot && (cache.screenshotAvailable && cache.pageshotAvailable))) &&
            (_.get(cache.snapshot, 'locale') === crawlOpts?.locale)
        ) {
            if (cache.snapshot) {
                cache.snapshot.isFromCache = true;
            }
            yield this.jsdomControl.narrowSnapshot(cache.snapshot, crawlOpts);

            return;
        }

        if (crawlOpts?.engine !== ENGINE_TYPE.BROWSER && !this.knownUrlThatSideLoadingWouldCrashTheBrowser(urlToCrawl)) {
            const sideLoadSnapshotPermitted = crawlerOpts?.browserIsNotRequired() &&
                [RESPOND_TIMING.HTML, RESPOND_TIMING.VISIBLE_CONTENT].includes(crawlerOpts.presumedRespondTiming);
            try {
                const altOpts = { ...crawlOpts };
                let sideLoaded = (crawlOpts?.allocProxy && !crawlOpts?.proxyUrl) ?
                    await this.sideLoadWithAllocatedProxy(urlToCrawl, altOpts) :
                    await this.curlControl.sideLoad(urlToCrawl, altOpts).catch((err) => {
                        this.logger.warn(`Failed to side load ${urlToCrawl.origin}`, { err: marshalErrorLike(err), href: urlToCrawl.href });

                        if (err instanceof ApplicationError && !(err instanceof ServiceBadAttemptError)) {
                            return Promise.reject(err);
                        }

                        return this.sideLoadWithAllocatedProxy(urlToCrawl, altOpts);
                    });
                if (!sideLoaded.file) {
                    throw new ServiceBadAttemptError(`Remote server did not return a body: ${urlToCrawl}`);
                }
                const draftSnapshot = await this.snapshotFormatter.createSnapshotFromFile(
                    urlToCrawl, sideLoaded.file, sideLoaded.contentType, sideLoaded.fileName
                ).catch((err) => {
                    if (err instanceof ApplicationError) {
                        return Promise.reject(new ServiceBadAttemptError(err.message));
                    }
                    return Promise.reject(err);
                });
                draftSnapshot.status = sideLoaded.status;
                draftSnapshot.statusText = sideLoaded.statusText;
                if (sideLoaded.status == 200 && !sideLoaded.contentType.startsWith('text/html')) {
                    yield draftSnapshot;
                    return;
                }

                let analyzed = await this.jsdomControl.analyzeHTMLTextLite(draftSnapshot.html);
                draftSnapshot.title ??= analyzed.title;
                draftSnapshot.isIntermediate = true;
                if (sideLoadSnapshotPermitted) {
                    yield this.jsdomControl.narrowSnapshot(draftSnapshot, crawlOpts);
                }
                let fallbackProxyIsUsed = false;
                if (
                    ((!crawlOpts?.allocProxy || crawlOpts.allocProxy !== 'none') && !crawlOpts?.proxyUrl) &&
                    (analyzed.tokens < 42 || sideLoaded.status !== 200)
                ) {
                    const proxyLoaded = await this.sideLoadWithAllocatedProxy(urlToCrawl, altOpts);
                    if (!proxyLoaded.file) {
                        throw new ServiceBadAttemptError(`Remote server did not return a body: ${urlToCrawl}`);
                    }
                    const proxySnapshot = await this.snapshotFormatter.createSnapshotFromFile(
                        urlToCrawl, proxyLoaded.file, proxyLoaded.contentType, proxyLoaded.fileName
                    ).catch((err) => {
                        if (err instanceof ApplicationError) {
                            return Promise.reject(new ServiceBadAttemptError(err.message));
                        }
                        return Promise.reject(err);
                    });
                    proxySnapshot.status = proxyLoaded.status;
                    proxySnapshot.statusText = proxyLoaded.statusText;
                    if (proxyLoaded.status === 200 && crawlerOpts?.browserIsNotRequired()) {
                    }
                    analyzed = await this.jsdomControl.analyzeHTMLTextLite(proxySnapshot.html);
                    if (proxyLoaded.status === 200 || analyzed.tokens >= 200) {
                        proxySnapshot.isIntermediate = true;
                        if (sideLoadSnapshotPermitted) {
                            yield this.jsdomControl.narrowSnapshot(proxySnapshot, crawlOpts);
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

        try {
            if (crawlOpts?.targetSelector || crawlOpts?.removeSelector || crawlOpts?.withIframe || crawlOpts?.withShadowDom) {
                for await (const x of this.puppeteerControl.scrap(urlToCrawl, crawlOpts)) {
                    yield this.jsdomControl.narrowSnapshot(x, crawlOpts);
                }

                return;
            }

            yield* this.puppeteerControl.scrap(urlToCrawl, crawlOpts);
        } catch (err: any) {
            if (cache && !(err instanceof SecurityCompromiseError)) {
                this.logger.warn(`Failed to scrap ${urlToCrawl}, but a stale cache is available. Falling back to cache`, { err: marshalErrorLike(err) });
                yield this.jsdomControl.narrowSnapshot(cache.snapshot, crawlOpts);
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

        if (saasTierPolicy) {
            amount = this.saasApplyTierPolicy(saasTierPolicy, amount);
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
        this.threadLocal.set('noGfm', opts.noGfm);
        this.threadLocal.set('DNT', Boolean(opts.doNotTrack));
        if (opts.markdown) {
            this.threadLocal.set('turndownOpts', opts.markdown);
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

        if (opts._hintIps?.length) {
            const hints = await this.geoIpService.lookupCities(opts._hintIps);
            const board: Record<string, number> = {};
            for (const x of hints) {
                if (x.country?.code) {
                    board[x.country.code] = (board[x.country.code] || 0) + 1;
                }
            }
            const hintCountry = _.maxBy(Array.from(Object.entries(board)), 1)?.[0];
            crawlOpts.countryHint = hintCountry?.toLowerCase();
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

        return crawlOpts;
    }

    protected async formatSnapshot(
        crawlerOptions: CrawlerOptions,
        snapshot: PageSnapshot & {
            screenshotUrl?: string;
            pageshotUrl?: string;
        },
        nominalUrl?: URL,
        urlValidMs?: number,
        scrappingOptions?: ScrappingOptions
    ) {
        const presumedURL = crawlerOptions.base === 'final' ? new URL(snapshot.href) : nominalUrl;

        const respondWith = crawlerOptions.respondWith;
        if (respondWith === CONTENT_FORMAT.READER_LM || respondWith === CONTENT_FORMAT.VLM) {
            const output: FormattedPage = {
                title: snapshot.title,
                content: snapshot.parsed?.textContent,
                url: presumedURL?.href || snapshot.href,
            };

            Object.defineProperty(output, 'textRepresentation', {
                value: snapshot.parsed?.textContent,
                enumerable: false,
            });

            return output;
        }

        return this.formatSnapshotWithPDFSideLoad(respondWith, snapshot, presumedURL, urlValidMs, scrappingOptions);
    }

    async formatSnapshotWithPDFSideLoad(mode: string, snapshot: PageSnapshot, nominalUrl?: URL, urlValidMs?: number, scrappingOptions?: ScrappingOptions) {
        const snapshotCopy = _.cloneDeep(snapshot);

        if (snapshotCopy.pdfs?.length) {
            const pdfUrl = snapshotCopy.pdfs[0];
            if (pdfUrl.startsWith('http')) {
                const sideLoaded = scrappingOptions?.sideLoad?.impersonate[pdfUrl];
                if (sideLoaded?.status === 200 && sideLoaded.body) {
                    snapshotCopy.pdfs[0] = pathToFileURL(await sideLoaded?.body.filePath).href;
                    return this.snapshotFormatter.formatSnapshot(mode, snapshotCopy, nominalUrl, urlValidMs);
                }

                const r = await this.curlControl.sideLoad(new URL(pdfUrl), scrappingOptions).catch((err) => {
                    if (err instanceof ServiceBadAttemptError) {
                        return Promise.reject(new AssertionFailureError(`Failed to load PDF(${pdfUrl}): ${err.message}`));
                    }

                    return Promise.reject(err);
                });
                if (r.status !== 200) {
                    throw new AssertionFailureError(`Failed to load PDF(${pdfUrl}): Server responded status ${r.status}`);
                }
                if (!r.contentType.includes('application/pdf')) {
                    throw new AssertionFailureError(`Failed to load PDF(${pdfUrl}): Server responded with wrong content type ${r.contentType}`);
                }
                if (!r.file) {
                    throw new AssertionFailureError(`Failed to load PDF(${pdfUrl}): Server did not return a body`);
                }
                snapshotCopy.pdfs[0] = pathToFileURL(await r.file.filePath).href;
            }
        }

        return this.snapshotFormatter.formatSnapshot(mode, snapshotCopy, nominalUrl, urlValidMs);
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
            return this.curlControl.sideLoad(url, opts);
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
        const r = await this.curlControl.sideLoad(url, {
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

    async saasAssertTierPolicy(opts: CrawlerOptions, auth: JinaEmbeddingsAuthDTO) {
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
}
