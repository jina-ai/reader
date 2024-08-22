import {
    assignTransferProtocolMeta, marshalErrorLike,
    RPCHost, RPCReflection,
    HashManager,
    AssertionFailureError, ParamValidationError, Defer,
} from 'civkit';
import { singleton } from 'tsyringe';
import { AsyncContext, CloudHTTPv2, Ctx, FirebaseStorageBucketControl, InsufficientBalanceError, Logger, OutputServerEventStream, RPCReflect, SecurityCompromiseError } from '../shared';
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
import { CrawlerOptions, CrawlerOptionsHeaderOnly } from '../dto/scrapping-options';
import { JinaEmbeddingsTokenAccount } from '../shared/db/jina-embeddings-token-account';
import { PDFExtractor } from '../services/pdf-extract';
import { DomainBlockade } from '../db/domain-blockade';
import { FirebaseRoundTripChecker } from '../shared/services/firebase-roundtrip-checker';
import { JSDomControl } from '../services/jsdom';

const md5Hasher = new HashManager('md5', 'hex');

export interface ExtraScrappingOptions extends ScrappingOptions {
    withIframe?: boolean;
    targetSelector?: string | string[];
    removeSelector?: string | string[];
    keepImgDataUrl?: boolean;
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
    pageshotUrl?: string;
    pageshot?: Buffer;
    links?: { [k: string]: string; };
    images?: { [k: string]: string; };
    usage?: {
        total_tokens?: number;
        totalTokens?: number;
        tokens?: number;
    };

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
    abuseBlockMs = 1000 * 3600;

