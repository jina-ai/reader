import _ from 'lodash';
import { STATUS_CODES } from 'http';
import { randomUUID } from 'crypto';
import { container, singleton } from 'tsyringe';
import { AsyncService } from 'civkit/async-service';
import { HashManager } from 'civkit/hash';
import { ArrayOf, AutoCastable, DictOf, Prop } from 'civkit/civ-rpc';
import { GlobalLogger } from './logger';
import { ExtendedSnapshot, PageSnapshot } from './puppeteer';
import { AsyncLocalContext } from '../services/async-context';
import { Threaded } from '../services/threaded';
import { JSDomControl } from './jsdom';
import { AltTextService } from './alt-text';
import { cleanAttribute } from '../utils/misc';
import type { CrawlerOptions } from '../dto/crawler-options';
import { countGPTToken, tokenTrim } from '../utils/openai';
import { MarkifyService, type MarkifyRule } from './markify';
import { StorageLayer } from '../db/noop-storage';
import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import pseudoTransfer from './pseudo-transfer';

export type ChunkNode = {
    title: string;
    level: number;
    cleanedTitle: string;
    content: string;
    contentWithoutTitle: string;
    parents: ChunkNode[];
};
export interface FormattedPage {
    title?: string;
    description?: string;
    url?: string;
    content?: string;
    chunks?: string[];
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
    usage?: {
        total_tokens?: number;
        totalTokens?: number;
        tokens?: number;
    };

    textRepresentation?: string;
    metadata?: { [k: string]: string; };
    external?: { [rel: string]: { [href: string]: { [k: string]: string; }; }; };
    numPages?: number;

    [Symbol.dispose]?: () => void;
}

export class FormattedPageDto extends AutoCastable {
    @Prop({
        default: '',
    })
    title!: string;

    @Prop({
        default: '',
    })
    description!: string;

    @Prop({
        required: true,
    })
    url!: string;

    @Prop()
    content?: string;
    @Prop({
        type: ArrayOf(String),
    })
    chunks?: string[];

    @Prop()
    publishedTime?: string;
    @Prop()
    html?: string;
    @Prop()
    text?: string;
    @Prop()
    screenshotUrl?: string;
    @Prop()
    pageshotUrl?: string;
    @Prop()
    numPages?: number;
    @Prop({
        type: [DictOf(String), ArrayOf(String)],
    })
    links?: { [k: string]: string; } | [string, string][];
    @Prop({
        type: [DictOf(String), ArrayOf(String)],
    })
    images?: { [k: string]: string; } | [string, string][];
    @Prop()
    warning?: string;
    @Prop({
        type: DictOf(String),
    })
    metadata?: { [k: string]: string; };
    @Prop({
        type: DictOf(DictOf(DictOf(String, Object), Object), Object),
    })
    external?: { [rel: string]: { [href: string]: { [k: string]: string; }; }; };

