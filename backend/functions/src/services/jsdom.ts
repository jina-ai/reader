import { container, singleton } from 'tsyringe';
import { AsyncService, marshalErrorLike } from 'civkit';
import { Logger } from '../shared/services/logger';
import { ExtendedSnapshot, PageSnapshot } from './puppeteer';
import { Readability } from '@mozilla/readability';
import TurndownService from 'turndown';
import { Threaded } from '../shared/services/threaded';
import type { ExtraScrappingOptions } from '../cloud-functions/crawler';

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

        return this.actualNarrowSnapshot(snapshot, options);
    }

    @Threaded()
    async actualNarrowSnapshot(snapshot: PageSnapshot, options?: ExtraScrappingOptions): Promise<PageSnapshot | undefined> {
        const t0 = Date.now();
        let sourceHTML = snapshot.html;
        if (options?.withShadowDom && snapshot.shadowExpanded) {
            sourceHTML = snapshot.shadowExpanded;
        }
        const jsdom = this.linkedom.parseHTML(sourceHTML);
        const allNodes: Node[] = [];
        jsdom.window.document.querySelectorAll('svg').forEach((x) => x.innerHTML = '');
        if (options?.withIframe) {
            jsdom.window.document.querySelectorAll('iframe[src],frame[src]').forEach((x) => {
                const src = x.getAttribute('src');
                const thisSnapshot = snapshot.childFrames?.find((f) => f.href === src);
                if (thisSnapshot?.html) {
                    x.innerHTML = thisSnapshot.html;
                    x.querySelectorAll('script, style').forEach((s) => s.remove());
                    x.querySelectorAll('[src]').forEach((el) => {
                        el.setAttribute('src', new URL(el.getAttribute('src')!, src!).toString());
                    });
                    x.querySelectorAll('[href]').forEach((el) => {
                        el.setAttribute('href', new URL(el.getAttribute('href')!, src!).toString());
                    });
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
        if (allNodes.length === 1 && allNodes[0].nodeName === '#document') {
            rootDoc = allNodes[0] as any;
            if (rootDoc.body.innerText) {
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

        const imageTags = Array.from(rootDoc.querySelectorAll('img[src],img[data-src]'))
            .map((x: any) => [x.getAttribute('src'), x.getAttribute('data-src')])
            .flat()
            .map((x) => {
                try {
                    return new URL(x, snapshot.rebase || snapshot.href).toString();
                } catch (err) {
                    return null;
                }
            })
            .filter(Boolean);

        const imageSet = new Set(imageTags);
        const r = {
            ...snapshot,
            title: snapshot.title || jsdom.window.document.title,
            description: snapshot.description ||
                (jsdom.window.document.head?.querySelector('meta[name="description"]')?.getAttribute('content') ?? ''),
            parsed,
            html: rootDoc.documentElement.outerHTML,
            text: textChunks.join('\n'),
            imgs: snapshot.imgs?.filter((x) => imageSet.has(x.src)) || [],
        } as PageSnapshot;

        const dt = Date.now() - t0;
        if (dt > 1000) {
            this.logger.warn(`Performance issue: Narrowing snapshot took ${dt}ms`, { url: snapshot.href, dt });
        }

        return r;
    }

    @Threaded()
    inferSnapshot(snapshot: PageSnapshot): ExtendedSnapshot {
        const t0 = Date.now();
        const extendedSnapshot = { ...snapshot } as ExtendedSnapshot;
        try {
            const jsdom = this.linkedom.parseHTML(snapshot.html);

            jsdom.window.document.querySelectorAll('svg').forEach((x) => x.innerHTML = '');
            const links = Array.from(jsdom.window.document.querySelectorAll('a[href]'))
                .map((x: any) => [x.getAttribute('href'), x.textContent.replace(/\s+/g, ' ').trim()])
                .map(([href, text]) => {
                    if (!text) {
                        return undefined;
                    }
                    try {
                        const parsed = new URL(href, snapshot.rebase || snapshot.href);
                        if (parsed.protocol === 'file:' || parsed.protocol === 'javascript:') {
                            return undefined;
                        }
                        return [parsed.toString(), text] as const;
                    } catch (err) {
                        return undefined;
                    }
                })
                .filter(Boolean)
                .reduce((acc, pair) => {
                    acc[pair![0]] = pair![1];
                    return acc;
                }, {} as { [k: string]: string; });

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
}

const jsdomControl = container.resolve(JSDomControl);

export default jsdomControl;