    constructor(
        protected globalLogger: Logger,
        protected puppeteerControl: PuppeteerControl,
        protected jsdomControl: JSDomControl,
        protected altTextService: AltTextService,
        protected pdfExtractor: PDFExtractor,
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

    getTurndown(options?: {
        noRules?: boolean | string,
        url?: string | URL;
        imgDataUrlToObjectUrl?: boolean;
    }) {
        const turnDownService = new TurndownService({
            codeBlockStyle: 'fenced',
            preformattedCode: true,
        } as any);
        if (!options?.noRules) {
            turnDownService.addRule('remove-irrelevant', {
                filter: ['meta', 'style', 'script', 'noscript', 'link', 'textarea', 'select'],
                replacement: () => ''
            });
            turnDownService.addRule('truncate-svg', {
                filter: 'svg' as any,
                replacement: () => ''
            });
            turnDownService.addRule('title-as-h1', {
                filter: ['title'],
                replacement: (innerText) => `${innerText}\n===============\n`
            });
        }

        if (options?.imgDataUrlToObjectUrl) {
            turnDownService.addRule('data-url-to-pseudo-object-url', {
                filter: (node) => Boolean(node.tagName === 'IMG' && node.getAttribute('src')?.startsWith('data:')),
                replacement: (_content, node: any) => {
                    const src = (node.getAttribute('src') || '').trim();
                    const alt = cleanAttribute(node.getAttribute('alt')) || '';

                    if (options.url) {
                        const refUrl = new URL(options.url);
                        const mappedUrl = new URL(`blob:${refUrl.origin}/${md5Hasher.hash(src)}`);

                        return `![${alt}](${mappedUrl})`;
                    }

                    return `![${alt}](blob:${md5Hasher.hash(src)})`;
                }
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
                let fixedHref = href.replace(/\s+/g, '').trim();
                if (options?.url) {
                    try {
                        fixedHref = new URL(fixedHref, options.url).toString();
                    } catch (_err) {
                        void 0;
                    }
                }

                return `[${fixedContent}](${fixedHref}${title || ''})`;
            }
        });
        turnDownService.addRule('improved-code', {
            filter: function (node: any) {
                let hasSiblings = node.previousSibling || node.nextSibling;
                let isCodeBlock = node.parentNode.nodeName === 'PRE' && !hasSiblings;

                return node.nodeName === 'CODE' && !isCodeBlock;
            },

            replacement: function (inputContent: any) {
                if (!inputContent) return '';
                let content = inputContent;

                let delimiter = '`';
                let matches = content.match(/`+/gm) || [];
                while (matches.indexOf(delimiter) !== -1) delimiter = delimiter + '`';
                if (content.includes('\n')) {
                    delimiter = '```';
                }

                let extraSpace = delimiter === '```' ? '\n' : /^`|^ .*?[^ ].* $|`$/.test(content) ? ' ' : '';

                return delimiter + extraSpace + content + (delimiter === '```' && !content.endsWith(extraSpace) ? extraSpace : '') + delimiter;
            }
        });

        return turnDownService;
    }

    getGeneralSnapshotMixins(snapshot: PageSnapshot) {
        let inferred;
        const mixin: any = {};
        if (this.threadLocal.get('withImagesSummary')) {
            inferred ??= this.jsdomControl.inferSnapshot(snapshot);
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
            inferred ??= this.jsdomControl.inferSnapshot(snapshot);
            mixin.links = _.invert(inferred.links || {});
        }

        return mixin;
    }

    async formatSnapshot(mode: string | 'markdown' | 'html' | 'text' | 'screenshot' | 'pageshot', snapshot: PageSnapshot & {
        screenshotUrl?: string;
        pageshotUrl?: string;
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
                // html: snapshot.html,
                screenshotUrl: snapshot.screenshotUrl,
                toString() {
                    return this.screenshotUrl;
                }
            } as FormattedPage;
        }
        if (mode === 'pageshot') {
            if (snapshot.pageshot && !snapshot.pageshotUrl) {
                const fid = `instant-screenshots/${randomUUID()}`;
                await this.firebaseObjectStorage.saveFile(fid, snapshot.pageshot, {
                    metadata: {
                        contentType: 'image/png',
                    }
                });
                snapshot.pageshotUrl = await this.firebaseObjectStorage.signDownloadUrl(fid, Date.now() + this.urlValidMs);
            }

            return {
                ...this.getGeneralSnapshotMixins(snapshot),
                html: snapshot.html,
                pageshotUrl: snapshot.pageshotUrl,
                toString() {
                    return this.pageshotUrl;
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
            const pdf = await this.pdfExtractor.cachedExtract(snapshot.pdfs[0],
                this.threadLocal.get('cacheTolerance')
            );
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
        const imgDataUrlToObjectUrl = !Boolean(this.threadLocal.get('keepImgDataUrl'));

        let contentText = '';
        const imageSummary = {} as { [k: string]: string; };
        const imageIdxTrack = new Map<string, number[]>();
        const uid = this.threadLocal.get('uid');
        do {
            if (pdfMode) {
                contentText = snapshot.parsed?.content || snapshot.text;
                break;
            }

            if (
                snapshot.maxElemDepth! > 256 ||
                (!uid && snapshot.elemCount! > 10_000) ||
                snapshot.elemCount! > 70_000
            ) {
                this.logger.warn('Degrading to text to protect the server', { url: snapshot.href });
                contentText = snapshot.text;
                break;
            }

            const jsDomElementOfHTML = this.jsdomControl.snippetToElement(snapshot.html, snapshot.href);
            let toBeTurnedToMd = jsDomElementOfHTML;
            let turnDownService = this.getTurndown({ url: snapshot.rebase || nominalUrl, imgDataUrlToObjectUrl });
            if (mode !== 'markdown' && snapshot.parsed?.content) {
                const jsDomElementOfParsed = this.jsdomControl.snippetToElement(snapshot.parsed.content, snapshot.href);
                const par1 = this.jsdomControl.runTurndown(turnDownService, jsDomElementOfHTML);
                const par2 = snapshot.parsed.content ? this.jsdomControl.runTurndown(turnDownService, jsDomElementOfParsed) : '';

                // If Readability did its job
                if (par2.length >= 0.3 * par1.length) {
                    turnDownService = this.getTurndown({ noRules: true, url: snapshot.rebase || nominalUrl, imgDataUrlToObjectUrl });
                    if (snapshot.parsed.content) {
                        toBeTurnedToMd = jsDomElementOfParsed;
                    }
                }
            }

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
                        src = new URL(linkPreferredSrc, snapshot.rebase || nominalUrl).toString();
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

                        if (src?.startsWith('data:') && imgDataUrlToObjectUrl) {
                            const mappedUrl = new URL(`blob:${nominalUrl?.origin || ''}/${md5Hasher.hash(src)}`);
                            mappedUrl.protocol = 'blob:';

                            return `![Image ${imgIdx}: ${mapped || alt}](${mappedUrl})`;
                        }

                        return `![Image ${imgIdx}: ${mapped || alt}](${src})`;
                    }

                    imageSummary[src] = alt || '';

                    if (src?.startsWith('data:') && imgDataUrlToObjectUrl) {
                        const mappedUrl = new URL(`blob:${nominalUrl?.origin || ''}/${md5Hasher.hash(src)}`);
                        mappedUrl.protocol = 'blob:';

                        return alt ? `![Image ${imgIdx}: ${alt}](${mappedUrl})` : `![Image ${imgIdx}](${mappedUrl})`;
                    }

                    return alt ? `![Image ${imgIdx}: ${alt}](${src})` : `![Image ${imgIdx}](${src})`;
                }
            });

            if (toBeTurnedToMd) {
                try {
                    contentText = this.jsdomControl.runTurndown(turnDownService, toBeTurnedToMd).trim();
                } catch (err) {
                    this.logger.warn(`Turndown failed to run, retrying without plugins`, { err });
                    const vanillaTurnDownService = this.getTurndown({ url: snapshot.rebase || nominalUrl, imgDataUrlToObjectUrl });
                    try {
                        contentText = this.jsdomControl.runTurndown(vanillaTurnDownService, toBeTurnedToMd).trim();
                    } catch (err2) {
                        this.logger.warn(`Turndown failed to run, giving up`, { err: err2 });
                    }
                }
            }

            if (
                !contentText || (contentText.startsWith('<') && contentText.endsWith('>'))
                && toBeTurnedToMd !== jsDomElementOfHTML
            ) {
                try {
                    contentText = this.jsdomControl.runTurndown(turnDownService, snapshot.html);
                } catch (err) {
                    this.logger.warn(`Turndown failed to run, retrying without plugins`, { err });
                    const vanillaTurnDownService = this.getTurndown({ url: snapshot.rebase || nominalUrl, imgDataUrlToObjectUrl });
                    try {
                        contentText = this.jsdomControl.runTurndown(vanillaTurnDownService, snapshot.html);
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
            formatted.links = _.invert(this.jsdomControl.inferSnapshot(snapshot).links || {});
        }

        return formatted as FormattedPage;
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
            concurrency: 22,
            maxInstances: 455,
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
        const noSlashURL = ctx.req.url.slice(1);
        const crawlerOptions = ctx.req.method === 'GET' ? crawlerOptionsHeaderOnly : crawlerOptionsParamsAllowed;
        if (!noSlashURL && !crawlerOptions.url) {
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

        let urlToCrawl;
        const normalizeUrl = (await pNormalizeUrl).default;
        try {
            urlToCrawl = new URL(
                normalizeUrl(
                    (crawlerOptions.url || noSlashURL).trim(),
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
        if (urlToCrawl.protocol !== 'http:' && urlToCrawl.protocol !== 'https:') {
            throw new ParamValidationError({
                message: `Invalid protocol ${urlToCrawl.protocol}`,
                path: 'url'
            });
        }

        if (!uid) {
            if (urlToCrawl.protocol === 'http:' && (!urlToCrawl.pathname || urlToCrawl.pathname === '/') &&
                crawlerOptions.respondWith !== 'default') {
                throw new SecurityCompromiseError(`Your request is categorized as abuse. Please don't abuse our service. If you are sure you are not abusing, please authenticate yourself with an API key.`);
            }
            const blockade = (await DomainBlockade.fromFirestoreQuery(
                DomainBlockade.COLLECTION
                    .where('domain', '==', urlToCrawl.hostname.toLowerCase())
                    .where('expireAt', '>=', new Date())
                    .limit(1)
            ))[0];
            if (blockade) {
                throw new SecurityCompromiseError(`Domain ${urlToCrawl.hostname} blocked until ${blockade.expireAt || 'Eternally'} due to previous abuse found on ${blockade.triggerUrl || 'site'}: ${blockade.triggerReason}`);
            }

        }
        const crawlOpts = this.configure(crawlerOptions);


        if (!ctx.req.accepts('text/plain') && ctx.req.accepts('text/event-stream')) {
            const sseStream = new OutputServerEventStream();
            rpcReflect.return(sseStream);

            try {
                for await (const scrapped of this.cachedScrap(urlToCrawl, crawlOpts, crawlerOptions)) {
                    if (!scrapped) {
                        continue;
                    }

                    const formatted = await this.formatSnapshot(crawlerOptions.respondWith, scrapped, urlToCrawl);
                    chargeAmount = this.assignChargeAmount(formatted);
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
            for await (const scrapped of this.cachedScrap(urlToCrawl, crawlOpts, crawlerOptions)) {
                lastScrapped = scrapped;
                if (crawlerOptions.waitForSelector || ((!scrapped?.parsed?.content || !scrapped.title?.trim()) && !scrapped?.pdfs?.length)) {
                    continue;
                }

                const formatted = await this.formatSnapshot(crawlerOptions.respondWith, scrapped, urlToCrawl);
                chargeAmount = this.assignChargeAmount(formatted);

                if (crawlerOptions.timeout === undefined) {
                    return formatted;
                }
            }

            if (!lastScrapped) {
                throw new AssertionFailureError(`No content available for URL ${urlToCrawl}`);
            }

            const formatted = await this.formatSnapshot(crawlerOptions.respondWith, lastScrapped, urlToCrawl);
            chargeAmount = this.assignChargeAmount(formatted);

            return formatted;
        }

        for await (const scrapped of this.cachedScrap(urlToCrawl, crawlOpts, crawlerOptions)) {
            lastScrapped = scrapped;
            if (crawlerOptions.waitForSelector || ((!scrapped?.parsed?.content || !scrapped.title?.trim()) && !scrapped?.pdfs?.length)) {
                continue;
            }

            const formatted = await this.formatSnapshot(crawlerOptions.respondWith, scrapped, urlToCrawl);
            chargeAmount = this.assignChargeAmount(formatted);

            if (crawlerOptions.timeout === undefined) {
                if (crawlerOptions.respondWith === 'screenshot' && Reflect.get(formatted, 'screenshotUrl')) {

                    return assignTransferProtocolMeta(`${formatted}`,
                        { code: 302, envelope: null, headers: { Location: Reflect.get(formatted, 'screenshotUrl') } }
                    );
                }
                if (crawlerOptions.respondWith === 'pageshot' && Reflect.get(formatted, 'pageshotUrl')) {

                    return assignTransferProtocolMeta(`${formatted}`,
                        { code: 302, envelope: null, headers: { Location: Reflect.get(formatted, 'pageshotUrl') } }
                    );
                }

                return assignTransferProtocolMeta(`${formatted}`, { contentType: 'text/plain', envelope: null });
            }
        }

        if (!lastScrapped) {
            throw new AssertionFailureError(`No content available for URL ${urlToCrawl}`);
        }

        const formatted = await this.formatSnapshot(crawlerOptions.respondWith, lastScrapped, urlToCrawl);
        chargeAmount = this.assignChargeAmount(formatted);
        if (crawlerOptions.respondWith === 'screenshot' && Reflect.get(formatted, 'screenshotUrl')) {

            return assignTransferProtocolMeta(`${formatted}`,
                { code: 302, envelope: null, headers: { Location: Reflect.get(formatted, 'screenshotUrl') } }
            );
        }
        if (crawlerOptions.respondWith === 'pageshot' && Reflect.get(formatted, 'pageshotUrl')) {

            return assignTransferProtocolMeta(`${formatted}`,
                { code: 302, envelope: null, headers: { Location: Reflect.get(formatted, 'pageshotUrl') } }
            );
        }

        return assignTransferProtocolMeta(`${formatted}`, { contentType: 'text/plain', envelope: null });
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

        if (cache?.isFresh && (!crawlOpts?.favorScreenshot || (crawlOpts?.favorScreenshot && (cache.screenshotAvailable && cache.pageshotAvailable)))) {
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