    get textRepresentation() {
        if (!this.content) {
            if (this.pageshotUrl) {
                return `${this.pageshotUrl}\n`;
            }
            if (this.screenshotUrl) {
                return `${this.screenshotUrl}\n`;
            }
            if (this.html) {
                return this.html;
            }
            if (this.text) {
                return this.text;
            }
        }

        if (this.chunks?.length) {
            return this.chunks.join('\n\n\u001d');
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

        if (this.numPages) {
            mixins.push(`Number of Pages: ${this.numPages}`);
        }

        return `Title: ${this.title}

URL Source: ${this.url}
${mixins.length ? `\n${mixins.join('\n\n')}\n` : ''}
Markdown Content:
${this.content}
${suffixMixins.length ? `\n${suffixMixins.join('\n\n')}\n` : ''}`;
    }
}

pseudoTransfer.expectPseudoTransferableType(FormattedPageDto);

export const md5Hasher = new HashManager('md5', 'hex');

const mdChunkingRegExp = /\n(?=#{1,6} )/g;

@singleton()
export class SnapshotFormatter extends AsyncService {

    logger = this.globalLogger.child({ service: this.constructor.name });

    constructor(
        protected globalLogger: GlobalLogger,
        protected jsdomControl: JSDomControl,
        protected altTextService: AltTextService,
        protected threadLocal: AsyncLocalContext,
        protected storageLayer: StorageLayer,
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
    }, nominalUrl: URL, urlValidMs = 3600 * 1000 * 4) {
        const t0 = Date.now();
        const { documentElement, mixin, snapshot: inferredSnapshot } = await this.generalSnapshotRoutine(snapshot);
        const f = {
            ...mixin,
        };
        let modeOK = false;

        if (mode.includes('screenshot') || mode.includes('pageshot')) {
            modeOK = true;
            if (snapshot.screenshot && !snapshot.screenshotUrl) {
                const fid = `instant-screenshots/${randomUUID()}`;
                await this.storageLayer.storeFile(fid, snapshot.screenshot, {
                    'Content-Type': 'image/png',
                });
                snapshot.screenshotUrl = await this.storageLayer.signDownloadUrl(fid, Math.ceil(urlValidMs / 1000));
            } else if (snapshot.screenshotUrl && snapshot.screenshotUrl.startsWith('file:')) {
                const fid = `instant-screenshots/${randomUUID()}`;
                const buff = await readFile(fileURLToPath(snapshot.screenshotUrl));
                await this.storageLayer.storeFile(fid, buff, {
                    'Content-Type': 'image/png',
                });
                snapshot.screenshotUrl = await this.storageLayer.signDownloadUrl(fid, Math.ceil(urlValidMs / 1000));
                snapshot.screenshot = buff;
            } else if (snapshot.childFrames?.[0]?.screenshotUrl) {
                const fileUrl = snapshot.childFrames[0].screenshotUrl;
                if (fileUrl.startsWith('file:')) {
                    const fid = `instant-screenshots/${randomUUID()}`;
                    const buff = await readFile(fileURLToPath(fileUrl));
                    await this.storageLayer.storeFile(fid, buff, {
                        'Content-Type': 'image/png',
                    });
                    snapshot.screenshotUrl ??= await this.storageLayer.signDownloadUrl(fid, Math.ceil(urlValidMs / 1000));
                    snapshot.screenshot ??= buff;
                }

            }
            Object.assign(f, {
                screenshotUrl: snapshot.screenshotUrl,
                screenshot: snapshot.screenshot,
            });

        }
        if (mode.includes('pageshot')) {
            modeOK = true;
            snapshot.pageshot ??= snapshot.screenshot;
            if (snapshot.pageshot && !snapshot.pageshotUrl) {
                const fid = `instant-screenshots/${randomUUID()}`;
                await this.storageLayer.storeFile(fid, snapshot.pageshot, {
                    'Content-Type': 'image/png',
                });
                snapshot.pageshotUrl = await this.storageLayer.signDownloadUrl(fid, Math.floor(urlValidMs / 1000));
            }
            Object.assign(f, {
                html: snapshot.html,
                pageshotUrl: snapshot.pageshotUrl || snapshot.screenshotUrl,
                pageshot: snapshot.pageshot || snapshot.screenshot,
            });
        }
        const maxTokens = this.threadLocal.get('maxTokens');
        if (mode.includes('html')) {
            modeOK = true;
            Object.assign(f, {
                html: maxTokens ? tokenTrim(snapshot.html, maxTokens) : snapshot.html,
            });
        }

        if (mode.includes('text')) {
            modeOK = true;
            Object.assign(f, {
                text: maxTokens ? tokenTrim(snapshot.text, maxTokens) : snapshot.text,
            });
        }

        if (mode.includes('lm') && snapshot.parsed?.textContent) {
            modeOK = true;
            f.content = maxTokens ? tokenTrim(snapshot.parsed.textContent, maxTokens) : snapshot.parsed.textContent;
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
                publishedTime: snapshot.parsed?.publishedTime || snapshot.metadata?.['article:published_time'] || snapshot.lastModified,
                metadata: snapshot.metadata,
                external: snapshot.external,
            };

            Object.assign(f, formatted);

            return FormattedPageDto.from(f);
        }

        const imgDataUrlToObjectUrl = !Boolean(this.threadLocal.get('keepImgDataUrl'));

        let contentText = '';
        const imageSummary = {} as { [k: string]: string; };
        const imageIdxTrack = new Map<string, number[]>();
        const uid = this.threadLocal.get('uid');
        const isInternal = this.threadLocal.get('isInternal');
        const baseUrl = new URL(snapshot.rebase || nominalUrl || snapshot.href);
        let markifyService: MarkifyService | undefined;
        let gptOssTransformedLinks: WeakSet<object> | undefined;
        do {
            if (snapshot.parsed?.content && !snapshot.html) {
                contentText = (snapshot.parsed?.content || snapshot.text || '').trim();
                break;
            }

            if (
                snapshot.maxElemDepth! > 256 ||
                (!uid && !isInternal && snapshot.elemCount! > 10_000) ||
                snapshot.elemCount! > 80_000
            ) {
                this.logger.warn('Degrading to text to protect the server', { url: snapshot.href, elemDepth: snapshot.maxElemDepth, elemCount: snapshot.elemCount });
                contentText = (snapshot.text || '').trimEnd();
                break;
            }

            const noGFMOpts = this.threadLocal.get('noGfm');
            const imageRetention = this.threadLocal.get('retainImages') as CrawlerOptions['retainImages'];
            let imgIdx = 0;
            const urlToAltMap: { [k: string]: string | undefined; } = _.fromPairs(snapshot.imgs?.map(
                (x) => [(x.src.startsWith('data:') ? this.dataUrlToBlobUrl(x.src, snapshot.rebase) : x.src).trim(), x.alt]
            ));
            let rebase: string | undefined = snapshot.rebase || nominalUrl?.href;
            if (rebase?.startsWith('blob:') || rebase?.startsWith('data:')) {
                rebase = undefined;
            }
            const customRules: { [k: string]: MarkifyRule; } = {
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

                        let src = linkPreferredSrc;
                        if (rebase) {
                            try {
                                src = new URL(linkPreferredSrc, rebase).toString();
                            } catch (_err) {
                                void 0;
                            }
                        }
                        if (!src) {
                            return '';
                        }

                        const keySrc = (linkPreferredSrc.startsWith('data:') ? this.dataUrlToBlobUrl(linkPreferredSrc, snapshot.rebase) : src).trim();
                        const mapped = urlToAltMap[keySrc];
                        const imgSerial = ++imgIdx;
                        const idxArr = imageIdxTrack.has(keySrc) ? imageIdxTrack.get(keySrc)! : [];
                        idxArr.push(imgSerial);
                        imageIdxTrack.set(keySrc, idxArr);

                        if (mapped) {
                            imageSummary[keySrc] = mapped || alt;

                            if (imageRetention === 'alt_p') {
                                return `(Image ${imgSerial}: ${mapped || alt})`;
                            }

                            if (imgDataUrlToObjectUrl) {
                                return `![Image ${imgSerial}: ${mapped || alt}](${keySrc})`;
                            }

                            return `![Image ${imgSerial}: ${mapped || alt}](${src})`;
                        } else if (imageRetention === 'alt_p') {
                            return alt ? `(Image ${imgSerial}: ${alt})` : '';
                        }

                        imageSummary[keySrc] = alt || '';

                        if (imgDataUrlToObjectUrl) {
                            return alt ? `![Image ${imgSerial}: ${alt}](${keySrc})` : `![Image ${imgSerial}](${keySrc})`;
                        }

                        return alt ? `![Image ${imgSerial}: ${alt}](${src})` : `![Image ${imgSerial}](${src})`;
                    }
                } as MarkifyRule,
            };

