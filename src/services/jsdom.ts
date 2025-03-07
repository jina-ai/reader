import { container, singleton } from 'tsyringe';
import { AsyncService, marshalErrorLike } from 'civkit';
import { Logger } from '../shared/services/logger';
import { ExtendedSnapshot, ImgBrief, PageSnapshot } from './puppeteer';
import { Readability } from '@mozilla/readability';
import TurndownService from 'turndown';
import { Threaded } from '../services/threaded';
import type { ExtraScrappingOptions } from '../api/crawler';
import { tailwindClasses } from '../utils/tailwind-classes';
import { countGPTToken } from '../shared';

const pLinkedom = import('linkedom');

@singleton()
export class JSDomControl extends AsyncService {

    logger = this.globalLogger.child({ service: this.constructor.name });

    linkedom!: Awaited<typeof pLinkedom>;

    constructor(
        protected globalLogger: Logger,
    ) {
        super(...arguments);
    }

    override async init() {
        await this.dependencyReady();
        this.linkedom = await pLinkedom;
        this.emit('ready');
    }

    async narrowSnapshot(snapshot: PageSnapshot | undefined, options?: ExtraScrappingOptions) {
        if (snapshot?.parsed && !options?.targetSelector && !options?.removeSelector && !options?.withIframe && !options?.withShadowDom) {
            return snapshot;
        }
        if (!snapshot?.html) {
            return snapshot;
        }

        // SideLoad contains native objects that cannot go through thread boundaries.
        return this.actualNarrowSnapshot(snapshot, { ...options, sideLoad: undefined });
    }

    @Threaded()
    async actualNarrowSnapshot(snapshot: PageSnapshot, options?: ExtraScrappingOptions): Promise<PageSnapshot | undefined> {
        const t0 = Date.now();
        let sourceHTML = snapshot.html;
        if (options?.withShadowDom && snapshot.shadowExpanded) {
            sourceHTML = snapshot.shadowExpanded;
        }
        let jsdom = this.linkedom.parseHTML(sourceHTML);
        if (!jsdom.window.document.documentElement) {
            jsdom = this.linkedom.parseHTML(`<html><body>${sourceHTML}</body></html>`);
        }
        const allNodes: Node[] = [];
        jsdom.window.document.querySelectorAll('svg').forEach((x) => x.innerHTML = '');
        if (options?.withIframe) {
            jsdom.window.document.querySelectorAll('iframe[src],frame[src]').forEach((x) => {
                const src = x.getAttribute('src');
                const thisSnapshot = snapshot.childFrames?.find((f) => f.href === src);
                if (options?.withIframe === 'quoted') {
                    const blockquoteElem = jsdom.window.document.createElement('blockquote');
                    const preElem = jsdom.window.document.createElement('pre');
                    preElem.innerHTML = thisSnapshot?.text || '';
                    blockquoteElem.appendChild(preElem);
                    x.replaceWith(blockquoteElem);
                } else if (thisSnapshot?.html) {
                    x.innerHTML = thisSnapshot.html;
                    x.querySelectorAll('script, style').forEach((s) => s.remove());
                    if (src) {
                        x.querySelectorAll('[src]').forEach((el) => {
                            const imgSrc = el.getAttribute('src')!;
                            if (URL.canParse(imgSrc, src!)) {
                                el.setAttribute('src', new URL(imgSrc, src!).toString());
                            }
                        });
                        x.querySelectorAll('[href]').forEach((el) => {
                            const linkHref = el.getAttribute('href')!;
                            if (URL.canParse(linkHref, src!)) {
                                el.setAttribute('href', new URL(linkHref, src!).toString());
                            }
                        });
                    }
                }
            });
        }

        if (Array.isArray(options?.removeSelector)) {
            for (const rl of options!.removeSelector) {
                jsdom.window.document.querySelectorAll(rl).forEach((x) => x.remove());
            }
        } else if (options?.removeSelector) {
            jsdom.window.document.querySelectorAll(options.removeSelector).forEach((x) => x.remove());
        }

        let bewareTargetContentDoesNotExist = false;
        if (Array.isArray(options?.targetSelector)) {
            bewareTargetContentDoesNotExist = true;
            for (const x of options!.targetSelector.map((x) => jsdom.window.document.querySelectorAll(x))) {
                x.forEach((el) => {
                    if (!allNodes.includes(el)) {
                        allNodes.push(el);
                    }
                });
            }
        } else if (options?.targetSelector) {
            bewareTargetContentDoesNotExist = true;
            jsdom.window.document.querySelectorAll(options.targetSelector).forEach((el) => {
                if (!allNodes.includes(el)) {
                    allNodes.push(el);
                }
            });
        } else {
            allNodes.push(jsdom.window.document);
        }

        if (!allNodes.length) {

            if (bewareTargetContentDoesNotExist) {
                return undefined;
            }

            return snapshot;
        }
        const textNodes: HTMLElement[] = [];
        let rootDoc: Document;
        if (allNodes.length === 1 && allNodes[0].nodeName === '#document' && (allNodes[0] as any).documentElement) {
            rootDoc = allNodes[0] as any;
            if (rootDoc.body?.innerText) {
                textNodes.push(rootDoc.body);
            }
        } else {
            rootDoc = this.linkedom.parseHTML('<html><body></body></html>').window.document;
            for (const n of allNodes) {
                rootDoc.body.appendChild(n);
                rootDoc.body.appendChild(rootDoc.createTextNode('\n\n'));
                if ((n as HTMLElement).innerText) {
                    textNodes.push(n as HTMLElement);
                }
            }
        }
        const textChunks = textNodes.map((x) => {
            const clone = x.cloneNode(true) as HTMLElement;
            clone.querySelectorAll('script,style,link,svg').forEach((s) => s.remove());

            return clone.innerText;
        });

        let parsed;
        try {
            parsed = new Readability(rootDoc.cloneNode(true) as any).parse();
        } catch (err: any) {
            this.logger.warn(`Failed to parse selected element`, { err: marshalErrorLike(err) });
        }

        const imgSet = new Set<string>();
        const rebuiltImgs: ImgBrief[] = [];
        Array.from(rootDoc.querySelectorAll('img[src],img[data-src]'))
            .map((x: any) => [x.getAttribute('src'), x.getAttribute('data-src'), x.getAttribute('alt')])
            .forEach(([u1, u2, alt]) => {
                if (u1) {
                    try {
                        const u1Txt = new URL(u1, snapshot.rebase || snapshot.href).toString();
                        imgSet.add(u1Txt);
                    } catch (err) {
                        // void 0;
                    }
                }
                if (u2) {
                    try {
                        const u2Txt = new URL(u2, snapshot.rebase || snapshot.href).toString();
                        imgSet.add(u2Txt);
                    } catch (err) {
                        // void 0;
                    }
                }
                rebuiltImgs.push({
                    src: u1 || u2,
                    alt
                });
            });

        const r = {
            ...snapshot,
            title: snapshot.title || jsdom.window.document.title,
            description: snapshot.description ||
                (jsdom.window.document.head?.querySelector('meta[name="description"]')?.getAttribute('content') ?? ''),
            parsed,
            html: rootDoc.documentElement.outerHTML,
            text: textChunks.join('\n'),
            imgs: (snapshot.imgs || rebuiltImgs)?.filter((x) => imgSet.has(x.src)) || [],
        } as PageSnapshot;

        const dt = Date.now() - t0;
        if (dt > 1000) {
            this.logger.warn(`Performance issue: Narrowing snapshot took ${dt}ms`, { url: snapshot.href, dt });
        }

        return r;
    }

