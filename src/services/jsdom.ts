/// <reference lib="dom" />
import { container, singleton } from 'tsyringe';
import { GlobalLogger } from './logger';
import { ExtendedSnapshot, ImgBrief, PageSnapshot } from './puppeteer';
import { Readability } from '@mozilla/readability';
import { Threaded } from '../services/threaded';
import type { ExtraScrappingOptions } from '../api/crawler';
import { tailwindClasses } from '../utils/tailwind-classes';
import { countGPTToken } from '../utils/openai';
import { AsyncService } from 'civkit/async-service';
import { ApplicationError, AssertionFailureError } from 'civkit/civ-rpc';
import { MarkifyService } from './markify';

const pLinkedom = import('linkedom');

@singleton()
export class JSDomControl extends AsyncService {

    logger = this.globalLogger.child({ service: this.constructor.name });

    linkedom!: Awaited<typeof pLinkedom>;

    constructor(
        protected globalLogger: GlobalLogger,
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

        try {
            // SideLoad contains native objects that cannot go through thread boundaries.
            return await this.actualNarrowSnapshot(snapshot, { ...options, sideLoad: undefined });
        } catch (err: any) {
            this.logger.warn(`Error narrowing snapshot`, { err });
            if (err instanceof ApplicationError) {
                throw err;
            }

            throw new AssertionFailureError(`Failed to process the page: ${err?.message}`);
        }
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
                const origSrc = x.getAttribute('src');
                if (!origSrc) {
                    return;
                }
                const src = new URL(origSrc, snapshot.rebase || snapshot.href).toString();
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
        let bewareHeadHtmlUnexpectedlyPreserved = false;
        if (allNodes.length === 1 && allNodes[0].nodeName === '#document' && (allNodes[0] as any).documentElement) {
            rootDoc = allNodes[0] as any;
            if (rootDoc.body?.innerText) {
                textNodes.push(rootDoc.body);
            }
        } else {
            rootDoc = this.linkedom.parseHTML('<html><body></body></html>').window.document;
            rootDoc.head.innerHTML = jsdom.window.document.head?.innerHTML || '';
            bewareHeadHtmlUnexpectedlyPreserved = true;
            for (const n of allNodes) {
                rootDoc.body.appendChild(n);
                rootDoc.body.appendChild(rootDoc.createTextNode('\n\n'));
                if ((n as HTMLElement).innerText) {
                    textNodes.push(n as HTMLElement);
                }
            }
        }
        const metadata: Record<string, any> = {};
        const lang = rootDoc.documentElement.getAttribute('lang');
        if (lang) {
            metadata.lang = lang;
        }
        rootDoc.head?.querySelectorAll('meta[content]').forEach((el) => {
            const name = el.getAttribute('name') || el.getAttribute('property');
            if (!name) {
                return;
            }
            const val = el.getAttribute('content') || '';
            const curVal = Reflect.get(metadata, name);
            if (Array.isArray(curVal)) {
                curVal.push(val);
            } else if (curVal) {
                Reflect.set(metadata, name, [curVal, val]);
            } else {
                Reflect.set(metadata, name, val);
            }
        });

        const baseURI = snapshot.rebase || snapshot.href;
        const external = {} as { [rel: string]: { [href: string]: { [k: string]: string; }; }; };
        rootDoc.head?.querySelectorAll('link[rel][href]').forEach((el) => {
            const attributes: Record<string, string> = {};
            el.getAttributeNames().forEach((attrName) => {
                attributes[attrName] = el.getAttribute(attrName) || '';
            });
            const rels = attributes['rel']?.split(/\s+/g).filter(Boolean) || [];
            if (!rels?.length) {
                return;
            }
            let href = attributes['href'] || '';
            if (href) {
                try {
                    href = new URL(href, baseURI).href;
                } catch (err) {
                    // void 0;
                }

            }
            delete attributes.rel;
            delete attributes.href;

            for (const rel of rels) {
                external[rel] ??= {};
                external[rel][href] ??= {};
                Object.assign(external[rel][href], attributes);
            }
        });
        delete external['stylesheet'];
        delete external['shortcut'];

        const textChunks = textNodes.map((x) => {
            const clone = x.cloneNode(true) as HTMLElement;
            clone.querySelectorAll('script,style,link,svg').forEach((s) => s.remove());

            return clone.innerText;
        });

        let parsed: any = snapshot.parsed;
        if (options?.readabilityRequired && (!parsed || options?.targetSelector)) {
            try {
                parsed = new Readability(rootDoc.cloneNode(true) as any).parse();
            } catch (err: any) {
                this.logger.warn(`Failed to parse selected element`, { err });
            }
        }

        const imgSet = new Set<string>();
        const rebuiltImgs: ImgBrief[] = [];
        Array.from(rootDoc.querySelectorAll('img[src],img[data-src]'))
            .map((x: any) => [x.getAttribute('src'), x.getAttribute('data-src'), x.getAttribute('alt')])
            .forEach(([u1, u2, alt]) => {
                let absUrl: string | undefined;
                if (u1) {
                    try {
                        const u1Txt = new URL(u1, snapshot.rebase || snapshot.href).toString();
                        imgSet.add(u1Txt);
                        absUrl = u1Txt;
                    } catch (err) {
                        // void 0;
                    }
                }
                if (u2) {
                    try {
                        const u2Txt = new URL(u2, snapshot.rebase || snapshot.href).toString();
                        imgSet.add(u2Txt);
                        absUrl = u2Txt;
                    } catch (err) {
                        // void 0;
                    }
                }
                if (absUrl) {
                    rebuiltImgs.push({
                        src: absUrl,
                        alt
                    });
                }
            });

        const r = {
            ...snapshot,
            title: snapshot.title || jsdom.window.document.title,
            description: snapshot.description ||
                (jsdom.window.document.head?.querySelector('meta[name$="description"][content],meta[property$="description"][content]')?.getAttribute('content') ?? ''),
            parsed,
            html: rootDoc.documentElement.outerHTML,
            text: textChunks.join('\n'),
            imgs: (snapshot.imgs || rebuiltImgs)?.filter((x) => imgSet.has(x.src)) || [],
            metadata,
            external,
        } as PageSnapshot;
        if (bewareHeadHtmlUnexpectedlyPreserved) {
            rootDoc.head!.innerHTML = '';
            r.html = rootDoc.documentElement.outerHTML;
        }

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
        let documentElement;
        try {
            documentElement = this.snippetToElement(snapshot.html, snapshot.href);
            const dt = Date.now() - t0;
            this.logger.debug(`Parsing of jsdom took ${dt}ms`, { url: snapshot.href, dt });

            documentElement.querySelectorAll('svg').forEach((x) => x.innerHTML = '');
            const links = Array.from(documentElement.querySelectorAll('a[href]'))
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

            const imgs = Array.from(documentElement.querySelectorAll('img[src],img[data-src]'))
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
        } else {
            this.logger.debug(`Inferring snapshot took ${dt}ms`, { url: snapshot.href, dt });
        }

        return { documentElement, snapshot: extendedSnapshot } as const;
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
            const newClasses = classes.filter((c) => !tailwindClasses.has(c));
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

        const final = this.cleanRedundantEmptyLines(jsdom.window.document.documentElement.outerHTML);

        const dt = Date.now() - t0;
        if (dt > 1000) {
            this.logger.warn(`Performance issue: Cleaning HTML for LMs took ${dt}ms`, { dt });
        }

        return final;
    }