            const linkRetention = this.threadLocal.get('retainLinks') as CrawlerOptions['retainLinks'];

            if (linkRetention && linkRetention !== 'all') {
                if (linkRetention === 'gpt-oss') {
                    gptOssTransformedLinks = new WeakSet();
                    customRules['link-retention'] = {
                        filter: 'a',
                        replacement: function (content, element) {
                            const rec = this.refMap.get(element);
                            if (!rec) {
                                return content;
                            }
                            if (!('text' in rec && rec.text)) {
                                return '';
                            }
                            if (rec.href.startsWith('mailto:') || rec.href.startsWith('javascript:')) {
                                return rec.text;
                            }
                            const vecs = [`${rec.ref}`, escapeGptOssLinkText(rec.text)];
                            if ('domain' in rec && rec.domain && rec.domain !== baseUrl.hostname) {
                                vecs.push(escapeGptOssLinkText(rec.domain));
                            }
                            gptOssTransformedLinks!.add(rec);

                            return `【${vecs.join('†')}】`;
                        }
                    };
                } else if (linkRetention === 'none') {
                    customRules['link-retention'] = {
                        filter: 'a',
                        replacement: () => ''
                    };
                } else if (linkRetention === 'text') {
                    customRules['link-retention'] = {
                        filter: 'a',
                        replacement: function (content, element, options) {
                            const rec = this.refMap.get(element);
                            if (rec && 'text' in rec) {
                                return rec.text;
                            }

                            return '';
                        }
                    };
                }
            }
            const optsMixin = {
                url: baseUrl.href,
                customRules,
                customKeep: noGFMOpts === 'table' ? 'table' : undefined,
                imgDataUrlToObjectUrl,
                gfm: (noGFMOpts === 'table' || !noGFMOpts) ? true : false
            } as const;


