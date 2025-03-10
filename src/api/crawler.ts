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
} from 'civkit/civ-rpc';
import { marshalErrorLike } from 'civkit/lang';
import { Defer } from 'civkit/defer';
import { retryWith } from 'civkit/decorators';

import { CONTENT_FORMAT, CrawlerOptions, CrawlerOptionsHeaderOnly, ENGINE_TYPE } from '../dto/crawler-options';

import { Crawled } from '../db/crawled';
import { DomainBlockade } from '../db/domain-blockade';
import { DomainProfile } from '../db/domain-profile';
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
    SecurityCompromiseError, ServiceBadApproachError, ServiceBadAttemptError
} from '../services/errors';

import { countGPTToken as estimateToken } from '../shared/utils/openai';
import { ProxyProvider } from '../shared/services/proxy-provider';
import { FirebaseStorageBucketControl } from '../shared/services/firebase-storage-bucket';
import { JinaEmbeddingsAuthDTO } from '../dto/jina-embeddings-auth';
import { RobotsTxtService } from '../services/robots-text';
import { lookup } from 'dns/promises';
import { isIP } from 'net';

export interface ExtraScrappingOptions extends ScrappingOptions {
    withIframe?: boolean | 'quoted';
    withShadowDom?: boolean;
    targetSelector?: string | string[];
    removeSelector?: string | string[];
    keepImgDataUrl?: boolean;
    engine?: string;
    allocProxy?: string;
    private?: boolean;
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

    constructor(
        protected globalLogger: GlobalLogger,
        protected puppeteerControl: PuppeteerControl,
        protected curlControl: CurlControl,
        protected cfBrowserRendering: CFBrowserRendering,
        protected proxyProvider: ProxyProvider,
        protected lmControl: LmControl,
        protected jsdomControl: JSDomControl,
        protected snapshotFormatter: SnapshotFormatter,
        protected firebaseObjectStorage: FirebaseStorageBucketControl,
        protected rateLimitControl: RateLimitControl,
        protected threadLocal: AsyncLocalContext,
        protected robotsTxtService: RobotsTxtService,
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
    }

    override async init() {
        await this.dependencyReady();

        if (this.puppeteerControl.ua) {
            this.curlControl.impersonateChrome(this.puppeteerControl.ua.replace(/Headless/i, ''));
        }

        this.emit('ready');
    }