    snippetToElement(snippet?: string, url?: string) {
        let parsed = this.linkedom.parseHTML(snippet || '<html><body></body></html>');
        if (!parsed.window.document.documentElement) {
            parsed = this.linkedom.parseHTML(`<html><body>${snippet || ''}</body></html>`);
        }

        // Hack for turndown gfm table plugin.
        parsed.window.document.querySelectorAll('table').forEach((x) => {
            Object.defineProperty(x, 'rows', { value: Array.from(x.querySelectorAll('tr')), enumerable: true });
        });
        Object.defineProperty(parsed.window.document.documentElement, 'cloneNode', {
            value: function () { return this; },
        });

        if (url?.startsWith('https://jina.ai/reader')) {
            const signature = parsed.window.document.createElement('p');
            signature.textContent = 'Welcome home!';
            parsed.window.document.body.insertBefore(signature, parsed.window.document.body.firstChild);
        }

        return parsed.window.document.documentElement;
    }

    runMarkify(markifyService: MarkifyService, html: HTMLElement) {
        const t0 = Date.now();

        try {
            return markifyService.markify(html);
        } finally {
            const dt = Date.now() - t0;
            if (dt > 1000) {
                this.logger.warn(`Performance issue: Markify took ${dt}ms`, { dt });
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

    @Threaded()
    async xmlTextToSnapshot(sourceXML: string, url: URL) {
        const xmlDom = new this.linkedom.DOMParser().parseFromString(sourceXML, 'text/xml');

        const rootTagName = xmlDom.documentElement.nodeName.toLowerCase();

        if (rootTagName === 'rss') {
            const channel: Element = xmlDom.querySelector('rss channel');
            if (channel) {
                const snapshot = {
                    title: channel.querySelector('title')?.textContent || '',
                    href: url.href,
                    description: channel.querySelector('description')?.textContent || '',
                    text: channel.textContent || '',
                    html: sourceXML,
                    traits: ['blob'],
                    metadata: {
                    } as any,
                };

                const links = [] as { title?: string; href: string; description?: string; date?: string; }[];

                for (const elem of channel.children) {
                    if (elem.tagName.toLowerCase() !== 'item') {
                        snapshot.metadata[elem.tagName.toLowerCase()] = elem.textContent || '';
                        continue;
                    }

                    links.push({
                        title: elem.querySelector('title')?.textContent || undefined,
                        href: elem.querySelector('link')?.textContent || '',
                        description: elem.querySelector('description')?.textContent || undefined,
                        date: elem.querySelector('pubDate')?.textContent || undefined,
                    });
                }

                const altHtml = `<html><head><title>${snapshot.title}</title><meta name="description" content="${snapshot.description}"></head><body>${links.map((l) => `<div><h3><a href="${l.href}">${l.title || ''}</a></h3><p>${l.description || ''}</p><a href="${l.href || ''}">${l.href || ''}</a><br /><time>${l.date || ''}</time></div>`).join('\n')}</body></html>`;

                snapshot.html = altHtml;

                return snapshot;
            }
        } else if (rootTagName === 'feed') {
            const feed = xmlDom.querySelector('feed');
            if (feed) {
                const snapshot = {
                    title: xmlDom.querySelector('feed > title')?.textContent || '',
                    href: url.href,
                    description: xmlDom.querySelector('feed > subtitle')?.textContent || '',
                    text: xmlDom.documentElement.textContent || '',
                    html: sourceXML,
                    traits: ['blob'],
                    metadata: {
                    } as any,
                };

                const links = [] as { title?: string; href: string; description?: string; date?: string; }[];

                for (const elem of feed.children) {
                    if (elem.tagName.toLowerCase() !== 'link') {
                        snapshot.metadata[elem.tagName.toLowerCase()] = elem.textContent || '';
                        continue;
                    }

                    links.push({
                        title: elem.querySelector('title')?.textContent || undefined,
                        href: elem.querySelector('link')?.getAttribute('href') || '',
                        description: elem.querySelector('summary')?.textContent || undefined,
                        date: elem.querySelector('updated')?.textContent || undefined,
                    });
                }

                const altHtml = `<html><head><title>${snapshot.title}</title><meta name="description" content="${snapshot.description}"></head><body>${links.map((l) => `<div><h3><a href="${l.href}">${l.title || ''}</a></h3><p>${l.description || ''}</p><a href="${l.href || ''}">${l.href || ''}</a><br /><time>${l.date || ''}</time></div>`).join('\n')}</body></html>`;

                snapshot.html = altHtml;

                return snapshot;
            }
        } else if (rootTagName === 'sitemapindex') {
            const snapshot = {
                title: 'Sitemap Index',
                href: url.href,
                description: '',
                text: xmlDom.documentElement.textContent || '',
                html: sourceXML,
                traits: ['blob'],
                metadata: {
                } as any,
            };

            const links = [] as { href: string; lastmod?: string; }[];

            for (const sitemap of xmlDom.querySelectorAll('sitemapindex sitemap')) {
                links.push({
                    href: sitemap.querySelector('loc')?.textContent || '',
                    lastmod: sitemap.querySelector('lastmod')?.textContent || undefined,
                });
            }

            const altHtml = `<html><head><title>${snapshot.title}</title><meta name="description" content="${snapshot.description}"></head><body>${links.map((l) => `<div><a href="${l.href}">${l.href}</a><br /><time>${l.lastmod || ''}</time></div>`).join('\n')}</body></html>`;

            snapshot.html = altHtml;

            return snapshot;
        } else if (rootTagName === 'urlset') {
            const snapshot = {
                title: 'Sitemap',
                href: url.href,
                description: '',
                text: xmlDom.documentElement.textContent || '',
                html: sourceXML,
                traits: ['blob'],
                metadata: {
                } as any,
            };

            const links = [] as { href: string; lastmod?: string; }[];

            for (const urlElem of xmlDom.querySelectorAll('urlset url')) {
                links.push({
                    href: urlElem.querySelector('loc')?.textContent || '',
                    lastmod: urlElem.querySelector('lastmod')?.textContent || undefined,
                });
            }

            const altHtml = `<html><head><title>${snapshot.title}</title><meta name="description" content="${snapshot.description}"></head><body>${links.map((l) => `<div><a href="${l.href}">${l.href}</a><br /><time>${l.lastmod || ''}</time></div>`).join('\n')}</body></html>`;

            snapshot.html = altHtml;

            return snapshot;
        }

        return {
            title: xmlDom.documentElement.tagName,
            description: '',
            text: xmlDom.documentElement.textContent || sourceXML,
            html: sourceXML,
        };
    }
}

const jsdomControl = container.resolve(JSDomControl);

export default jsdomControl;