            const jsDomElementOfHTML = documentElement || this.jsdomControl.snippetToElement(snapshot.html, snapshot.href);
            let toBeTurnedToMd = jsDomElementOfHTML;
            markifyService = this.getMarkify({ ...optsMixin });
            if (!mode.includes('markdown') && snapshot.parsed?.content && !snapshot.traits?.includes('blob')) {
                const jsDomElementOfParsed = this.jsdomControl.snippetToElement(snapshot.parsed.content, snapshot.href);
                const par1 = this.jsdomControl.runMarkify(markifyService, jsDomElementOfHTML);
                imgIdx = 0;
                const par2 = snapshot.parsed.content ? this.jsdomControl.runMarkify(markifyService, jsDomElementOfParsed) : '';

                // If Readability did its job
                if (par2.length >= 0.3 * par1.length) {
                    markifyService = this.getMarkify({ vanilla: true, ...optsMixin });
                    imgIdx = 0;
                    if (snapshot.parsed.content) {
                        toBeTurnedToMd = jsDomElementOfParsed;
                    }
                }
            }

            if (toBeTurnedToMd) {
                try {
                    gptOssTransformedLinks = new WeakSet();
                    contentText = this.jsdomControl.runMarkify(markifyService, toBeTurnedToMd).trim();
                    imgIdx = 0;
                } catch (err) {
                    this.logger.warn(`Markify failed to run, giving up`, { err });
                }
            }