    @Threaded()
    async inferSnapshot(snapshot: PageSnapshot) {
        const t0 = Date.now();
        const extendedSnapshot = { ...snapshot } as ExtendedSnapshot;
        try {
            const jsdom = this.linkedom.parseHTML(snapshot.html);

            jsdom.window.document.querySelectorAll('svg').forEach((x) => x.innerHTML = '');
            const links = Array.from(jsdom.window.document.querySelectorAll('a[href]'))
                .map((x: any) => [x.textContent.replace(/\s+/g, ' ').trim(), x.getAttribute('href'),])
                .map(([text, href]) => {
                    if (!href) {
                        return undefined;
                    }
                    try {
                        const parsed = new URL(href, snapshot.rebase || snapshot.href);

                        return [text, parsed.toString()] as const;
                    } catch (err) {
                        return undefined;
                    }
                })
                .filter(Boolean) as [string, string][];

            extendedSnapshot.links = links;

            const imgs = Array.from(jsdom.window.document.querySelectorAll('img[src],img[data-src]'))
                .map((x: any) => {
                    let linkPreferredSrc = x.getAttribute('src') || '';
                    if (linkPreferredSrc.startsWith('data:')) {
                        const dataSrc = x.getAttribute('data-src') || '';
                        if (dataSrc && !dataSrc.startsWith('data:')) {
                            linkPreferredSrc = dataSrc;
                        }
                    }

                    return {
                        src: new URL(linkPreferredSrc, snapshot.rebase || snapshot.href).toString(),
                        width: parseInt(x.getAttribute('width') || '0'),
                        height: parseInt(x.getAttribute('height') || '0'),
                        alt: x.getAttribute('alt') || x.getAttribute('title'),
                    };
                });

            extendedSnapshot.imgs = imgs as any;
        } catch (_err) {
            void 0;
        }

        const dt = Date.now() - t0;
        if (dt > 1000) {
            this.logger.warn(`Performance issue: Inferring snapshot took ${dt}ms`, { url: snapshot.href, dt });
        }

        return extendedSnapshot;
    }

