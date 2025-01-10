import {
    assignTransferProtocolMeta, marshalErrorLike,
    RPCHost, RPCReflection,
    AssertionFailureError, ParamValidationError, Defer,
} from 'civkit';
import { singleton } from 'tsyringe';
import { AsyncContext, BudgetExceededError, CloudHTTPv2, Ctx, FirebaseStorageBucketControl, InsufficientBalanceError, Logger, OutputServerEventStream, RPCReflect, SecurityCompromiseError } from '../shared';
import { RateLimitControl, RateLimitDesc } from '../shared/services/rate-limit';
import _ from 'lodash';
import { PageSnapshot, PuppeteerControl, ScrappingOptions } from '../services/puppeteer';
import { Request, Response } from 'express';
import { Curl } from 'node-libcurl';
const pNormalizeUrl = import("@esm2cjs/normalize-url");
import { Crawled } from '../db/crawled';
import { randomUUID } from 'crypto';
import { JinaEmbeddingsAuthDTO } from '../shared/dto/jina-embeddings-auth';

import { countGPTToken as estimateToken } from '../shared/utils/openai';
import { CONTENT_FORMAT, CrawlerOptions, CrawlerOptionsHeaderOnly } from '../dto/scrapping-options';
import { JinaEmbeddingsTokenAccount } from '../shared/db/jina-embeddings-token-account';
import { DomainBlockade } from '../db/domain-blockade';
import { DomainProfile } from '../db/domain-profile';
import { FirebaseRoundTripChecker } from '../shared/services/firebase-roundtrip-checker';
import { JSDomControl } from '../services/jsdom';
import { FormattedPage, md5Hasher, SnapshotFormatter } from '../services/snapshot-formatter';