    async getIndex(auth?: JinaEmbeddingsAuthDTO) {
        const indexObject: Record<string, string | number | undefined> = Object.create(indexProto);
        // Object.assign(indexObject, {
        //     usage1: `${ctx.origin}/YOUR_URL`,
        //     usage2: `${ctx.origin}/search/YOUR_SEARCH_QUERY`,
        //     homepage: 'https://jina.ai/reader',
        //     sourceCode: 'https://github.com/jina-ai/reader',
        // });
        Object.assign(indexObject, {
            usage1: 'https://r.jina.ai/YOUR_URL',
            usage2: 'https://s.jina.ai/YOUR_SEARCH_QUERY',
            homepage: 'https://jina.ai/reader',
            sourceCode: 'https://github.com/jina-ai/reader',
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

            const rateLimitPolicy = auth.getRateLimits(rpcReflect.name.toUpperCase()) || [
                parseInt(user.metadata?.speed_level) >= 2 ?
                    RateLimitDesc.from({
                        occurrence: 1000,
                        periodSeconds: 60
                    }) :
                    RateLimitDesc.from({
                        occurrence: 200,
                        periodSeconds: 60
                    })
            ];

            const apiRoll = await this.rateLimitControl.simpleRPCUidBasedLimit(
                rpcReflect, uid, [rpcReflect.name.toUpperCase()],
                ...rateLimitPolicy
            );

            rpcReflect.finally(() => {
                if (crawlerOptions.tokenBudget && chargeAmount > crawlerOptions.tokenBudget) {
                    return;
                }
                if (chargeAmount) {
                    auth.reportUsage(chargeAmount, `reader-${rpcReflect.name}`).catch((err) => {
                        this.logger.warn(`Unable to report usage for ${uid}`, { err: marshalErrorLike(err) });
                    });
                    apiRoll.chargeAmount = chargeAmount;
                }
            });
        } else if (ctx.ip) {
            const apiRoll = await this.rateLimitControl.simpleRpcIPBasedLimit(rpcReflect, ctx.ip, [rpcReflect.name.toUpperCase()],
                [
                    // 20 requests per minute
                    new Date(Date.now() - 60 * 1000), 20
                ]
            );

            rpcReflect.finally(() => {
                if (crawlerOptions.tokenBudget && chargeAmount > crawlerOptions.tokenBudget) {
                    return;
                }
                if (chargeAmount) {
                    apiRoll._ref?.set({
                        chargeAmount,
                    }, { merge: true }).catch((err) => this.logger.warn(`Failed to log charge amount in apiRoll`, { err }));
                }
            });
        }

        if (!uid) {
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
                    chargeAmount = this.assignChargeAmount(formatted, crawlOpts);
                    if (crawlerOptions.tokenBudget && chargeAmount > crawlerOptions.tokenBudget) {
                        throw new BudgetExceededError(`Token budget (${crawlerOptions.tokenBudget}) exceeded, intended charge amount ${chargeAmount}.`);
                    }
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
            for await (const scrapped of this.iterSnapshots(targetUrl, crawlOpts, crawlerOptions)) {
                lastScrapped = scrapped;
                if (rpcReflect.signal.aborted) {
                    break;
                }
                if (!crawlerOptions.isEarlyReturnApplicable()) {
                    continue;
                }
                if (crawlerOptions.waitForSelector || !scrapped || await this.snapshotNotGoodEnough(scrapped)) {
                    continue;
                }

                const formatted = await this.formatSnapshot(crawlerOptions, scrapped, targetUrl, this.urlValidMs, crawlOpts);
                chargeAmount = this.assignChargeAmount(formatted, crawlOpts);

                if (crawlerOptions.tokenBudget && chargeAmount > crawlerOptions.tokenBudget) {
                    throw new BudgetExceededError(`Token budget (${crawlerOptions.tokenBudget}) exceeded, intended charge amount ${chargeAmount}.`);
                }

                if (scrapped?.pdfs?.length && !chargeAmount) {
                    continue;
                }

                return formatted;
            }

            if (!lastScrapped) {
                if (crawlOpts.targetSelector) {
                    throw new AssertionFailureError(`No content available for URL ${targetUrl} with target selector ${Array.isArray(crawlOpts.targetSelector) ? crawlOpts.targetSelector.join(', ') : crawlOpts.targetSelector}`);
                }
                throw new AssertionFailureError(`No content available for URL ${targetUrl}`);
            }

            const formatted = await this.formatSnapshot(crawlerOptions, lastScrapped, targetUrl, this.urlValidMs, crawlOpts);
            chargeAmount = this.assignChargeAmount(formatted, crawlOpts);
            if (crawlerOptions.tokenBudget && chargeAmount > crawlerOptions.tokenBudget) {
                throw new BudgetExceededError(`Token budget (${crawlerOptions.tokenBudget}) exceeded, intended charge amount ${chargeAmount}.`);
            }

            return formatted;
        }

        if (crawlerOptions.isRequestingCompoundContentFormat()) {
            throw new ParamValidationError({
                path: 'respondWith',
                message: `You are requesting compound content format, please explicitly accept 'text/event-stream' or 'application/json' in header.`
            });
        }

        for await (const scrapped of this.iterSnapshots(targetUrl, crawlOpts, crawlerOptions)) {
            lastScrapped = scrapped;
            if (rpcReflect.signal.aborted) {
                break;
            }
            if (!crawlerOptions.isEarlyReturnApplicable()) {
                continue;
            }

            if (crawlerOptions.waitForSelector || !scrapped || await this.snapshotNotGoodEnough(scrapped)) {
                continue;
            }

            const formatted = await this.formatSnapshot(crawlerOptions, scrapped, targetUrl, this.urlValidMs, crawlOpts);
            chargeAmount = this.assignChargeAmount(formatted, crawlOpts);
            if (crawlerOptions.tokenBudget && chargeAmount > crawlerOptions.tokenBudget) {
                throw new BudgetExceededError(`Token budget (${crawlerOptions.tokenBudget}) exceeded, intended charge amount ${chargeAmount}.`);
            }

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

        if (!lastScrapped) {
            if (crawlOpts.targetSelector) {
                throw new AssertionFailureError(`No content available for URL ${targetUrl} with target selector ${Array.isArray(crawlOpts.targetSelector) ? crawlOpts.targetSelector.join(', ') : crawlOpts.targetSelector}`);
            }
            throw new AssertionFailureError(`No content available for URL ${targetUrl}`);
        }

        const formatted = await this.formatSnapshot(crawlerOptions, lastScrapped, targetUrl, this.urlValidMs, crawlOpts);
        chargeAmount = this.assignChargeAmount(formatted, crawlOpts);
        if (crawlerOptions.tokenBudget && chargeAmount > crawlerOptions.tokenBudget) {
            throw new BudgetExceededError(`Token budget (${crawlerOptions.tokenBudget}) exceeded, intended charge amount ${chargeAmount}.`);
        }

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
        let url: string;

        const targetUrlFromGet = originPath.slice(1);
        if (crawlerOptions.pdf) {
            const pdfBuf = crawlerOptions.pdf instanceof Blob ? await crawlerOptions.pdf.arrayBuffer().then((x) => Buffer.from(x)) : Buffer.from(crawlerOptions.pdf, 'base64');
            url = `blob://pdf/${md5Hasher.hash(pdfBuf)}`;
        } else if (targetUrlFromGet) {
            url = targetUrlFromGet.trim();
        } else if (crawlerOptions.url) {
            url = crawlerOptions.url.trim();
        } else {
            return null;
        }

        let result: URL;
        const normalizeUrl = require('@esm2cjs/normalize-url').default;
        try {
            result = new URL(
                normalizeUrl(
                    url,
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


        if (this.puppeteerControl.circuitBreakerHosts.has(result.hostname.toLowerCase())) {
            throw new SecurityCompromiseError({
                message: `Circular hostname: ${result.protocol}`,
                path: 'url'
            });
        }

        const isIp = isIP(result.hostname);

        if (
            (result.hostname === 'localhost') ||
            (isIp && result.hostname.startsWith('127.'))
        ) {
            throw new SecurityCompromiseError({
                message: `Suspicious action: Request to localhost: ${result}`,
                path: 'url'
            });
        }

        if (!isIp) {
            await lookup(result.hostname).catch((err) => {
                if (err.code === 'ENOTFOUND') {
                    return Promise.reject(new ParamValidationError({
                        message: `Domain '${result.hostname}' could not be resolved`,
                        path: 'url'
                    }));
                }

                return;
            });
        }

        return result;
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

    async queryCache(urlToCrawl: URL, cacheTolerance: number) {
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

        if (!cache) {
            return undefined;
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

        return {
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
        const r = await Crawled.save(cache.degradeForFireStore()).catch((err) => {
            this.logger.error(`Failed to save cache for ${urlToCrawl}`, { err: marshalErrorLike(err) });

            return undefined;
        });

        return r;
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
            }, crawlerOpts);

            if (!finalAutoSnapshot?.html) {
                throw new AssertionFailureError(`Unexpected non HTML content for ReaderLM: ${urlToCrawl}`);
            }

            if (crawlerOpts?.instruction || crawlerOpts?.jsonSchema) {
                const jsonSchema = crawlerOpts.jsonSchema ? JSON.stringify(crawlerOpts.jsonSchema, undefined, 2) : undefined;
                yield* this.lmControl.readerLMFromSnapshot(crawlerOpts.instruction, jsonSchema, finalAutoSnapshot);

                return;
            }

            yield* this.lmControl.readerLMMarkdownFromSnapshot(finalAutoSnapshot);

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
            const pdfBuf = crawlerOpts.pdf instanceof Blob ? await crawlerOpts.pdf.arrayBuffer().then((x) => Buffer.from(x)) : Buffer.from(crawlerOpts.pdf, 'base64');
            const pdfDataUrl = `data:application/pdf;base64,${pdfBuf.toString('base64')}`;
            const snapshot = {
                href: urlToCrawl.toString(),
                html: `<!DOCTYPE html><html><head></head><body style="height: 100%; width: 100%; overflow: hidden; margin:0px; background-color: rgb(82, 86, 89);"><embed style="position:absolute; left: 0; top: 0;" width="100%" height="100%" src="${pdfDataUrl}"></body></html>`,
                title: '',
                text: '',
                pdfs: [pdfDataUrl],
            } as PageSnapshot;

            yield this.jsdomControl.narrowSnapshot(snapshot, crawlOpts);

            return;
        }

        if (crawlOpts?.engine === ENGINE_TYPE.DIRECT) {
            const sideLoaded = (crawlOpts?.allocProxy && !crawlOpts?.proxyUrl) ?
                await this.sideLoadWithAllocatedProxy(urlToCrawl, crawlOpts) :
                await this.curlControl.sideLoad(urlToCrawl, crawlOpts);
            if (!sideLoaded.file) {
                throw new ServiceBadAttemptError(`Remote server did not return a body: ${urlToCrawl}`);
            }
            const draftSnapshot = await this.snapshotFormatter.createSnapshotFromFile(urlToCrawl, sideLoaded.file, sideLoaded.contentType, sideLoaded.fileName);
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

        let cache;

        if (!crawlerOpts || crawlerOpts.isCacheQueryApplicable()) {
            const cacheTolerance = crawlerOpts?.cacheTolerance ?? this.cacheValidMs;
            cache = await this.queryCache(urlToCrawl, cacheTolerance);
        }

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
                let draftSnapshot = await this.snapshotFormatter.createSnapshotFromFile(
                    urlToCrawl, sideLoaded.file, sideLoaded.contentType, sideLoaded.fileName
                ).catch((err) => {
                    if (err instanceof ApplicationError) {
                        return Promise.reject(new ServiceBadAttemptError(err.message));
                    }
                    return Promise.reject(err);
                });
                if (sideLoaded.status == 200 && !sideLoaded.contentType.startsWith('text/html')) {
                    yield draftSnapshot;
                    return;
                }

                let analyzed = await this.jsdomControl.analyzeHTMLTextLite(draftSnapshot.html);
                draftSnapshot.title ??= analyzed.title;
                let fallbackProxyIsUsed = false;
                if (((!crawlOpts?.allocProxy || crawlOpts.allocProxy === 'none') && !crawlOpts?.proxyUrl) &&
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
                    analyzed = await this.jsdomControl.analyzeHTMLTextLite(proxySnapshot.html);
                    if (proxyLoaded.status === 200 || analyzed.tokens >= 200) {
                        draftSnapshot = proxySnapshot;
                        sideLoaded = proxyLoaded;
                        fallbackProxyIsUsed = true;
                    }
                }

                if (crawlOpts?.engine !== ENGINE_TYPE.BROWSER && crawlerOpts?.browserIsNotRequired()) {
                    yield draftSnapshot;
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
            crawlOpts.proxyUrl = (await this.proxyProvider.alloc(crawlOpts.allocProxy)).href;
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

    assignChargeAmount(formatted: FormattedPage, scrappingOptions?: ExtraScrappingOptions) {
        if (!formatted) {
            return 0;
        }

        let amount = 0;
        if (formatted.content) {
            const x1 = estimateToken(formatted.content);
            if (scrappingOptions?.engine?.toLowerCase().includes('lm')) {
                amount += x1 * 2;
            }
            amount += x1;
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

        Object.assign(formatted, { usage: { tokens: amount } });

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

        if (opts.locale) {
            crawlOpts.extraHeaders ??= {};
            crawlOpts.extraHeaders['Accept-Language'] = opts.locale;
        }

        if (opts.engine?.toLowerCase() === ENGINE_TYPE.VLM) {
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
                [Symbol.dispose]: () => undefined,
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

    async exploreDirectEngine(knownSnapshot: PageSnapshot) {
        const realUrl = new URL(knownSnapshot.href);
        const { digest, path } = this.getDomainProfileUrlDigest(realUrl);
        const profile = await DomainProfile.fromFirestore(digest);

        if (!profile) {
            const record = DomainProfile.from({
                _id: digest,
                origin: realUrl.origin.toLowerCase(),
                path,
                triggerUrl: realUrl.href,
                engine: knownSnapshot.htmlModifiedByJs ? ENGINE_TYPE.BROWSER : ENGINE_TYPE.DIRECT,
                createdAt: new Date(),
                expireAt: new Date(Date.now() + this.domainProfileRetentionMs),
            });
            await DomainProfile.save(record);

            return;
        }

        if (profile.engine === ENGINE_TYPE.BROWSER) {
            // Mixed engine, always use browser
            return;
        }

        profile.origin = realUrl.origin.toLowerCase();
        profile.triggerUrl = realUrl.href;
        profile.path = path;
        profile.engine = knownSnapshot.htmlModifiedByJs ? ENGINE_TYPE.BROWSER : ENGINE_TYPE.DIRECT;
        profile.expireAt = new Date(Date.now() + this.domainProfileRetentionMs);

        await DomainProfile.save(profile);

        return;
    }

    async snapshotNotGoodEnough(snapshot: PageSnapshot) {
        if (snapshot.pdfs?.length) {
            return false;
        }
        if (!snapshot.title) {
            return true;
        }
        if (snapshot.parsed?.content) {
            return false;
        }
        if (snapshot.html) {
            const r = await this.jsdomControl.analyzeHTMLTextLite(snapshot.html);
            const tokens = r.tokens;
            if (tokens < 200) {
                return true;
            }
        }
        return false;
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
        const proxy = await this.proxyProvider.alloc(opts?.allocProxy);
        const r = await this.curlControl.sideLoad(url, {
            ...opts,
            proxyUrl: proxy.href,
        });

        if (opts && opts.allocProxy) {
            opts.proxyUrl ??= proxy.href;
        }

        return { ...r, proxy };
    }

    knownUrlThatSideLoadingWouldCrashTheBrowser(url: URL) {
        if (url.hostname === 'chromewebstore.google.com') {
            return true;
        }

        return false;
    }
}
