import { randomUUID } from 'crypto';
import { container, singleton } from 'tsyringe';
import { AssertionFailureError, AsyncService, FancyFile, HashManager, marshalErrorLike } from 'civkit';
import TurndownService, { Filter, Rule } from 'turndown';
import { Logger } from '../shared/services/logger';
import { PageSnapshot } from './puppeteer';
import { FirebaseStorageBucketControl } from '../shared/services/firebase-storage-bucket';
import { AsyncContext } from '../shared/services/async-context';
import { Threaded } from '../services/threaded';
import { JSDomControl } from './jsdom';
import { AltTextService } from './alt-text';
import { PDFExtractor } from './pdf-extract';
import { cleanAttribute } from '../utils/misc';
import _ from 'lodash';
import { STATUS_CODES } from 'http';
import type { CrawlerOptions } from '../dto/crawler-options';
import { readFile } from 'fs/promises';
import { pathToFileURL } from 'url';
import { countGPTToken } from '../shared';


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
    links?: { [k: string]: string; } | [string, string][];
    images?: { [k: string]: string; } | [string, string][];
    warning?: string;
    favicon?: string;
    usage?: {
        total_tokens?: number;
        totalTokens?: number;
        tokens?: number;
    };

    textRepresentation?: string;

    [Symbol.dispose]: () => void;
}

export const md5Hasher = new HashManager('md5', 'hex');

const gfmPlugin = require('turndown-plugin-gfm');
const highlightRegExp = /highlight-(?:text|source)-([a-z0-9]+)/;

export function highlightedCodeBlock(turndownService: TurndownService) {
    turndownService.addRule('highlightedCodeBlock', {
        filter: (node) => {
            return (
                node.nodeName === 'DIV' &&
                node.firstChild?.nodeName === 'PRE' &&
                highlightRegExp.test(node.className)
            );
        },
        replacement: (_content, node, options) => {
            const className = (node as any).className || '';
            const language = (className.match(highlightRegExp) || [null, ''])[1];

            return (
                '\n\n' + options.fence + language + '\n' +
                node.firstChild!.textContent +
                '\n' + options.fence + '\n\n'
            );
        }
    });
}

@singleton()
export class SnapshotFormatter extends AsyncService {

    logger = this.globalLogger.child({ service: this.constructor.name });

    gfmPlugin = [gfmPlugin.tables, highlightedCodeBlock, gfmPlugin.strikethrough, gfmPlugin.taskListItems];
    gfmNoTable = [highlightedCodeBlock, gfmPlugin.strikethrough, gfmPlugin.taskListItems];

    constructor(
        protected globalLogger: Logger,
        protected jsdomControl: JSDomControl,
        protected altTextService: AltTextService,
        protected pdfExtractor: PDFExtractor,
        protected threadLocal: AsyncContext,
        protected firebaseObjectStorage: FirebaseStorageBucketControl,
    ) {
        super(...arguments);
    }

    override async init() {
        await this.dependencyReady();
        this.emit('ready');
    }