    cleanRedundantEmptyLines(text: string) {
        const lines = text.split(/\r?\n/g);
        const mappedFlag = lines.map((line) => Boolean(line.trim()));

        return lines.filter((_line, i) => mappedFlag[i] || mappedFlag[i - 1]).join('\n');
    }

    @Threaded()
    async cleanHTMLforLMs(sourceHTML: string, ...discardSelectors: string[]): Promise<string> {
        const t0 = Date.now();
        let jsdom = this.linkedom.parseHTML(sourceHTML);
        if (!jsdom.window.document.documentElement) {
            jsdom = this.linkedom.parseHTML(`<html><body>${sourceHTML}</body></html>`);
        }

        for (const rl of discardSelectors) {
            jsdom.window.document.querySelectorAll(rl).forEach((x) => x.remove());
        }

        jsdom.window.document.querySelectorAll('img[src],img[data-src]').forEach((x) => {
            const src = x.getAttribute('src') || x.getAttribute('data-src');
            if (src?.startsWith('data:')) {
                x.setAttribute('src', 'blob:opaque');
            }
            x.removeAttribute('data-src');
            x.removeAttribute('srcset');
        });

        jsdom.window.document.querySelectorAll('[class]').forEach((x) => {
            const classes = x.getAttribute('class')?.split(/\s+/g) || [];
            const newClasses = classes.filter((c) => tailwindClasses.has(c));
            x.setAttribute('class', newClasses.join(' '));
        });
        jsdom.window.document.querySelectorAll('[style]').forEach((x) => {
            const style = x.getAttribute('style')?.toLocaleLowerCase() || '';
            if (style.startsWith('display: none')) {
                return;
            }
            x.removeAttribute('style');
        });
        const treeWalker = jsdom.window.document.createTreeWalker(
            jsdom.window.document, // Start from the root document
            0x80 // Only show comment nodes
        );

        let currentNode;
        while ((currentNode = treeWalker.nextNode())) {
            currentNode.parentNode?.removeChild(currentNode); // Remove each comment node
        }

        jsdom.window.document.querySelectorAll('*').forEach((x) => {
            const attrs = x.getAttributeNames();
            for (const attr of attrs) {
                if (attr.startsWith('data-') || attr.startsWith('aria-')) {
                    x.removeAttribute(attr);
                }
            }
        });

        const dt = Date.now() - t0;
        if (dt > 1000) {
            this.logger.warn(`Performance issue: Cleaning HTML for LMs took ${dt}ms`, { dt });
        }

        return this.cleanRedundantEmptyLines(jsdom.window.document.documentElement.outerHTML);
    }

    snippetToElement(snippet?: string, url?: string) {
        const parsed = this.linkedom.parseHTML(snippet || '<html><body></body></html>');

        // Hack for turndown gfm table plugin.
        parsed.window.document.querySelectorAll('table').forEach((x) => {
            Object.defineProperty(x, 'rows', { value: Array.from(x.querySelectorAll('tr')), enumerable: true });
        });
        Object.defineProperty(parsed.window.document.documentElement, 'cloneNode', {
            value: function () { return this; },
        });

        return parsed.window.document.documentElement;
    }

    runTurndown(turndownService: TurndownService, html: TurndownService.Node | string) {
        const t0 = Date.now();

        try {
            return turndownService.turndown(html);
        } finally {
            const dt = Date.now() - t0;
            if (dt > 1000) {
                this.logger.warn(`Performance issue: Turndown took ${dt}ms`, { dt });
            }
        }
    }

    @Threaded()
    async analyzeHTMLTextLite(sourceHTML: string) {
        let jsdom = this.linkedom.parseHTML(sourceHTML);
        if (!jsdom.window.document.documentElement) {
            jsdom = this.linkedom.parseHTML(`<html><body>${sourceHTML}</body></html>`);
        }
        jsdom.window.document.querySelectorAll('script,style,link,svg').forEach((s) => s.remove());
        const text = jsdom.window.document.body.innerText || '';

        return {
            title: jsdom.window.document.title,
            text,
            tokens: countGPTToken(text.replaceAll(/[\s\r\n\t]+/g, ' ')),
        };
    }
}

const jsdomControl = container.resolve(JSDomControl);

export default jsdomControl;
