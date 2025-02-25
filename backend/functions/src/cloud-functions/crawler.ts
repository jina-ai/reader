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
const pNormalizeUrl = import("@esm2cjs/normalize-url");
import { Crawled } from '../db/crawled';
import { randomUUID } from 'crypto';
import { JinaEmbeddingsAuthDTO } from '../shared/dto/jina-embeddings-auth';

import { countGPTToken as estimateToken } from '../shared/utils/openai';
import { CONTENT_FORMAT, CrawlerOptions, CrawlerOptionsHeaderOnly, ENGINE_TYPE } from '../dto/scrapping-options';
import { JinaEmbeddingsTokenAccount } from '../shared/db/jina-embeddings-token-account';
import { DomainBlockade } from '../db/domain-blockade';
import { DomainProfile } from '../db/domain-profile';
import { FirebaseRoundTripChecker } from '../shared/services/firebase-roundtrip-checker';
import { JSDomControl } from '../services/jsdom';
import { FormattedPage, md5Hasher, SnapshotFormatter } from '../services/snapshot-formatter';
import { CurlControl } from '../services/curl';
import { LmControl } from '../services/lm';
import { tryDecodeURIComponent } from '../utils/misc';

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
        protected curlControl: CurlControl,
        protected lmControl: LmControl,
        protected jsdomControl: JSDomControl,
        protected snapshotFormatter: SnapshotFormatter,
        protected firebaseObjectStorage: FirebaseStorageBucketControl,
        protected rateLimitControl: RateLimitControl,
        protected threadLocal: AsyncContext,
        protected fbHealthCheck: FirebaseRoundTripChecker,
    ) {
        super(...arguments);

        puppeteerControl.on('crawled', async (snapshot: PageSnapshot, options: ExtraScrappingOptions & { url: URL; }) => {
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

            await this.exploreDirectEngine(snapshot).catch(() => undefined);
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
            concurrency: 10,
            maxInstances: 1000,
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
        const crawlerOptions = ctx.req.method === 'GET' ? crawlerOptionsHeaderOnly : crawlerOptionsParamsAllowed;

        // Note req.url in express is actually unparsed `path`, e.g. `/some-path?abc`. Instead of a real url.
        const targetUrl = await this.getTargetUrl(tryDecodeURIComponent(ctx.req.url), crawlerOptions);
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
        if (!ctx.req.accepts('text/plain') && ctx.req.accepts('text/event-stream')) {
            const sseStream = new OutputServerEventStream();
            rpcReflect.return(sseStream);

            try {
                for await (const scrapped of this.iterSnapshots(targetUrl, crawlOpts, crawlerOptions)) {
                    if (!scrapped) {
                        continue;
                    }

                    const formatted = await this.formatSnapshot(crawlerOptions, scrapped, targetUrl, this.urlValidMs);
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
        if (!ctx.req.accepts('text/plain') && (ctx.req.accepts('text/json') || ctx.req.accepts('application/json'))) {
            for await (const scrapped of this.iterSnapshots(targetUrl, crawlOpts, crawlerOptions)) {
                lastScrapped = scrapped;
                if (!crawlerOptions.isEarlyReturnApplicable()) {
                    continue;
                }
                if (crawlerOptions.waitForSelector || ((!scrapped?.parsed?.content || !scrapped?.title?.trim()) && !scrapped?.pdfs?.length)) {
                    continue;
                }

                const formatted = await this.formatSnapshot(crawlerOptions, scrapped, targetUrl, this.urlValidMs);
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

            const formatted = await this.formatSnapshot(crawlerOptions, lastScrapped, targetUrl, this.urlValidMs);
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

            if (!crawlerOptions.isEarlyReturnApplicable()) {
                continue;
            }

            if (crawlerOptions.waitForSelector || ((!scrapped?.parsed?.content || !scrapped?.title?.trim()) && !scrapped?.pdfs?.length)) {
                continue;
            }

            const formatted = await this.formatSnapshot(crawlerOptions, scrapped, targetUrl, this.urlValidMs);
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

            return assignTransferProtocolMeta(`${formatted.textRepresentation}`, { contentType: 'text/plain', envelope: null });
        }

        if (!lastScrapped) {
            if (crawlOpts.targetSelector) {
                throw new AssertionFailureError(`No content available for URL ${targetUrl} with target selector ${Array.isArray(crawlOpts.targetSelector) ? crawlOpts.targetSelector.join(', ') : crawlOpts.targetSelector}`);
            }
            throw new AssertionFailureError(`No content available for URL ${targetUrl}`);
        }

        const formatted = await this.formatSnapshot(crawlerOptions, lastScrapped, targetUrl, this.urlValidMs);
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

        return assignTransferProtocolMeta(`${formatted.textRepresentation}`, { contentType: 'text/plain', envelope: null });

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
            yield this.curlControl.urlToSnapshot(urlToCrawl, crawlOpts);
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

        if (crawlOpts?.engine !== ENGINE_TYPE.BROWSER && crawlerOpts?.browserIsNotRequired()) {
            const { digest } = this.getDomainProfileUrlDigest(urlToCrawl);
            const domainProfile = await DomainProfile.fromFirestore(digest);
            if (domainProfile?.engine === ENGINE_TYPE.DIRECT) {
                try {
                    const snapshot = await this.curlControl.urlToSnapshot(urlToCrawl, crawlOpts);

                    // Expect downstream code to "break" here if it's satisfied with the direct engine
                    yield snapshot;
                    if (crawlOpts?.engine === ENGINE_TYPE.AUTO) {
                        return;
                    }
                } catch (err: any) {
                    this.logger.warn(`Failed to scrap ${urlToCrawl} with direct engine`, { err: marshalErrorLike(err) });
                }
            }
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
        this.threadLocal.set('userAgent', opts.userAgent);
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
            timeoutMs: opts.timeout ? opts.timeout * 1000 : undefined,
            withIframe: opts.withIframe,
            withShadowDom: opts.withShadowDom,
            locale: opts.locale,
            referer: opts.referer,
            viewport: opts.viewport,
            engine: opts.engine,
        };

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

    formatSnapshot(
        crawlerOptions: CrawlerOptions,
        snapshot: PageSnapshot & {
            screenshotUrl?: string;
            pageshotUrl?: string;
        },
        nominalUrl?: URL,
        urlValidMs?: number
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
}
