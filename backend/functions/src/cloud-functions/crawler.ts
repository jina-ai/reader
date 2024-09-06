import {
    assignTransferProtocolMeta, marshalErrorLike,
    RPCHost, RPCReflection,
    AssertionFailureError, ParamValidationError, Defer,
} from 'civkit';
import { singleton } from 'tsyringe';
import { AsyncContext, CloudHTTPv2, Ctx, FirebaseStorageBucketControl, InsufficientBalanceError, Logger, OutputServerEventStream, RPCReflect, SecurityCompromiseError } from '../shared';
import { RateLimitControl, RateLimitDesc } from '../shared/services/rate-limit';
import _ from 'lodash';
import { PageSnapshot, PuppeteerControl, ScrappingOptions } from '../services/puppeteer';
import { Request, Response } from 'express';
const pNormalizeUrl = import("@esm2cjs/normalize-url");
import { Crawled } from '../db/crawled';
import { randomUUID } from 'crypto';
import { JinaEmbeddingsAuthDTO } from '../shared/dto/jina-embeddings-auth';

import { countGPTToken as estimateToken } from '../shared/utils/openai';
import { CrawlerOptions, CrawlerOptionsHeaderOnly } from '../dto/scrapping-options';
import { JinaEmbeddingsTokenAccount } from '../shared/db/jina-embeddings-token-account';
import { DomainBlockade } from '../db/domain-blockade';
import { FirebaseRoundTripChecker } from '../shared/services/firebase-roundtrip-checker';
import { JSDomControl } from '../services/jsdom';
import { FormattedPage, md5Hasher, SnapshotFormatter } from '../services/snapshot-formatter';

export interface ExtraScrappingOptions extends ScrappingOptions {
    withIframe?: boolean;
    targetSelector?: string | string[];
    removeSelector?: string | string[];
    keepImgDataUrl?: boolean;
}

export const indexProto = {
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
            cpu: 4,
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
        const crawlerOptions = ctx.req.method === 'GET' ? crawlerOptionsHeaderOnly : crawlerOptionsParamsAllowed;

        const targetUrl = await this.getTargetUrl(ctx.req.url, crawlerOptions);
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
                if (chargeAmount) {
                    apiRoll._ref?.set({
                        chargeAmount,
                    }, { merge: true }).catch((err) => this.logger.warn(`Failed to log charge amount in apiRoll`, { err }));
                }
            });
        }

        if (!uid) {
            if (targetUrl.protocol === 'http:' && (!targetUrl.pathname || targetUrl.pathname === '/') &&
                crawlerOptions.respondWith !== 'default') {
                throw new SecurityCompromiseError(`Your request is categorized as abuse. Please don't abuse our service. If you are sure you are not abusing, please authenticate yourself with an API key.`);
            }
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
        const crawlOpts = this.configure(crawlerOptions);


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
                if (crawlerOptions.waitForSelector || ((!scrapped?.parsed?.content || !scrapped.title?.trim()) && !scrapped?.pdfs?.length)) {
                    continue;
                }

                const formatted = await this.snapshotFormatter.formatSnapshot(crawlerOptions.respondWith, scrapped, targetUrl, this.urlValidMs);
                chargeAmount = this.assignChargeAmount(formatted);

                if (crawlerOptions.timeout === undefined) {
                    return formatted;
                }

                if (chargeAmount && scrapped.pdfs?.length) {
                    return formatted;
                }
            }

            if (!lastScrapped) {
                throw new AssertionFailureError(`No content available for URL ${targetUrl}`);
            }

            const formatted = await this.snapshotFormatter.formatSnapshot(crawlerOptions.respondWith, lastScrapped, targetUrl, this.urlValidMs);
            chargeAmount = this.assignChargeAmount(formatted);

            return formatted;
        }

        for await (const scrapped of this.cachedScrap(targetUrl, crawlOpts, crawlerOptions)) {
            lastScrapped = scrapped;
            if (crawlerOptions.waitForSelector || ((!scrapped?.parsed?.content || !scrapped.title?.trim()) && !scrapped?.pdfs?.length)) {
                continue;
            }

            const formatted = await this.snapshotFormatter.formatSnapshot(crawlerOptions.respondWith, scrapped, targetUrl, this.urlValidMs);
            chargeAmount = this.assignChargeAmount(formatted);

            if (crawlerOptions.timeout === undefined) {
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
            throw new AssertionFailureError(`No content available for URL ${targetUrl}`);
        }

        const formatted = await this.snapshotFormatter.formatSnapshot(crawlerOptions.respondWith, lastScrapped, targetUrl, this.urlValidMs);
        chargeAmount = this.assignChargeAmount(formatted);
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
            url = `file://pdf.${md5Hasher.hash(crawlerOptions.pdf)}`;
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
                    screenshot: undefined
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
            const pdfDataUrl = `data:application/pdf;base64,${encodeURIComponent(crawlerOpts.pdf)}`;
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

        let cache;

        const cacheTolerance = crawlerOpts?.cacheTolerance ?? this.cacheValidMs;
        if (cacheTolerance && !crawlOpts?.cookies?.length) {
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
            if (crawlOpts?.targetSelector || crawlOpts?.removeSelector || crawlOpts?.withIframe) {
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
            return undefined;
        }

        const textContent = formatted?.content || formatted?.description || formatted?.text || formatted?.html;
        let amount;
        do {
            if (typeof textContent === 'string') {
                amount = estimateToken(textContent);
                break;
            }

            const imageContent = formatted.screenshotUrl || formatted.screenshot;

            if (imageContent) {
                // OpenAI image token count for 1024x1024 image
                amount = 765;
                break;
            }
        } while (false);

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

    configure(opts: CrawlerOptions) {

        this.threadLocal.set('withGeneratedAlt', opts.withGeneratedAlt);
        this.threadLocal.set('withLinksSummary', opts.withLinksSummary);
        this.threadLocal.set('withImagesSummary', opts.withImagesSummary);
        this.threadLocal.set('keepImgDataUrl', opts.keepImgDataUrl);
        this.threadLocal.set('cacheTolerance', opts.cacheTolerance);
        this.threadLocal.set('userAgent', opts.userAgent);
        if (opts.timeout) {
            this.threadLocal.set('timeout', opts.timeout * 1000);
        }

        const crawlOpts: ExtraScrappingOptions = {
            proxyUrl: opts.proxyUrl,
            cookies: opts.setCookies,
            favorScreenshot: ['screenshot', 'pageshot'].includes(opts.respondWith),
            removeSelector: opts.removeSelector,
            targetSelector: opts.targetSelector,
            waitForSelector: opts.waitForSelector,
            overrideUserAgent: opts.userAgent,
            timeoutMs: opts.timeout ? opts.timeout * 1000 : undefined,
            withIframe: opts.withIframe,
            locale: opts.locale,
            referer: opts.referer,
        };

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