export interface ExtraScrappingOptions extends ScrappingOptions {
    withIframe?: boolean | 'quoted';
    withShadowDom?: boolean;
    targetSelector?: string | string[];
    removeSelector?: string | string[];
    keepImgDataUrl?: boolean;
    engine?: string;
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
        protected globalLogger: Logger,
        protected puppeteerControl: PuppeteerControl,
        protected jsdomControl: JSDomControl,
        protected snapshotFormatter: SnapshotFormatter,
        protected firebaseObjectStorage: FirebaseStorageBucketControl,
        protected rateLimitControl: RateLimitControl,
        protected threadLocal: AsyncContext,
        protected fbHealthCheck: FirebaseRoundTripChecker,
    ) {
        super(...arguments);

        puppeteerControl.on('crawled', async (snapshot: PageSnapshot, options: ScrappingOptions & { url: URL; }) => {
            if (!snapshot.title?.trim() && !snapshot.pdfs?.length) {
                return;
            }
            if (options.cookies?.length) {
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

        this.emit('ready');
    }

    getIndex(user?: JinaEmbeddingsTokenAccount) {
        const indexObject: Record<string, string | number | undefined> = Object.create(indexProto);

        Object.assign(indexObject, {
            usage1: 'https://r.jina.ai/YOUR_URL',
            usage2: 'https://s.jina.ai/YOUR_SEARCH_QUERY',
            homepage: 'https://jina.ai/reader',
            sourceCode: 'https://github.com/jina-ai/reader',
        });

        if (user) {
            indexObject[''] = undefined;
            indexObject.authenticatedAs = `${user.user_id} (${user.full_name})`;
            indexObject.balanceLeft = user.wallet.total_balance;
        }

        return indexObject;
    }

    @CloudHTTPv2({
        name: 'crawl2',
        runtime: {
            memory: '4GiB',
            timeoutSeconds: 300,
            concurrency: 22,
        },
        tags: ['Crawler'],
        httpMethod: ['get', 'post'],
        returnType: [String, OutputServerEventStream],
        exposeRoot: true,
    })
    @CloudHTTPv2({
        runtime: {
            memory: '4GiB',
            cpu: 2,
            timeoutSeconds: 300,
            concurrency: 8,
            maxInstances: 1250,
            minInstances: 1,
        },
        tags: ['Crawler'],
        httpMethod: ['get', 'post'],
        returnType: [String, OutputServerEventStream],
        exposeRoot: true,
    })
    async crawl(
        @RPCReflect() rpcReflect: RPCReflection,
        @Ctx() ctx: {
            req: Request,
            res: Response,
        },
        auth: JinaEmbeddingsAuthDTO,
        crawlerOptionsHeaderOnly: CrawlerOptionsHeaderOnly,
        crawlerOptionsParamsAllowed: CrawlerOptions,
    ) {
        const uid = await auth.solveUID();
        let chargeAmount = 0;
        let contentFromPuppeteer = '';
        let contentFromCurl = '';
        let crawlerOptions = ctx.req.method === 'GET' ? crawlerOptionsHeaderOnly : crawlerOptionsParamsAllowed;

        const targetUrl = await this.getTargetUrl(decodeURIComponent(ctx.req.url), crawlerOptions);
        if (!targetUrl) {
            const latestUser = uid ? await auth.assertUser() : undefined;
            if (!ctx.req.accepts('text/plain') && (ctx.req.accepts('text/json') || ctx.req.accepts('application/json'))) {
                return this.getIndex(latestUser);
            }

            return assignTransferProtocolMeta(`${this.getIndex(latestUser)}`,
                { contentType: 'text/plain', envelope: null }
            );
        }

        // Prevent circular crawling
        this.puppeteerControl.circuitBreakerHosts.add(
            ctx.req.hostname.toLowerCase()
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
                this.saveDomainProfile(targetUrl, contentFromPuppeteer, contentFromCurl);
            });
        } else if (ctx.req.ip) {
            const apiRoll = await this.rateLimitControl.simpleRpcIPBasedLimit(rpcReflect, ctx.req.ip, [rpcReflect.name.toUpperCase()],
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
                this.saveDomainProfile(targetUrl, contentFromPuppeteer, contentFromCurl);
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

        // Engine logic
        let engine = crawlerOptions?.engine;
        if (!engine) {
            const domainProfile = await DomainProfile.fromFirestoreQuery(
                DomainProfile.COLLECTION
                    .where('domain', '==', targetUrl.hostname.toLowerCase())
                    .where('expireAt', '>=', new Date())
                    .limit(1)
            ).then(profiles => profiles[0]);

            if (domainProfile) {
                engine = domainProfile.engine;
            } else {
                // Try curl engine first
                if ((crawlerOptions.respondWith === CONTENT_FORMAT.CONTENT ||
                    crawlerOptions.respondWith === CONTENT_FORMAT.MARKDOWN) &&
                    (!crawlerOptions.pdf && !crawlerOptions.html)) {
                    const curlCrawlerOptions = { ...crawlerOptions, engine: 'curl' } as any;
                    const curlOpts = await this.configure(curlCrawlerOptions);
                    let curlSnapshot;
                    try {
                        for await (const scrapped of this.cachedScrap(targetUrl, curlOpts, curlCrawlerOptions)) {
                            if (scrapped?.parsed?.content || scrapped?.title?.trim()) {
                                curlSnapshot = scrapped;
                                break;
                            }
                        }
                        if (curlSnapshot) {
                            const formatted = await this.snapshotFormatter.formatSnapshot(
                                crawlerOptions.respondWith,
                                curlSnapshot,
                                targetUrl,
                                this.urlValidMs
                            );
                            contentFromCurl = formatted.content || '';
                        }
                    } catch (err) {
                        this.logger.warn(`Curl engine failed for ${targetUrl}`, { err: marshalErrorLike(err) });
                    }
                }
            }
        }

        crawlerOptions.engine = engine;
        const crawlOpts = await this.configure(crawlerOptions);

        if (!ctx.req.accepts('text/plain') && ctx.req.accepts('text/event-stream')) {
            const sseStream = new OutputServerEventStream();
            rpcReflect.return(sseStream);

            try {
                for await (const scrapped of this.cachedScrap(targetUrl, crawlOpts, crawlerOptions)) {
                    if (!scrapped) {
                        continue;
                    }

                    const formatted = await this.snapshotFormatter.formatSnapshot(crawlerOptions.respondWith, scrapped, targetUrl, this.urlValidMs);
                    chargeAmount = this.assignChargeAmount(formatted);
                    contentFromPuppeteer = formatted.content || '';
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
        if (!ctx.req.accepts('text/plain') && (ctx.req.accepts('text/json') || ctx.req.accepts('application/json'))) {
            for await (const scrapped of this.cachedScrap(targetUrl, crawlOpts, crawlerOptions)) {
                lastScrapped = scrapped;
                if (crawlerOptions.waitForSelector || ((!scrapped?.parsed?.content || !scrapped?.title?.trim()) && !scrapped?.pdfs?.length)) {
                    continue;
                }

                const formatted = await this.snapshotFormatter.formatSnapshot(crawlerOptions.respondWith, scrapped, targetUrl, this.urlValidMs);
                chargeAmount = this.assignChargeAmount(formatted);
                contentFromPuppeteer = formatted.content || '';

                if (crawlerOptions.tokenBudget && chargeAmount > crawlerOptions.tokenBudget) {
                    throw new BudgetExceededError(`Token budget (${crawlerOptions.tokenBudget}) exceeded, intended charge amount ${chargeAmount}.`);
                }

                if (crawlerOptions.isEarlyReturnApplicable()) {
                    return formatted;
                }

                if (chargeAmount && scrapped?.pdfs?.length) {
                    return formatted;
                }
            }

            if (!lastScrapped) {
                if (crawlOpts.targetSelector) {
                    throw new AssertionFailureError(`No content available for URL ${targetUrl} with target selector ${Array.isArray(crawlOpts.targetSelector) ? crawlOpts.targetSelector.join(', ') : crawlOpts.targetSelector}`);
                }
                throw new AssertionFailureError(`No content available for URL ${targetUrl}`);
            }

            const formatted = await this.snapshotFormatter.formatSnapshot(crawlerOptions.respondWith, lastScrapped, targetUrl, this.urlValidMs);
            chargeAmount = this.assignChargeAmount(formatted);
            contentFromPuppeteer = formatted.content || '';
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

        for await (const scrapped of this.cachedScrap(targetUrl, crawlOpts, crawlerOptions)) {
            lastScrapped = scrapped;
            if (crawlerOptions.waitForSelector || ((!scrapped?.parsed?.content || !scrapped?.title?.trim()) && !scrapped?.pdfs?.length)) {
                continue;
            }

            const formatted = await this.snapshotFormatter.formatSnapshot(crawlerOptions.respondWith, scrapped, targetUrl, this.urlValidMs);
            chargeAmount = this.assignChargeAmount(formatted);
            contentFromPuppeteer = formatted.content || '';
            if (crawlerOptions.tokenBudget && chargeAmount > crawlerOptions.tokenBudget) {
                throw new BudgetExceededError(`Token budget (${crawlerOptions.tokenBudget}) exceeded, intended charge amount ${chargeAmount}.`);
            }

            if (crawlerOptions.isEarlyReturnApplicable()) {
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

                return assignTransferProtocolMeta(`${formatted.textRepresentation}`, { contentType: 'text/plain', envelope: null });
            }
        }

        if (!lastScrapped) {
            if (crawlOpts.targetSelector) {
                throw new AssertionFailureError(`No content available for URL ${targetUrl} with target selector ${Array.isArray(crawlOpts.targetSelector) ? crawlOpts.targetSelector.join(', ') : crawlOpts.targetSelector}`);
            }
            throw new AssertionFailureError(`No content available for URL ${targetUrl}`);
        }

        const formatted = await this.snapshotFormatter.formatSnapshot(crawlerOptions.respondWith, lastScrapped, targetUrl, this.urlValidMs);
        chargeAmount = this.assignChargeAmount(formatted);
        contentFromPuppeteer = formatted.content || '';
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

        return assignTransferProtocolMeta(`${formatted.textRepresentation}`, { contentType: 'text/plain', envelope: null });

    }

    async saveDomainProfile(targetUrl: URL, puppeteerResult: string, curlResult: string) {
        if (targetUrl && puppeteerResult && curlResult) {
            const preferredEngine = puppeteerResult.trim().length === curlResult.trim().length ? 'curl' : 'puppeteer';

            try {
                await DomainProfile.save(DomainProfile.from({
                    domain: targetUrl.hostname.toLowerCase(),
                    triggerReason: 'Automatically detected',
                    triggerUrl: targetUrl.toString(),
                    engine: preferredEngine,
                    createdAt: new Date(),
                    expireAt: new Date(Date.now() + this.domainProfileRetentionMs),
                }));
            } catch (err) {
                this.logger.warn(`Failed to save domain profile for ${targetUrl.hostname}`, { err: marshalErrorLike(err) });
            }
        }
    }

    async getTargetUrl(originPath: string, crawlerOptions: CrawlerOptions) {
        let url: string;

        const targetUrlFromGet = originPath.slice(1);
        if (crawlerOptions.pdf) {
            const pdfBuf = crawlerOptions.pdf instanceof Blob ? await crawlerOptions.pdf.arrayBuffer().then((x) => Buffer.from(x)) : Buffer.from(crawlerOptions.pdf, 'base64');
            url = `file://pdf.${md5Hasher.hash(pdfBuf)}`;
        } else if (targetUrlFromGet) {
            url = targetUrlFromGet.trim();
        } else if (crawlerOptions.url) {
            url = crawlerOptions.url.trim();
        } else {
            return null;
        }

        let result: URL;
        const normalizeUrl = (await pNormalizeUrl).default;
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

        if (!['http:', 'https:', 'file:'].includes(result.protocol)) {
            throw new ParamValidationError({
                message: `Invalid protocol ${result.protocol}`,
                path: 'url'
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

        const cache = (await Crawled.fromFirestoreQuery(Crawled.COLLECTION.where('urlPathDigest', '==', digest).orderBy('createdAt', 'desc').limit(1)))?.[0];

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

    async *cachedScrap(urlToCrawl: URL, crawlOpts?: ExtraScrappingOptions, crawlerOpts?: CrawlerOptions) {
        if (crawlerOpts?.html) {
            const fakeSnapshot = {
                href: urlToCrawl.toString(),
                html: crawlerOpts.html,
                title: '',
                text: '',
            } as PageSnapshot;

            yield this.jsdomControl.narrowSnapshot(fakeSnapshot, crawlOpts);

            return;
        }

        if (crawlerOpts?.pdf) {

            const pdfBuf = crawlerOpts.pdf instanceof Blob ? await crawlerOpts.pdf.arrayBuffer().then((x) => Buffer.from(x)) : Buffer.from(crawlerOpts.pdf, 'base64');
            const pdfDataUrl = `data:application/pdf;base64,${pdfBuf.toString('base64')}`;
            const fakeSnapshot = {
                href: urlToCrawl.toString(),
                html: `<!DOCTYPE html><html><head></head><body style="height: 100%; width: 100%; overflow: hidden; margin:0px; background-color: rgb(82, 86, 89);"><embed style="position:absolute; left: 0; top: 0;" width="100%" height="100%" src="${pdfDataUrl}"></body></html>`,
                title: '',
                text: '',
                pdfs: [pdfDataUrl],
            } as PageSnapshot;

            yield this.jsdomControl.narrowSnapshot(fakeSnapshot, crawlOpts);

            return;
        }

        if (crawlerOpts?.engine?.toLowerCase() === 'curl') {
            const html = await new Promise<string>((resolve, reject) => {
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
                if (crawlOpts?.cookies) {
                    curl.setOpt(Curl.option.COOKIE, crawlOpts.cookies.join('; '));
                }
                if (crawlOpts?.referer) {
                    curl.setOpt(Curl.option.REFERER, crawlOpts.referer);
                }


                curl.on('end', (statusCode, data, headers) => {
                    this.logger.info(`Successfully requested ${urlToCrawl} by curl`, { statusCode, headers });
                    resolve(data.toString());
                    curl.close();
                });

                curl.on('error', (err) => {
                    this.logger.error(`Failed to request ${urlToCrawl} by curl`, { err: marshalErrorLike(err) });
                    reject(err);
                    curl.close();
                });

                curl.perform();
            });

            const fakeSnapshot = {
                href: urlToCrawl.toString(),
                html: html,
                title: '',
                text: '',
            } as PageSnapshot;

            yield this.jsdomControl.narrowSnapshot(fakeSnapshot, crawlOpts);
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
            yield this.jsdomControl.narrowSnapshot(cache.snapshot, crawlOpts);

            return;
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

    assignChargeAmount(formatted: FormattedPage) {
        if (!formatted) {
            return 0;
        }

        let amount = 0;
        if (formatted.content) {
            amount += estimateToken(formatted.content);
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

        Promise.all(
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
        this.threadLocal.set('userAgent', opts.userAgent);
        this.threadLocal.set('engine', opts.engine);
        if (opts.timeout) {
            this.threadLocal.set('timeout', opts.timeout * 1000);
        }
        this.threadLocal.set('retainImages', opts.retainImages);
        this.threadLocal.set('noGfm', opts.noGfm);

        const crawlOpts: ExtraScrappingOptions = {
            proxyUrl: opts.proxyUrl,
            cookies: opts.setCookies,
            favorScreenshot: ['screenshot', 'pageshot'].some((x) => opts.respondWith.includes(x)),
            removeSelector: opts.removeSelector,
            targetSelector: opts.targetSelector,
            waitForSelector: opts.waitForSelector,
            overrideUserAgent: opts.userAgent,
            engine: opts.engine,
            timeoutMs: opts.timeout ? opts.timeout * 1000 : undefined,
            withIframe: opts.withIframe,
            withShadowDom: opts.withShadowDom,
            locale: opts.locale,
            referer: opts.referer,
            viewport: opts.viewport,
        };

        if (opts.locale) {
            crawlOpts.extraHeaders ??= {};
            crawlOpts.extraHeaders['Accept-Language'] = opts.locale;
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

    async simpleCrawl(mode: string, url: URL, opts?: ExtraScrappingOptions) {
        const it = this.cachedScrap(url, { ...opts, minIntervalMs: 500 });

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
}
