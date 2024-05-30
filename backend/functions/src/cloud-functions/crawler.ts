import {
    assignTransferProtocolMeta, marshalErrorLike,
    RPCHost, RPCReflection,
    HashManager,
    AssertionFailureError, ParamValidationError, Defer,
} from 'civkit';
import { singleton } from 'tsyringe';
import { AsyncContext, CloudHTTPv2, Ctx, FirebaseStorageBucketControl, InsufficientBalanceError, Logger, OutputServerEventStream, RPCReflect } from '../shared';
import { RateLimitControl, RateLimitDesc } from '../shared/services/rate-limit';
import _ from 'lodash';
import { PageSnapshot, PuppeteerControl, ScrappingOptions } from '../services/puppeteer';
import { Request, Response } from 'express';
const pNormalizeUrl = import("@esm2cjs/normalize-url");
import { AltTextService } from '../services/alt-text';
import TurndownService from 'turndown';
import { Crawled } from '../db/crawled';
import { cleanAttribute } from '../utils/misc';
import { randomUUID } from 'crypto';
import { JinaEmbeddingsAuthDTO } from '../shared/dto/jina-embeddings-auth';

import { countGPTToken as estimateToken } from '../shared/utils/openai';
import { CrawlerOptions } from '../dto/scrapping-options';
import { JinaEmbeddingsTokenAccount } from '../shared/db/jina-embeddings-token-account';
import { PDFExtractor } from '../services/pdf-extract';

const md5Hasher = new HashManager('md5', 'hex');

export interface ExtraScrappingOptions extends ScrappingOptions {
    targetSelector?: string;
}

export interface FormattedPage {
    title?: string;
    description?: string;
    url?: string;
    content?: string;
    publishedTime?: string;
    html?: string;
    text?: string;
    screenshotUrl?: string;
    screenshot?: Buffer;
    links?: { [k: string]: string; };
    images?: { [k: string]: string; };

    toString: () => string;
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

    turnDownPlugins = [require('turndown-plugin-gfm').tables];

    cacheRetentionMs = 1000 * 3600 * 24 * 7;
    cacheValidMs = 1000 * 3600;
    urlValidMs = 1000 * 3600 * 4;