            if (
                this.isPoorlyTransformed(contentText, toBeTurnedToMd)
                && toBeTurnedToMd !== jsDomElementOfHTML
            ) {
                toBeTurnedToMd = jsDomElementOfHTML;
                try {
                    gptOssTransformedLinks = new WeakSet();
                    contentText = this.jsdomControl.runMarkify(markifyService, jsDomElementOfHTML).trim();
                    imgIdx = 0;
                } catch (err) {
                    this.logger.warn(`Markify failed to run, giving up`, { err });
                }
            }
            if (mode === 'content' && this.isPoorlyTransformed(contentText, toBeTurnedToMd)) {
                contentText = (snapshot.text || '').trimEnd();
            }
        } while (false);

        if (maxTokens) {
            contentText = tokenTrim(contentText, maxTokens);
        }

        const formatted: FormattedPage = {
            title: (snapshot.parsed?.title || snapshot.title || '').trim(),
            description: (snapshot.description || '').trim(),
            url: nominalUrl?.toString() || snapshot.href?.trim(),
            content: contentText,
            publishedTime: snapshot.parsed?.publishedTime || snapshot.metadata?.['article:published_time'] || snapshot.lastModified,
            metadata: snapshot.metadata,
            external: snapshot.external,
            numPages: (snapshot.traits?.includes('blob') && snapshot.childFrames?.length) ? snapshot.childFrames.length : undefined,
        };

        if (this.threadLocal.get('markdownChunking')) {
            formatted.chunks = this.chunkMarkdownByHeading(
                contentText,
                formatted.title || '',
                this.threadLocal.get('markdownChunking') === 'contextual',
                this.threadLocal.get('markdownChunkingDepth')
            );
        }

        if (snapshot.status) {
            const code = snapshot.status;
            const n = code - 200;
            if (n < 0 || n >= 200) {
                const text = snapshot.statusText || STATUS_CODES[code];
                formatted.warning ??= '';
                const msg = `Target URL returned error ${code}${text ? `: ${text}` : ''}`;
                formatted.warning = `${formatted.warning}${formatted.warning ? '\n' : ''}${msg}`;
            }
        }

        if (this.threadLocal.get('withImagesSummary')) {
            formatted.images =
                _(imageSummary)
                    .toPairs()
                    .map(
                        ([url, alt], i) => {
                            const idxTrack = imageIdxTrack.get(url);
                            const tag = idxTrack?.length ? `Image ${_.uniq(idxTrack).join(',')}` : `Hidden Image ${i + 1}`;

                            return [`${tag}${alt ? `: ${alt}` : ''}`, url];
                        }
                    ).fromPairs()
                    .value();
        }
        if (this.threadLocal.get('withLinksSummary')) {
            const links = inferredSnapshot.links;

            if (this.threadLocal.get('withLinksSummary') === 'all') {
                formatted.links = links;
            } else if (this.threadLocal.get('withLinksSummary') === 'gpt-oss' && markifyService?.links.length) {
                const pairs = markifyService.links.map((rec) => {
                    if (!(gptOssTransformedLinks?.has(rec))) {
                        return null;
                    }

                    return [`${rec.ref}`, rec.href];
                }).filter(Boolean);
                formatted.links = _.fromPairs(pairs as [string, string][]);
            } else {
                formatted.links = _(links).filter(([_label, href]) => !href.startsWith('file:') && !href.startsWith('javascript:')).uniqBy(1).fromPairs().value();
            }
        }

        if (countGPTToken(formatted.content) < 200) {
            formatted.warning ??= '';
            if (snapshot.isIntermediate) {
                const msg = 'This page maybe not yet fully loaded, consider explicitly specify a timeout.';
                formatted.warning = `${formatted.warning}${formatted.warning ? '\n' : ''}${msg}`;
            }
            if (snapshot.childFrames?.length && !this.threadLocal.get('withIframe') && !snapshot.traits?.includes('blob')) {
                const msg = 'This page contains iframe that are currently hidden, consider enabling iframe processing.';
                formatted.warning = `${formatted.warning}${formatted.warning ? '\n' : ''}${msg}`;
            }
            if (snapshot.shadowExpanded && !this.threadLocal.get('withShadowDom')) {
                const msg = 'This page contains shadow DOM that are currently hidden, consider enabling shadow DOM processing.';
                formatted.warning = `${formatted.warning}${formatted.warning ? '\n' : ''}${msg}`;
            }
            if (snapshot.html.includes('captcha') || snapshot.html.includes('cf-turnstile-response')) {
                const msg = 'This page maybe requiring CAPTCHA, please make sure you are authorized to access this page.';
                formatted.warning = `${formatted.warning}${formatted.warning ? '\n' : ''}${msg}`;
            }
            if (snapshot.isFromCache) {
                const msg = 'This is a cached snapshot of the original page, consider retry with caching opt-out.';
                formatted.warning = `${formatted.warning}${formatted.warning ? '\n' : ''}${msg}`;
            }
        }

        Object.assign(f, formatted);

        const final = FormattedPageDto.from(f);

        const dt = Date.now() - t0;
        this.logger.debug(`Formatting took ${dt}ms`, { mode, url: nominalUrl?.toString(), dt });

        return final;
    }

    dataUrlToBlobUrl(dataUrl: string, baseUrl: string = 'http://localhost/') {
        const refUrl = new URL(baseUrl);
        const mappedUrl = new URL(`blob:${refUrl.origin || 'localhost'}/${md5Hasher.hash(dataUrl)}`);

        return mappedUrl.href;
    }

    *iterMarkdownChunks(content: string) {

        let level = 0;
        const chunkStack = [] as ChunkNode[];
        for (const chunk of content.split(mdChunkingRegExp)) {
            const frontTrimmed = chunk.trimStart();
            const firstLine = frontTrimmed.substring(0, frontTrimmed.indexOf('\n')).trimEnd();

            if (!firstLine.startsWith('#')) {
                yield {
                    title: '',
                    level,
                    cleanedTitle: '',
                    content: chunk,
                    contentWithoutTitle: chunk,
                    parents: [...chunkStack],
                };
                continue;
            }

            const cleanedTitle = firstLine.replace(/^#{1,6}\s*/, '');
            const thisLevel = firstLine.match(/^#{1,6}/)![0].length;

            if (thisLevel <= level) {
                while (chunkStack.length && chunkStack[chunkStack.length - 1].level >= thisLevel) {
                    chunkStack.pop();
                }
            }

            const newNode: ChunkNode = {
                title: firstLine,
                cleanedTitle,
                level: thisLevel,
                content: frontTrimmed.trimEnd(),
                contentWithoutTitle: frontTrimmed.substring(firstLine.length).trim(),
                parents: [...chunkStack],
            };
            level = thisLevel;
            chunkStack.push(newNode);

            yield newNode;
        }
    }

    chunkMarkdownByHeading(content: string, title: string, isContextual: boolean = false, maxDepth: number = 4) {
        const chunks = [] as string[];
        const l2Chunks = [] as string[];
        for (const chunk of this.iterMarkdownChunks(content)) {
            if (!chunk.title && chunk.content) {
                l2Chunks.push(chunk.content);
                continue;
            }

            if (chunk.level > maxDepth) {
                l2Chunks.push(chunk.content);
                continue;
            }

            if (l2Chunks.length) {
                chunks.push(l2Chunks.filter(Boolean).join('\n\n').trim());
                l2Chunks.length = 0;
            }

            if (isContextual) {
                l2Chunks.push(`${_.uniq([`# ${title}`, ...chunk.parents.map((p) => p.title), chunk.title]).filter(Boolean).join('\n')}\n\n${chunk.contentWithoutTitle.trim()}`);
            } else {
                l2Chunks.push(`${chunk.content.trim()}`);
            }
        }

        if (l2Chunks.length) {
            chunks.push(l2Chunks.filter(Boolean).join('\n').trim());
            l2Chunks.length = 0;
        }

        return chunks.filter(Boolean);
    }

    async generalSnapshotRoutine(snapshot: PageSnapshot) {
        const inferred = snapshot.html ?
            await this.jsdomControl.inferSnapshot(snapshot) :
            {
                snapshot: snapshot as ExtendedSnapshot,
                documentElement: undefined,
            };
        const mixin: any = {};
        if (this.threadLocal.get('withImagesSummary') && inferred.snapshot?.imgs) {
            const imageSummary = {} as { [k: string]: string; };
            const imageIdxTrack = new Map<string, number[]>();

            let imgIdx = 0;

            for (const img of inferred.snapshot.imgs) {
                const imgSerial = ++imgIdx;
                const keySrc = (img.src.startsWith('data:') ? this.dataUrlToBlobUrl(img.src, snapshot.rebase) : img.src).trim();
                const idxArr = imageIdxTrack.has(keySrc) ? imageIdxTrack.get(keySrc)! : [];
                idxArr.push(imgSerial);
                imageIdxTrack.set(keySrc, idxArr);
                imageSummary[keySrc] = img.alt || '';
            }

            mixin.images =
                _(imageSummary)
                    .toPairs()
                    .map(
                        ([url, alt], i) => {
                            const idxTrack = imageIdxTrack.get(url);
                            const tag = idxTrack?.length ? `Image ${_.uniq(idxTrack).join(',')}` : `Hidden Image ${i + 1}`;

                            return [`${tag}${alt ? `: ${alt}` : ''}`, url];
                        }
                    ).fromPairs()
                    .value();
        }
        if (this.threadLocal.get('withLinksSummary') && inferred.snapshot?.links) {
            if (this.threadLocal.get('withLinksSummary') === 'all') {
                mixin.links = inferred.snapshot.links;
            } else {
                mixin.links = _(inferred.snapshot.links).filter(([_label, href]) => !href.startsWith('file:') && !href.startsWith('javascript:')).uniqBy(1).fromPairs().value();
            }
        }
        if (snapshot.status) {
            const code = snapshot.status;
            const n = code - 200;
            if (n < 0 || n >= 200) {
                const text = snapshot.statusText || STATUS_CODES[code];
                mixin.warning ??= '';
                const msg = `Target URL returned error ${code}${text ? `: ${text}` : ''}`;
                mixin.warning = `${mixin.warning}${mixin.warning ? '\n' : ''}${msg}`;
            }
        }

        return { ...inferred, mixin };
    }

    getMarkify(options?: {
        vanilla?: boolean | string,
        url?: string | URL;
        imgDataUrlToObjectUrl?: boolean;
        removeImages?: boolean | 'src';
        customRules?: { [k: string]: MarkifyRule; };
        customKeep?: string;
        gfm?: boolean;
    }) {
        const turndownOpts = this.threadLocal.get('turndownOpts');
        const markifyService = new MarkifyService({
            ...turndownOpts,
            baseUrl: options?.url,
            gfm: options?.gfm,
            codeBlockStyle: 'fenced',
            preformattedCode: true,
        } as any);

        // keep does not work for now
        if (options?.customKeep) {
            markifyService.keep(options.customKeep);
        }

        if (!options?.vanilla) {
            markifyService.addRule('remove-irrelevant', {
                filter: ['meta', 'style', 'script', 'noscript', 'link', 'textarea', 'select'],
                replacement: () => {
                    return '';
                }
            });
            markifyService.addRule('truncate-svg', {
                filter: 'svg' as any,
                replacement: () => ''
            });
            markifyService.addRule('title-as-h1', {
                filter: ['title'],
                replacement:
                    turndownOpts?.headingStyle === 'setext' ?
                        (innerText: string) => innerText ? `${innerText.trim()}\n===============\n` : '' :
                        (innerText: string) => innerText ? `# ${innerText.trim()}\n` : ''
            });
        }

        if (options?.imgDataUrlToObjectUrl) {
            markifyService.addRule('data-url-to-pseudo-object-url', {
                filter: 'img',
                replacement: (_content: string, node: Element) => {
                    const src = (node.getAttribute('src') || '').trim();
                    if (!src.startsWith('data:')) {
                        return _content;
                    }

                    const alt = cleanAttribute(node.getAttribute('alt')) || '';
                    const blobUrl = this.dataUrlToBlobUrl(src, options.url?.toString());

                    return `![${alt}](${blobUrl})`;
                }
            });
        }

        if (options?.customRules) {
            for (const [k, v] of Object.entries(options.customRules)) {
                markifyService.addRule(k, v);
            }
        }

        return markifyService;
    }


    isPoorlyTransformed(content?: string, node?: Element) {
        if (!content) {
            return true;
        }

        if (!content.includes('\n')) {
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

}

const gptOssEscapes = {
    "【": "〖",
    "】": "〗",
    "◼": "◾",
    "\u200b": "",
    '†': '‡',
};
const gptOssEscRegexp = new RegExp(Object.keys(gptOssEscapes).join('|'), 'g');
function escapeGptOssLinkText(text: string) {
    return text.replace(gptOssEscRegexp, (match) => gptOssEscapes[match as keyof typeof gptOssEscapes]);
}

const snapshotFormatter = container.resolve(SnapshotFormatter);

export default snapshotFormatter;