    @Threaded()
    async formatSnapshot(mode: string | 'markdown' | 'html' | 'text' | 'screenshot' | 'pageshot', snapshot: PageSnapshot & {
        screenshotUrl?: string;
        pageshotUrl?: string;
    }, nominalUrl?: URL, urlValidMs = 3600 * 1000 * 4) {
        const t0 = Date.now();
        const f = {
            ...(await this.getGeneralSnapshotMixins(snapshot)),
        };
        let modeOK = false;

        if (mode.includes('screenshot')) {
            modeOK = true;
            if (snapshot.screenshot && !snapshot.screenshotUrl) {
                const fid = `instant-screenshots/${randomUUID()}`;
                await this.firebaseObjectStorage.saveFile(fid, snapshot.screenshot, {
                    metadata: {
                        contentType: 'image/png',
                    }
                });
                snapshot.screenshotUrl = await this.firebaseObjectStorage.signDownloadUrl(fid, Date.now() + urlValidMs);
            }
            Object.assign(f, {
                screenshotUrl: snapshot.screenshotUrl,
            });

            Object.defineProperty(f, 'textRepresentation', { value: `${f.screenshotUrl}\n`, enumerable: false, configurable: true });
        }
        if (mode.includes('pageshot')) {
            modeOK = true;
            if (snapshot.pageshot && !snapshot.pageshotUrl) {
                const fid = `instant-screenshots/${randomUUID()}`;
                await this.firebaseObjectStorage.saveFile(fid, snapshot.pageshot, {
                    metadata: {
                        contentType: 'image/png',
                    }
                });
                snapshot.pageshotUrl = await this.firebaseObjectStorage.signDownloadUrl(fid, Date.now() + urlValidMs);
            }
            Object.assign(f, {
                html: snapshot.html,
                pageshotUrl: snapshot.pageshotUrl,
            });
            Object.defineProperty(f, 'textRepresentation', { value: `${f.pageshotUrl}\n`, enumerable: false, configurable: true });
        }
        if (mode.includes('html')) {
            modeOK = true;
            Object.assign(f, {
                html: snapshot.html,
            });

            Object.defineProperty(f, 'textRepresentation', { value: snapshot.html, enumerable: false, configurable: true });
        }

        let pdfMode = false;
        // in case of Google Web Cache content
        if (snapshot.pdfs?.length && (!snapshot.title || snapshot.title.startsWith('cache:'))) {
            const pdf = await this.pdfExtractor.cachedExtract(snapshot.pdfs[0],
                this.threadLocal.get('cacheTolerance'),
                snapshot.pdfs[0].startsWith('http') ? undefined : snapshot.href,
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

        if (mode.includes('text')) {
            modeOK = true;
            Object.assign(f, {
                text: snapshot.text,
            });
            Object.defineProperty(f, 'textRepresentation', { value: snapshot.text, enumerable: false, configurable: true });
        }

        if (mode.includes('lm')) {
            modeOK = true;
            f.content = snapshot.parsed?.textContent;
        }

        if (modeOK && (mode.includes('lm') ||
            (!mode.includes('markdown') && !mode.includes('content')))
        ) {
            const dt = Date.now() - t0;
            this.logger.debug(`Formatting took ${dt}ms`, { mode, url: nominalUrl?.toString(), dt });

            const formatted: FormattedPage = {
                title: (snapshot.parsed?.title || snapshot.title || '').trim(),
                description: (snapshot.description || '').trim(),
                url: nominalUrl?.toString() || snapshot.href?.trim(),
                publishedTime: snapshot.parsed?.publishedTime || undefined,
                [Symbol.dispose]: () => { },
            };

            Object.assign(f, formatted);

            return f;
        }

        const imgDataUrlToObjectUrl = !Boolean(this.threadLocal.get('keepImgDataUrl'));

        let contentText = '';
        const imageSummary = {} as { [k: string]: string; };
        const imageIdxTrack = new Map<string, number[]>();
        const uid = this.threadLocal.get('uid');
        do {
            if (pdfMode) {
                contentText = (snapshot.parsed?.content || snapshot.text || '').trim();
                break;
            }

            if (
                snapshot.maxElemDepth! > 256 ||
                (!uid && snapshot.elemCount! > 10_000) ||
                snapshot.elemCount! > 80_000
            ) {
                this.logger.warn('Degrading to text to protect the server', { url: snapshot.href, elemDepth: snapshot.maxElemDepth, elemCount: snapshot.elemCount });
                contentText = (snapshot.text || '').trimEnd();
                break;
            }

            const urlToAltMap: { [k: string]: string | undefined; } = {};
            const noGFMOpts = this.threadLocal.get('noGfm');
            const imageRetention = this.threadLocal.get('retainImages') as CrawlerOptions['retainImages'];
            let imgIdx = 0;
            const customRules: { [k: string]: Rule; } = {
                'img-retention': {
                    filter: 'img',
                    replacement: (_content: string, node: HTMLElement) => {
                        if (imageRetention === 'none') {
                            return '';
                        }
                        const alt = cleanAttribute(node.getAttribute('alt'));

                        if (imageRetention === 'alt') {
                            return alt ? `(Image ${++imgIdx}: ${alt})` : '';
                        }
                        const originalSrc = (node.getAttribute('src') || '').trim();
                        let linkPreferredSrc = originalSrc;
                        const maybeSrcSet: string = (node.getAttribute('srcset') || '').trim();
                        if (!linkPreferredSrc && maybeSrcSet) {
                            linkPreferredSrc = maybeSrcSet.split(',').map((x) => x.trim()).filter(Boolean)[0];
                        }
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
                        if (!src) {
                            return '';
                        }
                        const mapped = urlToAltMap[originalSrc];
                        const imgSerial = ++imgIdx;
                        const idxArr = imageIdxTrack.has(src) ? imageIdxTrack.get(src)! : [];
                        idxArr.push(imgSerial);
                        imageIdxTrack.set(src, idxArr);

                        if (mapped) {
                            imageSummary[src] = mapped || alt;

                            if (imageRetention === 'alt_p') {
                                return `(Image ${imgIdx}: ${mapped || alt})`;
                            }

                            if (src?.startsWith('data:') && imgDataUrlToObjectUrl) {
                                const mappedUrl = new URL(`blob:${nominalUrl?.origin || ''}/${md5Hasher.hash(src)}`);
                                mappedUrl.protocol = 'blob:';

                                return `![Image ${imgIdx}: ${mapped || alt}](${mappedUrl})`;
                            }

                            return `![Image ${imgIdx}: ${mapped || alt}](${src})`;
                        } else if (imageRetention === 'alt_p') {
                            return alt ? `(Image ${imgIdx}: ${alt})` : '';
                        }

                        imageSummary[src] = alt || '';

                        if (src?.startsWith('data:') && imgDataUrlToObjectUrl) {
                            const mappedUrl = new URL(`blob:${nominalUrl?.origin || ''}/${md5Hasher.hash(src)}`);
                            mappedUrl.protocol = 'blob:';

                            return alt ? `![Image ${imgIdx}: ${alt}](${mappedUrl})` : `![Image ${imgIdx}](${mappedUrl})`;
                        }

                        return alt ? `![Image ${imgIdx}: ${alt}](${src})` : `![Image ${imgIdx}](${src})`;
                    }
                } as Rule
            };
            const optsMixin = {
                url: snapshot.rebase || nominalUrl,
                customRules,
                customKeep: noGFMOpts === 'table' ? 'table' : undefined,
                imgDataUrlToObjectUrl,
            } as const;

            const jsDomElementOfHTML = this.jsdomControl.snippetToElement(snapshot.html, snapshot.href);
            let toBeTurnedToMd = jsDomElementOfHTML;
            let turnDownService = this.getTurndown({ ...optsMixin });
            if (!mode.includes('markdown') && snapshot.parsed?.content) {
                const jsDomElementOfParsed = this.jsdomControl.snippetToElement(snapshot.parsed.content, snapshot.href);
                const par1 = this.jsdomControl.runTurndown(turnDownService, jsDomElementOfHTML);
                imgIdx = 0;
                const par2 = snapshot.parsed.content ? this.jsdomControl.runTurndown(turnDownService, jsDomElementOfParsed) : '';

                // If Readability did its job
                if (par2.length >= 0.3 * par1.length) {
                    turnDownService = this.getTurndown({ noRules: true, ...optsMixin });
                    imgIdx = 0;
                    if (snapshot.parsed.content) {
                        toBeTurnedToMd = jsDomElementOfParsed;
                    }
                }
            }

            if (!noGFMOpts) {
                turnDownService = turnDownService.use(noGFMOpts === 'table' ? this.gfmNoTable : this.gfmPlugin);
            }

            // _p is the special suffix for withGeneratedAlt
            if (snapshot.imgs?.length && imageRetention?.endsWith('_p')) {
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

            if (toBeTurnedToMd) {
                try {
                    contentText = this.jsdomControl.runTurndown(turnDownService, toBeTurnedToMd).trim();
                    imgIdx = 0;
                } catch (err) {
                    this.logger.warn(`Turndown failed to run, retrying without plugins`, { err });
                    const vanillaTurnDownService = this.getTurndown({ ...optsMixin });
                    try {
                        contentText = this.jsdomControl.runTurndown(vanillaTurnDownService, toBeTurnedToMd).trim();
                        imgIdx = 0;
                    } catch (err2) {
                        this.logger.warn(`Turndown failed to run, giving up`, { err: err2 });
                    }
                }
            }

            if (
                this.isPoorlyTransformed(contentText, toBeTurnedToMd)
                && toBeTurnedToMd !== jsDomElementOfHTML
            ) {
                toBeTurnedToMd = jsDomElementOfHTML;
                try {
                    contentText = this.jsdomControl.runTurndown(turnDownService, jsDomElementOfHTML).trim();
                    imgIdx = 0;
                } catch (err) {
                    this.logger.warn(`Turndown failed to run, retrying without plugins`, { err });
                    const vanillaTurnDownService = this.getTurndown({ ...optsMixin });
                    try {
                        contentText = this.jsdomControl.runTurndown(vanillaTurnDownService, jsDomElementOfHTML).trim();
                        imgIdx = 0;
                    } catch (err2) {
                        this.logger.warn(`Turndown failed to run, giving up`, { err: err2 });
                    }
                }
            }
            if (mode === 'content' && this.isPoorlyTransformed(contentText, toBeTurnedToMd)) {
                contentText = (snapshot.text || '').trimEnd();
            }
        } while (false);

        const formatted: FormattedPage = {
            title: (snapshot.parsed?.title || snapshot.title || '').trim(),
            description: (snapshot.description || '').trim(),
            url: nominalUrl?.toString() || snapshot.href?.trim(),
            content: contentText,
            publishedTime: snapshot.parsed?.publishedTime || undefined,
            [Symbol.dispose]: () => { },
        };

        if (snapshot.status) {
            const code = snapshot.status;
            const n = code - 200;
            if (n < 0 || n >= 200) {
                const text = snapshot.statusText || STATUS_CODES[code];
                formatted.warning ??= '';
                const msg = `Target URL returned error ${code}${text ? `: ${text}` : ''}`;
                formatted.warning = `${formatted.warning}${formatted.warning ? '\n': ''}${msg}`;
            }
        }

        if (this.threadLocal.get('withImagesSummary')) {
            formatted.images =
                _(imageSummary)
                    .toPairs()
                    .map(
                        ([url, alt], i) => {
                            if (imgDataUrlToObjectUrl && url.startsWith('data:')) {
                                const refUrl = new URL(formatted.url!);
                                const mappedUrl = new URL(`blob:${refUrl.origin}/${md5Hasher.hash(url)}`);

                                url = mappedUrl.toString();
                            }
                            return [`Image ${(imageIdxTrack?.get(url) || [i + 1]).join(',')}${alt ? `: ${alt}` : ''}`, url];
                        }
                    ).fromPairs()
                    .value();
        }
        if (this.threadLocal.get('withLinksSummary')) {
            const links = (await this.jsdomControl.inferSnapshot(snapshot)).links;

            if (this.threadLocal.get('withLinksSummary') === 'all') {
                formatted.links = links;
            } else {
                formatted.links = _(links).filter(([_label, href]) => !href.startsWith('file:') && !href.startsWith('javascript:')).uniqBy(1).fromPairs().value();
            }
        }

        if (countGPTToken(formatted.content) < 200) {
            formatted.warning ??= '';
            if (snapshot.isIntermediate) {
                const msg = 'This page maybe not yet fully loaded, consider explicitly specify a timeout.';
                formatted.warning = `${formatted.warning}${formatted.warning ? '\n': ''}${msg}`;
            }
            if (snapshot.childFrames?.length && !this.threadLocal.get('withIframe')) {
                const msg = 'This page contains iframe that are currently hidden, consider enabling iframe processing.';
                formatted.warning = `${formatted.warning}${formatted.warning ? '\n': ''}${msg}`;
            }
            if (snapshot.shadowExpanded && !this.threadLocal.get('withShadowDom')) {
                const msg = 'This page contains shadow DOM that are currently hidden, consider enabling shadow DOM processing.';
                formatted.warning = `${formatted.warning}${formatted.warning ? '\n': ''}${msg}`;
            }
            if (snapshot.html.includes('captcha') || snapshot.html.includes('cf-turnstile-response')) {
                const msg = 'This page maybe requiring CAPTCHA, please make sure you are authorized to access this page.';
                formatted.warning = `${formatted.warning}${formatted.warning ? '\n': ''}${msg}`;
            }
            if (snapshot.isFromCache) {
                const msg = 'This is a cached snapshot of the original page, consider retry with caching opt-out.';
                formatted.warning = `${formatted.warning}${formatted.warning ? '\n': ''}${msg}`;
            }
        }

        Object.assign(f, formatted);

        const textRepresentation = (function (this: typeof formatted) {
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
                if (Array.isArray(this.links)) {
                    for (const [k, v] of this.links) {
                        linkSummaryChunks.push(`- [${k}](${v})`);
                    }
                } else {
                    for (const [k, v] of Object.entries(this.links)) {
                        linkSummaryChunks.push(`- [${k}](${v})`);
                    }
                }
                if (linkSummaryChunks.length === 1) {
                    linkSummaryChunks.push('This page does not seem to contain any buttons/links.');
                }
                suffixMixins.push(linkSummaryChunks.join('\n'));
            }

            if (this.warning) {
                mixins.push(this.warning.split('\n').map((v) => `Warning: ${v}`).join('\n'));
            }

            if (mode.includes('markdown')) {
                return `${mixins.length ? `${mixins.join('\n\n')}\n\n` : ''}${this.content}
${suffixMixins.length ? `\n${suffixMixins.join('\n\n')}\n` : ''}`;
            }

            return `Title: ${this.title}

URL Source: ${this.url}
${mixins.length ? `\n${mixins.join('\n\n')}\n` : ''}
Markdown Content:
${this.content}
${suffixMixins.length ? `\n${suffixMixins.join('\n\n')}\n` : ''}`;
        }).call(formatted);

        Object.defineProperty(f, 'textRepresentation', { value: textRepresentation, enumerable: false });

        const dt = Date.now() - t0;
        this.logger.debug(`Formatting took ${dt}ms`, { mode, url: nominalUrl?.toString(), dt });

        return f as FormattedPage;
    }

    async getGeneralSnapshotMixins(snapshot: PageSnapshot) {
        let inferred;
        const mixin: any = {};
        if (this.threadLocal.get('withImagesSummary')) {
            inferred ??= await this.jsdomControl.inferSnapshot(snapshot);
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
            inferred ??= await this.jsdomControl.inferSnapshot(snapshot);
            if (this.threadLocal.get('withLinksSummary') === 'all') {
                mixin.links = inferred.links;
            } else {
                mixin.links = _(inferred.links).filter(([_label, href]) => !href.startsWith('file:') && !href.startsWith('javascript:')).uniqBy(1).fromPairs().value();
            }
        }
        if (snapshot.status) {
            const code = snapshot.status;
            const n = code - 200;
            if (n < 0 || n >= 200) {
                const text = snapshot.statusText || STATUS_CODES[code];
                mixin.warning ??= '';
                const msg = `Target URL returned error ${code}${text ? `: ${text}` : ''}`;
                mixin.warning = `${mixin.warning}${mixin.warning ? '\n': ''}${msg}`;
            }
        }

        return mixin;
    }

    getTurndown(options?: {
        noRules?: boolean | string,
        url?: string | URL;
        imgDataUrlToObjectUrl?: boolean;
        removeImages?: boolean | 'src';
        customRules?: { [k: string]: Rule; };
        customKeep?: Filter;
    }) {
        const turnDownService = new TurndownService({
            codeBlockStyle: 'fenced',
            preformattedCode: true,
        } as any);
        if (options?.customKeep) {
            turnDownService.keep(options.customKeep);
        }
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

        if (options?.customRules) {
            for (const [k, v] of Object.entries(options.customRules)) {
                turnDownService.addRule(k, v);
            }
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
                const href = node.getAttribute('href');
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


    isPoorlyTransformed(content?: string, node?: Element) {
        if (!content) {
            return true;
        }

        if (content.startsWith('<') && content.endsWith('>')) {
            return true;
        }

        if (!this.threadLocal.get('noGfm') && content.includes('<table') && content.includes('</table>')) {
            if (node?.textContent && content.length > node.textContent.length * 0.8) {
                return true;
            }

            const tableElms = node?.querySelectorAll('table') || [];
            const deepTableElms = node?.querySelectorAll('table table');
            if (node && tableElms.length) {
                const wrappingTables = _.without(tableElms, ...Array.from(deepTableElms || []));
                const tableTextsLength = _.sum(wrappingTables.map((x) => (x.innerHTML?.length || 0)));

                if (tableTextsLength / (content.length) > 0.6) {
                    return true;
                }
            }

            const tbodyElms = node?.querySelectorAll('tbody') || [];
            const deepTbodyElms = node?.querySelectorAll('tbody tbody');
            if ((deepTbodyElms?.length || 0) / tbodyElms.length > 0.6) {
                return true;
            }
        }

        return false;
    }

    async createSnapshotFromFile(url: URL, file: FancyFile, overrideContentType?: string, overrideFileName?: string) {
        if (overrideContentType === 'application/octet-stream') {
            overrideContentType = undefined;
        }

        const contentType = (overrideContentType || await file.mimeType).toLowerCase();
        const fileName = overrideFileName || `${url.origin}${url.pathname}`;
        const snapshot: PageSnapshot = {
            title: '',
            href: url.href,
            html: '',
            text: ''
        };

        if (contentType.startsWith('image/')) {
            snapshot.html = `<html style="height: 100%;"><head><meta name="viewport" content="width=device-width, minimum-scale=0.1"><title>${fileName}</title></head><body style="margin: 0px; height: 100%; background-color: rgb(14, 14, 14);"><img style="display: block;-webkit-user-select: none;margin: auto;background-color: hsl(0, 0%, 90%);transition: background-color 300ms;" src="${url.href}"></body></html>`;
            snapshot.title = fileName;

            return snapshot;
        }
        if (contentType.startsWith('text/html')) {
            if ((await file.size) > 1024 * 1024 * 32) {
                throw new AssertionFailureError(`Failed to access ${url}: file too large`);
            }
            snapshot.html = await readFile(await file.filePath, { encoding: 'utf-8' });

            return snapshot;
        }
        if (contentType.startsWith('text/') || contentType.startsWith('application/json')) {
            if ((await file.size) > 1024 * 1024 * 32) {
                throw new AssertionFailureError(`Failed to access ${url}: file too large`);
            }
            snapshot.text = await readFile(await file.filePath, { encoding: 'utf-8' });
            snapshot.html = `<html><head><meta name="color-scheme" content="light dark"></head><body><pre style="word-wrap: break-word; white-space: pre-wrap;">${snapshot.text}</pre></body></html>`;

            return snapshot;
        }
        if (contentType.startsWith('application/pdf')) {
            snapshot.pdfs = [pathToFileURL(await file.filePath).href];

            return snapshot;
        }

        throw new AssertionFailureError(`Failed to access ${url}: unexpected type ${contentType}`);
    }
}

const snapshotFormatter = container.resolve(SnapshotFormatter);

export default snapshotFormatter;