    constructor(
        protected globalLogger: Logger,
        protected puppeteerControl: PuppeteerControl,
        protected altTextService: AltTextService,
        protected pdfExtractor: PDFExtractor,
        protected firebaseObjectStorage: FirebaseStorageBucketControl,
        protected rateLimitControl: RateLimitControl,
        protected threadLocal: AsyncContext,
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

            await this.setToCache(options.url, snapshot);
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

    getTurndown(noRules?: boolean | string) {
        const turnDownService = new TurndownService();
        if (!noRules) {
            turnDownService.addRule('remove-irrelevant', {
                filter: ['meta', 'style', 'script', 'noscript', 'link', 'textarea'],
                replacement: () => ''
            });
            turnDownService.addRule('title-as-h1', {
                filter: ['title'],
                replacement: (innerText) => `${innerText}\n===============\n`
            });
        }
        turnDownService.addRule('improved-paragraph', {
            filter: 'p',
            replacement: (innerText) => {
                const trimmed = innerText.trim();
                if (!trimmed) {
                    return '';
                }

                return `${trimmed.replace(/\n{3,}/g, '\n\n')}\n\n`;
            }
        });
        turnDownService.addRule('improved-inline-link', {
            filter: function (node, options) {
                return Boolean(
                    options.linkStyle === 'inlined' &&
                    node.nodeName === 'A' &&
                    node.getAttribute('href')
                );
            },

            replacement: function (content, node: any) {
                let href = node.getAttribute('href');
                if (href) href = href.replace(/([()])/g, '\\$1');
                let title = cleanAttribute(node.getAttribute('title'));
                if (title) title = ' "' + title.replace(/"/g, '\\"') + '"';

                const fixedContent = content.replace(/\s+/g, ' ').trim();
                const fixedHref = href.replace(/\s+/g, '').trim();

                return `[${fixedContent}](${fixedHref}${title || ''})`;
            }
        });

        return turnDownService;
    }

    getGeneralSnapshotMixins(snapshot: PageSnapshot) {
        const inferred = this.puppeteerControl.inferSnapshot(snapshot);
        const mixin: any = {};
        if (this.threadLocal.get('withImagesSummary')) {
            const imageSummary = {} as { [k: string]: string; };
            const imageIdxTrack = new Map<string, number[]>();

            let imgIdx = 0;

            for (const img of inferred.imgs) {
                const imgSerial = ++imgIdx;
                const idxArr = imageIdxTrack.has(img.src) ? imageIdxTrack.get(img.src)! : [];
                idxArr.push(imgSerial);
                imageIdxTrack.set(img.src, idxArr);
                imageSummary[img.src] = img.alt || '';
            }

            mixin.images =
                _(imageSummary)
                    .toPairs()
                    .map(
                        ([url, alt], i) => {
                            return [`Image ${(imageIdxTrack?.get(url) || [i + 1]).join(',')}${alt ? `: ${alt}` : ''}`, url];
                        }
                    ).fromPairs()
                    .value();
        }
        if (this.threadLocal.get('withLinksSummary')) {
            mixin.links = _.invert(inferred.links || {});
        }

        return mixin;
    }

    async formatSnapshot(mode: string | 'markdown' | 'html' | 'text' | 'screenshot', snapshot: PageSnapshot & {
        screenshotUrl?: string;
    }, nominalUrl?: URL) {
        if (mode === 'screenshot') {
            if (snapshot.screenshot && !snapshot.screenshotUrl) {
                const fid = `instant-screenshots/${randomUUID()}`;
                await this.firebaseObjectStorage.saveFile(fid, snapshot.screenshot, {
                    metadata: {
                        contentType: 'image/png',
                    }
                });
                snapshot.screenshotUrl = await this.firebaseObjectStorage.signDownloadUrl(fid, Date.now() + this.urlValidMs);
            }

            return {
                ...this.getGeneralSnapshotMixins(snapshot),
                screenshotUrl: snapshot.screenshotUrl,
                toString() {
                    return this.screenshotUrl;
                }
            } as FormattedPage;
        }
        if (mode === 'html') {
            return {
                ...this.getGeneralSnapshotMixins(snapshot),
                html: snapshot.html,
                toString() {
                    return this.html;
                }
            } as FormattedPage;
        }

        let pdfMode = false;
        if (snapshot.pdfs?.length && !snapshot.title) {
            const pdf = await this.pdfExtractor.cachedExtract(snapshot.pdfs[0]);
            if (pdf) {
                pdfMode = true;
                snapshot.title = pdf.meta?.Title;
                snapshot.text = pdf.text || snapshot.text;
                snapshot.parsed = {
                    content: pdf.content,
                    textContent: pdf.content,
                    length: pdf.content?.length,
                    byline: pdf.meta?.Author,
                    lang: pdf.meta?.Language || undefined,
                    title: pdf.meta?.Title,
                    publishedTime: this.pdfExtractor.parsePdfDate(pdf.meta?.ModDate || pdf.meta?.CreationDate)?.toISOString(),
                };
            }
        }

        if (mode === 'text') {
            return {
                ...this.getGeneralSnapshotMixins(snapshot),
                text: snapshot.text,
                toString() {
                    return this.text;
                }
            } as FormattedPage;
        }

        let contentText = '';
        const imageSummary = {} as { [k: string]: string; };
        const imageIdxTrack = new Map<string, number[]>();
        do {
            if (pdfMode) {
                contentText = snapshot.parsed?.content || snapshot.text;
                break;
            }

            const toBeTurnedToMd = mode === 'markdown' ? snapshot.html : snapshot.parsed?.content;
            let turnDownService = mode === 'markdown' ? this.getTurndown() : this.getTurndown('without any rule');
            for (const plugin of this.turnDownPlugins) {
                turnDownService = turnDownService.use(plugin);
            }
            const urlToAltMap: { [k: string]: string | undefined; } = {};
            if (snapshot.imgs?.length && this.threadLocal.get('withGeneratedAlt')) {
                const tasks = _.uniqBy((snapshot.imgs || []), 'src').map(async (x) => {
                    const r = await this.altTextService.getAltText(x).catch((err: any) => {
                        this.logger.warn(`Failed to get alt text for ${x.src}`, { err: marshalErrorLike(err) });
                        return undefined;
                    });
                    if (r && x.src) {
                        urlToAltMap[x.src.trim()] = r;
                    }
                });

                await Promise.all(tasks);
            }
            let imgIdx = 0;
            turnDownService.addRule('img-generated-alt', {
                filter: 'img',
                replacement: (_content, node: any) => {
                    let linkPreferredSrc = (node.getAttribute('src') || '').trim();
                    if (!linkPreferredSrc || linkPreferredSrc.startsWith('data:')) {
                        const dataSrc = (node.getAttribute('data-src') || '').trim();
                        if (dataSrc && !dataSrc.startsWith('data:')) {
                            linkPreferredSrc = dataSrc;
                        }
                    }

                    let src;
                    try {
                        src = new URL(linkPreferredSrc, nominalUrl).toString();
                    } catch (_err) {
                        void 0;
                    }
                    const alt = cleanAttribute(node.getAttribute('alt'));
                    if (!src) {
                        return '';
                    }
                    const mapped = urlToAltMap[src];
                    const imgSerial = ++imgIdx;
                    const idxArr = imageIdxTrack.has(src) ? imageIdxTrack.get(src)! : [];
                    idxArr.push(imgSerial);
                    imageIdxTrack.set(src, idxArr);

                    if (mapped) {
                        imageSummary[src] = mapped || alt;

                        return `![Image ${imgIdx}: ${mapped || alt}](${src})`;
                    }

                    imageSummary[src] = alt || '';

                    return alt ? `![Image ${imgIdx}: ${alt}](${src})` : `![Image ${imgIdx}](${src})`;
                }
            });

            if (toBeTurnedToMd) {
                try {
                    contentText = turnDownService.turndown(toBeTurnedToMd).trim();
                } catch (err) {
                    this.logger.warn(`Turndown failed to run, retrying without plugins`, { err });
                    const vanillaTurnDownService = this.getTurndown();
                    try {
                        contentText = vanillaTurnDownService.turndown(toBeTurnedToMd).trim();
                    } catch (err2) {
                        this.logger.warn(`Turndown failed to run, giving up`, { err: err2 });
                    }
                }
            }

            if (
                !contentText || (contentText.startsWith('<') && contentText.endsWith('>'))
                && toBeTurnedToMd !== snapshot.html
            ) {
                try {
                    contentText = turnDownService.turndown(snapshot.html);
                } catch (err) {
                    this.logger.warn(`Turndown failed to run, retrying without plugins`, { err });
                    const vanillaTurnDownService = this.getTurndown();
                    try {
                        contentText = vanillaTurnDownService.turndown(snapshot.html);
                    } catch (err2) {
                        this.logger.warn(`Turndown failed to run, giving up`, { err: err2 });
                    }
                }
            }
            if (!contentText || (contentText.startsWith('<') || contentText.endsWith('>'))) {
                contentText = snapshot.text;
            }
        } while (false);

        const cleanText = (contentText || '').trim();

        const formatted: FormattedPage = {
            title: (snapshot.parsed?.title || snapshot.title || '').trim(),
            url: nominalUrl?.toString() || snapshot.href?.trim(),
            content: cleanText,
            publishedTime: snapshot.parsed?.publishedTime || undefined,

            toString() {
                if (mode === 'markdown') {
                    return this.content as string;
                }

                const mixins = [];
                if (this.publishedTime) {
                    mixins.push(`Published Time: ${this.publishedTime}`);
                }
                const suffixMixins = [];
                if (this.images) {
                    const imageSummaryChunks = ['Images:'];
                    for (const [k, v] of Object.entries(this.images)) {
                        imageSummaryChunks.push(`- ![${k}](${v})`);
                    }
                    if (imageSummaryChunks.length === 1) {
                        imageSummaryChunks.push('This page does not seem to contain any images.');
                    }
                    suffixMixins.push(imageSummaryChunks.join('\n'));
                }
                if (this.links) {
                    const linkSummaryChunks = ['Links/Buttons:'];
                    for (const [k, v] of Object.entries(this.links)) {
                        linkSummaryChunks.push(`- [${k}](${v})`);
                    }
                    if (linkSummaryChunks.length === 1) {
                        linkSummaryChunks.push('This page does not seem to contain any buttons/links.');
                    }
                    suffixMixins.push(linkSummaryChunks.join('\n'));
                }

                return `Title: ${this.title}

URL Source: ${this.url}
${mixins.length ? `\n${mixins.join('\n\n')}\n` : ''}
Markdown Content:
${this.content}
${suffixMixins.length ? `\n${suffixMixins.join('\n\n')}\n` : ''}`;
            }
        };

        if (this.threadLocal.get('withImagesSummary')) {
            formatted.images =
                _(imageSummary)
                    .toPairs()
                    .map(
                        ([url, alt], i) => {
                            return [`Image ${(imageIdxTrack?.get(url) || [i + 1]).join(',')}${alt ? `: ${alt}` : ''}`, url];
                        }
                    ).fromPairs()
                    .value();
        }
        if (this.threadLocal.get('withLinksSummary')) {
            formatted.links = _.invert(this.puppeteerControl.inferSnapshot(snapshot).links || {});
        }

        return formatted as FormattedPage;
    }

    @CloudHTTPv2({
        name: 'crawl2',
        runtime: {
            memory: '4GiB',
            timeoutSeconds: 300,
            concurrency: 4,
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
            concurrency: 11,
            maxInstances: 455,
        },
        openapi: {
            operation: {
                parameters: {
                    'Accept': {
                        description: `Specifies your preference for the response format.\n\n` +
                            `Supported formats: \n` +
                            `- text/event-stream\n` +
                            `- application/json or text/json\n` +
                            `- text/plain`
                        ,
                        in: 'header',
                        schema: { type: 'string' }
                    },
                    'X-Cache-Tolerance': {
                        description: `Sets internal cache tolerance in seconds if this header is specified with a integer.`,
                        in: 'header',
                        schema: { type: 'string' }
                    },
                    'X-No-Cache': {
                        description: `Ignores internal cache if this header is specified with a value.\n\nEquivalent to X-Cache-Tolerance: 0`,
                        in: 'header',
                        schema: { type: 'string' }
                    },
                    'X-Respond-With': {
                        description: `Specifies the (non-default) form factor of the crawled data you prefer.\n\n` +
                            `Supported formats: \n` +
                            `- markdown\n` +
                            `- html\n` +
                            `- text\n` +
                            `- screenshot\n`
                        ,
                        in: 'header',
                        schema: { type: 'string' }
                    },
                    'X-Wait-For-Selector': {
                        description: `Specifies a CSS selector to wait for the appearance of such an element before returning.\n\n` +
                            'Example: `X-Wait-For-Selector: .content-block`\n'
                        ,
                        in: 'header',
                        schema: { type: 'string' }
                    },
                    'X-Target-Selector': {
                        description: `Specifies a CSS selector for return target instead of the full html.\n\n` +
                            'Implies `X-Wait-For-Selector: (same selector)`'
                        ,
                        in: 'header',
                        schema: { type: 'string' }
                    },
                    'X-Proxy-Url': {
                        description: `Specifies your custom proxy if you prefer to use one.\n\n` +
                            `Supported protocols: \n` +
                            `- http\n` +
                            `- https\n` +
                            `- socks4\n` +
                            `- socks5\n\n` +
                            `For authentication, https://user:pass@host:port`,
                        in: 'header',
                        schema: { type: 'string' }
                    },
                    'X-Set-Cookie': {
                        description: `Sets cookie(s) to the headless browser for your request. \n\n` +
                            `Syntax is the same with standard Set-Cookie`,
                        in: 'header',
                        schema: { type: 'string' }
                    },
                    'X-With-Generated-Alt': {
                        description: `Enable automatic alt-text generating for images without an meaningful alt-text.\n\n` +
                            `Note: Does not work when \`X-Respond-With\` is specified`,
                        in: 'header',
                        schema: { type: 'string' }
                    },
                    'X-With-Images-Summary': {
                        description: `Enable dedicated summary section for images on the page.`,
                        in: 'header',
                        schema: { type: 'string' }
                    },
                    'X-With-links-Summary': {
                        description: `Enable dedicated summary section for hyper links on the page.`,
                        in: 'header',
                        schema: { type: 'string' }
                    },
                }
            }
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
        crawlerOptions: CrawlerOptions,
    ) {
        const uid = await auth.solveUID();
        let chargeAmount = 0;
        const noSlashURL = ctx.req.url.slice(1);
        if (!noSlashURL) {
            const latestUser = uid ? await auth.assertUser() : undefined;
            if (!ctx.req.accepts('text/plain') && (ctx.req.accepts('text/json') || ctx.req.accepts('application/json'))) {
                return this.getIndex(latestUser);
            }

            return assignTransferProtocolMeta(`${this.getIndex(latestUser)}`,
                { contentType: 'text/plain', envelope: null }
            );
        }
        if (uid) {
            const user = await auth.assertUser();
            if (!(user.wallet.total_balance > 0)) {
                throw new InsufficientBalanceError(`Account balance not enough to run this query, please recharge.`);
            }

            const rateLimitPolicy = auth.getRateLimits(rpcReflect.name.toUpperCase()) || [RateLimitDesc.from({
                occurrence: 200,
                periodSeconds: 60
            })];

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

        let urlToCrawl;
        const normalizeUrl = (await pNormalizeUrl).default;
        try {
            urlToCrawl = new URL(normalizeUrl(noSlashURL.trim(), { stripWWW: false, removeTrailingSlash: false, removeSingleSlash: false }));
        } catch (err) {
            throw new ParamValidationError({
                message: `${err}`,
                path: 'url'
            });
        }
        if (urlToCrawl.protocol !== 'http:' && urlToCrawl.protocol !== 'https:') {
            throw new ParamValidationError({
                message: `Invalid protocol ${urlToCrawl.protocol}`,
                path: 'url'
            });
        }

        const crawlOpts = this.configure(crawlerOptions);

        if (!ctx.req.accepts('text/plain') && ctx.req.accepts('text/event-stream')) {
            const sseStream = new OutputServerEventStream();
            rpcReflect.return(sseStream);

            try {
                for await (const scrapped of this.cachedScrap(urlToCrawl, crawlOpts, crawlerOptions.cacheTolerance)) {
                    if (!scrapped) {
                        continue;
                    }

                    const formatted = await this.formatSnapshot(crawlerOptions.respondWith, scrapped, urlToCrawl);
                    chargeAmount = this.getChargeAmount(formatted);
                    sseStream.write({
                        event: 'data',
                        data: formatted,
                    });
                }
            } catch (err: any) {
                this.logger.error(`Failed to crawl ${urlToCrawl}`, { err: marshalErrorLike(err) });
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
            for await (const scrapped of this.cachedScrap(urlToCrawl, crawlOpts, crawlerOptions.cacheTolerance)) {
                lastScrapped = scrapped;
                if (crawlerOptions.waitForSelector || ((!scrapped?.parsed?.content || !scrapped.title?.trim()) && !scrapped?.pdfs?.length)) {
                    continue;
                }

                const formatted = await this.formatSnapshot(crawlerOptions.respondWith, scrapped, urlToCrawl);
                chargeAmount = this.getChargeAmount(formatted);

                return formatted;
            }

            if (!lastScrapped) {
                throw new AssertionFailureError(`No content available for URL ${urlToCrawl}`);
            }

            const formatted = await this.formatSnapshot(crawlerOptions.respondWith, lastScrapped, urlToCrawl);
            chargeAmount = this.getChargeAmount(formatted);

            return formatted;
        }

        for await (const scrapped of this.cachedScrap(urlToCrawl, crawlOpts, crawlerOptions.cacheTolerance)) {
            lastScrapped = scrapped;
            if (crawlerOptions.waitForSelector || ((!scrapped?.parsed?.content || !scrapped.title?.trim()) && !scrapped?.pdfs?.length)) {
                continue;
            }

            const formatted = await this.formatSnapshot(crawlerOptions.respondWith, scrapped, urlToCrawl);
            chargeAmount = this.getChargeAmount(formatted);
            if (crawlerOptions.respondWith === 'screenshot' && Reflect.get(formatted, 'screenshotUrl')) {

                return assignTransferProtocolMeta(`${formatted}`,
                    { code: 302, envelope: null, headers: { Location: Reflect.get(formatted, 'screenshotUrl') } }
                );
            }

            return assignTransferProtocolMeta(`${formatted}`, { contentType: 'text/plain', envelope: null });
        }

        if (!lastScrapped) {
            throw new AssertionFailureError(`No content available for URL ${urlToCrawl}`);
        }

        const formatted = await this.formatSnapshot(crawlerOptions.respondWith, lastScrapped, urlToCrawl);
        chargeAmount = this.getChargeAmount(formatted);
        if (crawlerOptions.respondWith === 'screenshot' && Reflect.get(formatted, 'screenshotUrl')) {

            return assignTransferProtocolMeta(`${formatted}`,
                { code: 302, envelope: null, headers: { Location: Reflect.get(formatted, 'screenshotUrl') } }
            );
        }

        return assignTransferProtocolMeta(`${formatted}`, { contentType: 'text/plain', envelope: null });
    }

    getUrlDigest(urlToCrawl: URL) {
        const normalizedURL = new URL(urlToCrawl);
        normalizedURL.hash = '';
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
        const preparations = [
            this.firebaseObjectStorage.downloadFile(`snapshots/${cache._id}`).then((r) => {
                snapshot = JSON.parse(r.toString('utf-8'));
            }),
            cache.screenshotAvailable ?
                this.firebaseObjectStorage.signDownloadUrl(`screenshots/${cache._id}`, Date.now() + this.urlValidMs).then((r) => {
                    screenshotUrl = r;
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
                screenshotUrl,
            } as PageSnapshot & { screenshotUrl?: string; }
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
        await savingOfSnapshot;
        const r = await Crawled.save(cache.degradeForFireStore()).catch((err) => {
            this.logger.error(`Failed to save cache for ${urlToCrawl}`, { err: marshalErrorLike(err) });

            return undefined;
        });

        return r;
    }

    async *cachedScrap(urlToCrawl: URL, crawlOpts?: ExtraScrappingOptions, cacheTolerance: number = this.cacheValidMs) {
        let cache;
        if (cacheTolerance && !crawlOpts?.cookies?.length) {
            cache = await this.queryCache(urlToCrawl, cacheTolerance);
        }

        if (cache?.isFresh && (!crawlOpts?.favorScreenshot || (crawlOpts?.favorScreenshot && cache?.screenshotAvailable))) {
            yield this.puppeteerControl.narrowSnapshot(cache.snapshot, crawlOpts?.targetSelector);

            return;
        }

        try {
            if (crawlOpts?.targetSelector) {
                for await (const x of this.puppeteerControl.scrap(urlToCrawl, crawlOpts)) {
                    yield this.puppeteerControl.narrowSnapshot(x, crawlOpts.targetSelector);
                }

                return;
            }

            yield* this.puppeteerControl.scrap(urlToCrawl, crawlOpts);
        } catch (err: any) {
            if (cache) {
                this.logger.warn(`Failed to scrap ${urlToCrawl}, but a stale cache is available. Falling back to cache`, { err: marshalErrorLike(err) });
                yield this.puppeteerControl.narrowSnapshot(cache.snapshot, crawlOpts?.targetSelector);
                return;
            }
            throw err;
        }
    }

    getChargeAmount(formatted: FormattedPage) {
        if (!formatted) {
            return undefined;
        }

        const textContent = formatted?.content || formatted?.description || formatted?.text || formatted?.html;

        if (typeof textContent === 'string') {
            return estimateToken(textContent);
        }

        const imageContent = formatted.screenshotUrl || formatted.screenshot;

        if (imageContent) {
            // OpenAI image token count for 1024x1024 image
            return 765;
        }

        return undefined;
    }


    async *scrapMany(urls: URL[], options?: ScrappingOptions, cacheTolerance?: number) {
        const iterators = urls.map((url) => this.cachedScrap(url, options, cacheTolerance));

        const results: (PageSnapshot | undefined)[] = iterators.map((_x) => undefined);

        let nextDeferred = Defer();
        let concluded = false;

        const handler = async (it: AsyncGenerator<PageSnapshot | undefined>, idx: number) => {
            for await (const x of it) {
                results[idx] = x;

                if (x) {
                    nextDeferred.resolve();
                    nextDeferred = Defer();
                }

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

        const crawlOpts: ExtraScrappingOptions = {
            proxyUrl: opts.proxyUrl,
            cookies: opts.setCookies,
            favorScreenshot: opts.respondWith === 'screenshot',
            waitForSelector: opts.waitForSelector,
            targetSelector: opts.targetSelector,
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
                return this.formatSnapshot(mode, lastSnapshot, url);
            }

            throw err;
        }

        if (!lastSnapshot) {
            throw new AssertionFailureError(`No content available`);
        }

        return this.formatSnapshot(mode, lastSnapshot, url);
    }

}
