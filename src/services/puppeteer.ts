import _ from 'lodash';
import { isIP } from 'net';
import { readFile } from 'fs/promises';
import fs from 'fs';
import { container, singleton } from 'tsyringe';

import type { Browser, CookieParam, GoToOptions, HTTPRequest, HTTPResponse, Page, Viewport } from 'puppeteer';
import type { Cookie } from 'set-cookie-parser';
import puppeteer, { TimeoutError } from 'puppeteer';

import { Defer, Deferred } from 'civkit/defer';
import { AssertionFailureError, ParamValidationError } from 'civkit/civ-rpc';
import { AsyncService } from 'civkit/async-service';
import { FancyFile } from 'civkit/fancy-file';
import { delay } from 'civkit/timeout';

import { SecurityCompromiseError, ServiceCrashedError, ServiceNodeResourceDrainError } from '../shared/lib/errors';
import { CurlControl } from './curl';
import { BlackHoleDetector } from './blackhole-detector';
import { AsyncLocalContext } from './async-context';
import { GlobalLogger } from './logger';
import { minimalStealth } from './minimal-stealth';
const tldExtract = require('tld-extract');

const READABILITY_JS = fs.readFileSync(require.resolve('@mozilla/readability/Readability.js'), 'utf-8');


export interface ImgBrief {
    src: string;
    loaded?: boolean;
    width?: number;
    height?: number;
    naturalWidth?: number;
    naturalHeight?: number;
    alt?: string;
}

export interface ReadabilityParsed {
    title: string;
    content: string;
    textContent: string;
    length: number;
    excerpt: string;
    byline: string;
    dir: string;
    siteName: string;
    lang: string;
    publishedTime: string;
}

export interface PageSnapshot {
    title: string;
    description?: string;
    href: string;
    rebase?: string;
    html: string;
    htmlSignificantlyModifiedByJs?: boolean;
    shadowExpanded?: string;
    text: string;
    status?: number;
    statusText?: string;
    parsed?: Partial<ReadabilityParsed> | null;
    screenshot?: Buffer;
    pageshot?: Buffer;
    imgs?: ImgBrief[];
    pdfs?: string[];
    maxElemDepth?: number;
    elemCount?: number;
    childFrames?: PageSnapshot[];
    isIntermediate?: boolean;
    isFromCache?: boolean;
    lastMutationIdle?: number;
    lastContentResourceLoaded?: number;
    lastMediaResourceLoaded?: number;
    traits?: string[];
}

export interface ExtendedSnapshot extends PageSnapshot {
    links: [string, string][];
    imgs: ImgBrief[];
}

export interface ScrappingOptions {
    proxyUrl?: string;
    cookies?: Cookie[];
    favorScreenshot?: boolean;
    waitForSelector?: string | string[];
    minIntervalMs?: number;
    overrideUserAgent?: string;
    timeoutMs?: number;
    locale?: string;
    referer?: string;
    extraHeaders?: Record<string, string>;
    injectFrameScripts?: string[];
    injectPageScripts?: string[];
    viewport?: Viewport;
    proxyResources?: boolean;

    sideLoad?: {
        impersonate: {
            [url: string]: {
                status: number;
                headers: { [k: string]: string | string[]; };
                contentType?: string;
                body?: FancyFile;
            };
        };
        proxyOrigin: { [origin: string]: string; };
    };

}

const SIMULATE_SCROLL = `
(function () {
    function createIntersectionObserverEntry(target, isIntersecting, timestamp) {
        const targetRect = target.getBoundingClientRect();
        const record = {
            target,
            isIntersecting,
            time: timestamp,
            // If intersecting, intersectionRect matches boundingClientRect
            // If not intersecting, intersectionRect is empty (0x0)
            intersectionRect: isIntersecting
                ? targetRect
                : new DOMRectReadOnly(0, 0, 0, 0),
            // Current bounding client rect of the target
            boundingClientRect: targetRect,
            // Intersection ratio is either 0 (not intersecting) or 1 (fully intersecting)
            intersectionRatio: isIntersecting ? 1 : 0,
            // Root bounds (viewport in our case)
            rootBounds: new DOMRectReadOnly(
                0,
                0,
                window.innerWidth,
                window.innerHeight
            )
        };
        Object.setPrototypeOf(record, window.IntersectionObserverEntry.prototype);
        return record;
    }
    function cloneIntersectionObserverEntry(entry) {
        const record = {
            target: entry.target,
            isIntersecting: entry.isIntersecting,
            time: entry.time,
            intersectionRect: entry.intersectionRect,
            boundingClientRect: entry.boundingClientRect,
            intersectionRatio: entry.intersectionRatio,
            rootBounds: entry.rootBounds
        };
        Object.setPrototypeOf(record, window.IntersectionObserverEntry.prototype);
        return record;
    }
    const orig = window.IntersectionObserver;
    const kCallback = Symbol('callback');
    const kLastEntryMap = Symbol('lastEntryMap');
    const liveObservers = new Map();
    class MangledIntersectionObserver extends orig {
        constructor(callback, options) {
            super((entries, observer) => {
                const lastEntryMap = observer[kLastEntryMap];
                const lastEntry = entries[entries.length - 1];
                lastEntryMap.set(lastEntry.target, lastEntry);
                return callback(entries, observer);
            }, options);
            this[kCallback] = callback;
            this[kLastEntryMap] = new WeakMap();
            liveObservers.set(this, new Set());
        }
        disconnect() {
            liveObservers.get(this)?.clear();
            liveObservers.delete(this);
            return super.disconnect();
        }
        observe(target) {
            const observer = liveObservers.get(this);
            observer?.add(target);
            return super.observe(target);
        }
        unobserve(target) {
            const observer = liveObservers.get(this);
            observer?.delete(target);
            return super.unobserve(target);
        }
    }
    Object.defineProperty(MangledIntersectionObserver, 'name', { value: 'IntersectionObserver', writable: false });
    window.IntersectionObserver = MangledIntersectionObserver;
    function simulateScroll() {
        for (const [observer, targets] of liveObservers.entries()) {
            const t0 = performance.now();
            for (const target of targets) {
                const entry = createIntersectionObserverEntry(target, true, t0);
                observer[kCallback]([entry], observer);
                setTimeout(() => {
                    const t1 = performance.now();
                    const lastEntry = observer[kLastEntryMap].get(target);
                    if (!lastEntry) {
                        return;
                    }
                    const entry2 = { ...cloneIntersectionObserverEntry(lastEntry), time: t1 };
                    observer[kCallback]([entry2], observer);
                });
            }
        }
    }
    window.simulateScroll = simulateScroll;
})();
`;

const MUTATION_IDLE_WATCH = `
(function () {
    let timeout;
    const sendMsg = ()=> {
        document.dispatchEvent(new CustomEvent('mutationIdle'));
    };

    const cb = () => {
        if (timeout) {
            clearTimeout(timeout);
            timeout = setTimeout(sendMsg, 200);
        }
    };
    const mutationObserver = new MutationObserver(cb);

    document.addEventListener('DOMContentLoaded', () => {
        mutationObserver.observe(document.documentElement, {
            childList: true,
            subtree: true,
        });
        timeout = setTimeout(sendMsg, 200);
    }, { once: true })
})();
`;

const SCRIPT_TO_INJECT_INTO_FRAME = `
${READABILITY_JS}
${SIMULATE_SCROLL}
${MUTATION_IDLE_WATCH}
(${minimalStealth.toString()})();

(function(){
function briefImgs(elem) {
    const imageTags = Array.from((elem || document).querySelectorAll('img[src],img[data-src]'));

    return imageTags.map((x)=> {
        let linkPreferredSrc = x.src;
        if (linkPreferredSrc.startsWith('data:')) {
            if (typeof x.dataset?.src === 'string' && !x.dataset.src.startsWith('data:')) {
                linkPreferredSrc = x.dataset.src;
            }
        }

        return {
            src: new URL(linkPreferredSrc, document.baseURI).toString(),
            loaded: x.complete,
            width: x.width,
            height: x.height,
            naturalWidth: x.naturalWidth,
            naturalHeight: x.naturalHeight,
            alt: x.alt || x.title,
        };
    });
}
function getMaxDepthAndElemCountUsingTreeWalker(root=document.documentElement) {
  let maxDepth = 0;
  let currentDepth = 0;
  let elementCount = 0;

  const treeWalker = document.createTreeWalker(
    root,
    NodeFilter.SHOW_ELEMENT,
    (node) => {
      const nodeName = node.nodeName?.toLowerCase();
      return (nodeName === 'svg') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
    },
    false
  );

  while (true) {
    maxDepth = Math.max(maxDepth, currentDepth);
    elementCount++; // Increment the count for the current node

    if (treeWalker.firstChild()) {
      currentDepth++;
    } else {
      while (!treeWalker.nextSibling() && currentDepth > 0) {
        treeWalker.parentNode();
        currentDepth--;
      }

      if (currentDepth <= 0) {
        break;
      }
    }
  }

  return {
    maxDepth: maxDepth + 1,
    elementCount: elementCount
  };
}

function cloneAndExpandShadowRoots(rootElement = document.documentElement) {
  // Create a shallow clone of the root element
  const clone = rootElement.cloneNode(false);
  // Function to process an element and its shadow root
  function processShadowRoot(original, cloned) {
    if (original.shadowRoot && original.shadowRoot.mode === 'open') {
      shadowDomPresents = true;
      const shadowContent = document.createDocumentFragment();

      // Clone shadow root content normally
      original.shadowRoot.childNodes.forEach(childNode => {
        const clonedNode = childNode.cloneNode(true);
        shadowContent.appendChild(clonedNode);
      });

      // Handle slots
      const slots = shadowContent.querySelectorAll('slot');
      slots.forEach(slot => {
        const slotName = slot.getAttribute('name') || '';
        const assignedElements = original.querySelectorAll(
          slotName ? \`[slot="\${slotName}"]\` : ':not([slot])'
        );

        if (assignedElements.length > 0) {
          const slotContent = document.createDocumentFragment();
          assignedElements.forEach(el => {
            const clonedEl = el.cloneNode(true);
            slotContent.appendChild(clonedEl);
          });
          slot.parentNode.replaceChild(slotContent, slot);
        } else if (!slotName) {
          // Keep default slot content
          // No need to do anything as it's already cloned
        }
      });

      cloned.appendChild(shadowContent);
    }
  }

  // Use a TreeWalker on the original root to clone the entire structure
  const treeWalker = document.createTreeWalker(
    rootElement,
    NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT
  );

  const elementMap = new Map([[rootElement, clone]]);

  let currentNode;
  while (currentNode = treeWalker.nextNode()) {
    const parentClone = elementMap.get(currentNode.parentNode);
    const clonedNode = currentNode.cloneNode(false);
    parentClone.appendChild(clonedNode);

    if (currentNode.nodeType === Node.ELEMENT_NODE) {
      elementMap.set(currentNode, clonedNode);
      processShadowRoot(currentNode, clonedNode);
    }
  }

  return clone;
}

function shadowDomPresent(rootElement = document.documentElement) {
    const elems = rootElement.querySelectorAll('*');
    for (const x of elems) {
        if (x.shadowRoot && x.shadowRoot.mode === 'open') {
            return true;
        }
    }
    return false;
}

let lastMutationIdle = 0;
let initialAnalytics;
document.addEventListener('mutationIdle', ()=> lastMutationIdle = Date.now());

function giveSnapshot(stopActiveSnapshot, overrideDomAnalysis) {
    if (stopActiveSnapshot) {
        window.haltSnapshot = true;
    }
    let parsed;
    try {
        parsed = new Readability(document.cloneNode(true)).parse();
    } catch (err) {
        void 0;
    }
    const domAnalysis = overrideDomAnalysis || getMaxDepthAndElemCountUsingTreeWalker(document.documentElement);
    initialAnalytics ??= domAnalysis;

    const thisElemCount = domAnalysis.elementCount;
    const initialElemCount = initialAnalytics.elementCount;
    Math.abs(thisElemCount - initialElemCount) / (initialElemCount + Number.EPSILON)
    const r = {
        title: document.title,
        description: document.head?.querySelector('meta[name="description"]')?.getAttribute('content') ?? '',
        href: document.location.href,
        html: document.documentElement?.outerHTML,
        htmlSignificantlyModifiedByJs: Boolean(Math.abs(thisElemCount - initialElemCount) / (initialElemCount + Number.EPSILON) > 0.05),
        text: document.body?.innerText,
        shadowExpanded: shadowDomPresent() ? cloneAndExpandShadowRoots()?.outerHTML : undefined,
        parsed: parsed,
        imgs: [],
        maxElemDepth: domAnalysis.maxDepth,
        elemCount: domAnalysis.elementCount,
        lastMutationIdle,
    };
    if (document.baseURI !== r.href) {
        r.rebase = document.baseURI;
    }
    r.imgs = briefImgs();

    return r;
}
function waitForSelector(selectorText) {
  return new Promise((resolve) => {
    const existing = document.querySelector(selectorText);
    if (existing) {
      resolve(existing);
      return;
    }
    const observer = new MutationObserver(() => {
      const elem = document.querySelector(selectorText);
      if (elem) {
        resolve(document.querySelector(selectorText));
        observer.disconnect();
      }
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true
    });
  });
}
window.getMaxDepthAndElemCountUsingTreeWalker = getMaxDepthAndElemCountUsingTreeWalker;
window.waitForSelector = waitForSelector;
window.giveSnapshot = giveSnapshot;
window.briefImgs = briefImgs;
})();
`;

const documentResourceTypes = new Set([
    'document', 'script', 'xhr', 'fetch', 'prefetch', 'eventsource', 'websocket', 'preflight'
]);
const mediaResourceTypes = new Set([
    'stylesheet', 'image', 'font', 'media'
]);


class PageReqCtrlKit {
    reqSet: Set<HTTPRequest> = new Set();
    blockers: Deferred<void>[] = [];
    lastResourceLoadedAt: number = 0;
    lastContentResourceLoadedAt: number = 0;
    lastMediaResourceLoadedAt: number = 0;

    constructor(
        public concurrency: number,
    ) {
        if (isNaN(concurrency) || concurrency < 1) {
            throw new AssertionFailureError(`Invalid concurrency: ${concurrency}`);
        }
    }

    onNewRequest(req: HTTPRequest) {
        this.reqSet.add(req);
        if (this.reqSet.size <= this.concurrency) {
            return Promise.resolve();
        }
        const deferred = Defer();
        this.blockers.push(deferred);

        return deferred.promise;
    }

    onFinishRequest(req: HTTPRequest) {
        this.reqSet.delete(req);
        const deferred = this.blockers.shift();
        deferred?.resolve();
        const now = Date.now();
        this.lastResourceLoadedAt = now;
        // Beware req being undefined
        // https://pptr.dev/api/puppeteer.pageevent#:~:text=For%20certain%20requests%2C%20might%20contain%20undefined.
        const typ = req?.resourceType();
        if (!typ) {
            return;
        }
        if (documentResourceTypes.has(typ)) {
            this.lastContentResourceLoadedAt = now;
        }
        if (mediaResourceTypes.has(typ)) {
            this.lastMediaResourceLoadedAt = now;
        }
    }
}

@singleton()
export class PuppeteerControl extends AsyncService {

    _sn = 0;
    browser!: Browser;
    logger = this.globalLogger.child({ service: this.constructor.name });

    __loadedPage: Page[] = [];

    finalizerMap = new WeakMap<Page, ReturnType<typeof setTimeout>>();
    snMap = new WeakMap<Page, number>();
    livePages = new Set<Page>();
    pagePhase = new WeakMap<Page, 'idle' | 'active' | 'background'>();
    lastPageCratedAt: number = 0;
    ua: string = '';
    effectiveUA: string = '';

    concurrentRequestsPerPage: number = 32;
    pageReqCtrl = new WeakMap<Page, PageReqCtrlKit>();

    lastReqSentAt: number = 0;

    circuitBreakerHosts: Set<string> = new Set();

    lifeCycleTrack = new WeakMap();

    constructor(
        protected globalLogger: GlobalLogger,
        protected asyncLocalContext: AsyncLocalContext,
        protected curlControl: CurlControl,
        protected blackHoleDetector: BlackHoleDetector,
    ) {
        super(...arguments);
        this.setMaxListeners(Infinity);

        let crippledTimes = 0;
        this.on('crippled', () => {
            crippledTimes += 1;
            this.__loadedPage.length = 0;
            this.livePages.clear();
            if (crippledTimes > 5) {
                process.nextTick(() => {
                    this.emit('error', new Error('Browser crashed too many times, quitting...'));
                    // process.exit(1);
                });
            }
        });
    }

    override async init() {
        await this.dependencyReady();
        if (process.env.NODE_ENV?.includes('dry-run')) {
            this.emit('ready');
            return;
        }

        if (this.browser) {
            if (this.browser.connected) {
                await this.browser.close();
            } else {
                this.browser.process()?.kill('SIGKILL');
            }
        }
        this.browser = await puppeteer.launch({
            timeout: 10_000,
            headless: !Boolean(process.env.DEBUG_BROWSER),
            executablePath: process.env.OVERRIDE_CHROME_EXECUTABLE_PATH,
            args: [
                '--disable-dev-shm-usage',
                '--disable-blink-features=AutomationControlled'
            ]
        }).catch((err: any) => {
            this.logger.error(`Unknown firebase issue, just die fast.`, { err });
            process.nextTick(() => {
                this.emit('error', err);
                // process.exit(1);
            });
            return Promise.reject(err);
        });
        this.browser.once('disconnected', () => {
            this.logger.warn(`Browser disconnected`);
            if (this.browser) {
                this.emit('crippled');
            }
            process.nextTick(() => this.serviceReady());
        });
        this.ua = await this.browser.userAgent();
        this.logger.info(`Browser launched: ${this.browser.process()?.pid}, ${this.ua}`);
        this.effectiveUA = this.ua.replace(/Headless/i, '').replace('Mozilla/5.0 (X11; Linux x86_64)', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)');
        this.curlControl.impersonateChrome(this.effectiveUA);

        await this.newPage('beware_deadlock').then((r) => this.__loadedPage.push(r));

        this.emit('ready');
    }

    protected getRpsControlKit(page: Page) {
        let kit = this.pageReqCtrl.get(page);
        if (!kit) {
            kit = new PageReqCtrlKit(this.concurrentRequestsPerPage);
            this.pageReqCtrl.set(page, kit);
        }

        return kit;
    }

    async newPage(bewareDeadLock: any = false) {
        if (!bewareDeadLock) {
            await this.serviceReady();
        }
        const sn = this._sn++;
        let page;
        try {
            const dedicatedContext = await this.browser.createBrowserContext();
            page = await dedicatedContext.newPage();
        } catch (err: any) {
            this.logger.warn(`Failed to create page ${sn}`, { err });
            this.browser.process()?.kill('SIGKILL');
            throw new ServiceNodeResourceDrainError(`This specific worker node failed to open a new page, try again.`);
        }
        const preparations = [];

        preparations.push(page.setUserAgent(this.effectiveUA));
        // preparations.push(page.setUserAgent(`Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)`));
        // preparations.push(page.setUserAgent(`Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.0; +https://openai.com/gptbot)`));
        preparations.push(page.setBypassCSP(true));
        preparations.push(page.setViewport({ width: 1024, height: 1024 }));
        preparations.push(page.exposeFunction('reportSnapshot', (snapshot: PageSnapshot) => {
            if (snapshot.href === 'about:blank') {
                return;
            }
            page.emit('snapshot', snapshot);
        }));
        preparations.push(page.exposeFunction('setViewport', (viewport: Viewport | null) => {
            page.setViewport(viewport).catch(() => undefined);
        }));
        preparations.push(page.evaluateOnNewDocument(SCRIPT_TO_INJECT_INTO_FRAME));
        preparations.push(page.setRequestInterception(true));

        await Promise.all(preparations);

        await page.goto('about:blank', { waitUntil: 'domcontentloaded' });

        const domainSet = new Set<string>();
        let reqCounter = 0;
        let t0: number | undefined;
        let halt = false;

        page.on('request', async (req) => {
            reqCounter++;
            if (halt) {
                return req.abort('blockedbyclient', 1000);
            }
            const requestUrl = req.url();
            if (!requestUrl.startsWith('http:') && !requestUrl.startsWith('https:') && !requestUrl.startsWith('chrome-extension:') && requestUrl !== 'about:blank') {
                return req.abort('blockedbyclient', 1000);
            }
            t0 ??= Date.now();

            const parsedUrl = new URL(requestUrl);
            if (isIP(parsedUrl.hostname)) {
                domainSet.add(parsedUrl.hostname);
            } else {
                try {
                    const tldParsed = tldExtract(requestUrl);
                    domainSet.add(tldParsed.domain);
                } catch (_err) {
                    domainSet.add(parsedUrl.hostname);
                }
            }

            if (this.circuitBreakerHosts.has(parsedUrl.hostname.toLowerCase())) {
                page.emit('abuse', { url: requestUrl, page, sn, reason: `Abusive request: ${requestUrl}` });
                return req.abort('blockedbyclient', 1000);
            }

            if (
                parsedUrl.hostname === 'localhost' ||
                parsedUrl.hostname.startsWith('127.')
            ) {
                page.emit('abuse', { url: requestUrl, page, sn, reason: `Suspicious action: Request to localhost: ${requestUrl}` });

                return req.abort('blockedbyclient', 1000);
            }

            const dt = Math.ceil((Date.now() - t0) / 1000);
            const rps = reqCounter / dt;
            // console.log(`rps: ${rps}`);
            const pagePhase = this.pagePhase.get(page);
            if (pagePhase === 'background') {
                if (rps > 10 || reqCounter > 1000) {
                    halt = true;

                    return req.abort('blockedbyclient', 1000);
                }
            }
            if (reqCounter > 1000) {
                if (rps > 60 || reqCounter > 2000) {
                    page.emit('abuse', { url: requestUrl, page, sn, reason: `DDoS attack suspected: Too many requests` });
                    halt = true;

                    return req.abort('blockedbyclient', 1000);
                }
            }

            if (domainSet.size > 200) {
                page.emit('abuse', { url: requestUrl, page, sn, reason: `DDoS attack suspected: Too many domains` });
                halt = true;

                return req.abort('blockedbyclient', 1000);
            }

            if (requestUrl.startsWith('http')) {
                const kit = this.getRpsControlKit(page);
                await kit.onNewRequest(req);
            }

            if (req.isInterceptResolutionHandled()) {
                return;
            };

            const continueArgs = req.continueRequestOverrides
                ? [req.continueRequestOverrides(), 0] as const
                : [];

            return req.continue(continueArgs[0], continueArgs[1]);
        });
        const reqFinishHandler = (req: HTTPRequest) => {
            const kit = this.getRpsControlKit(page);
            kit.onFinishRequest(req);
        };
        page.on('requestfinished', reqFinishHandler);
        page.on('requestfailed', reqFinishHandler);
        page.on('requestservedfromcache', reqFinishHandler);

        await page.evaluateOnNewDocument(`
(function () {
    if (window.self === window.top) {
        let lastAnalytics;
        let lastReportedAt = 0;
        const handlePageLoad = () => {
            const now = Date.now();
            const dt = now - lastReportedAt;
            const previousAnalytics = lastAnalytics;
            const thisAnalytics = getMaxDepthAndElemCountUsingTreeWalker();
            let dElem = 0;

            if (window.haltSnapshot) {
                return;
            }

            const thisElemCount = thisAnalytics.elementCount;
            if (previousAnalytics) {
                const previousElemCount = previousAnalytics.elementCount;

                const delta = Math.abs(thisElemCount - previousElemCount);
                dElem = delta /(previousElemCount + Number.EPSILON);
            }

            if (dt < 1200 && dElem < 0.05) {
                return;
            }

            lastAnalytics = thisAnalytics;
            lastReportedAt = now;

            const r = giveSnapshot(false, lastAnalytics);
            window.reportSnapshot(r);
        };
        document.addEventListener('readystatechange', ()=> {
            if (document.readyState === 'interactive') {
                handlePageLoad();
            }
        });
        document.addEventListener('load', handlePageLoad);
        window.addEventListener('load', handlePageLoad);
        document.addEventListener('DOMContentLoaded', handlePageLoad);
        document.addEventListener('mutationIdle', handlePageLoad);
    }
    document.addEventListener('DOMContentLoaded', ()=> window.simulateScroll(), { once: true });
})();
`);

        this.snMap.set(page, sn);
        this.logger.debug(`Page ${sn} created.`);
        this.lastPageCratedAt = Date.now();
        this.livePages.add(page);
        this.pagePhase.set(page, 'idle');

        return page;
    }

    async getNextPage() {
        let thePage: Page | undefined;
        if (this.__loadedPage.length) {
            thePage = this.__loadedPage.shift();
            if (this.__loadedPage.length <= 1) {
                process.nextTick(() => {
                    this.newPage()
                        .then((r) => this.__loadedPage.push(r))
                        .catch((err) => {
                            this.logger.warn(`Failed to load new page ahead of time`, { err });
                        });
                });
            }
        }

        if (!thePage) {
            thePage = await this.newPage();
        }

        const timer = setTimeout(() => {
            this.logger.warn(`Page is not allowed to live past 5 minutes, ditching page ${this.snMap.get(thePage!)}...`);
            this.ditchPage(thePage!);
        }, 300 * 1000);

        this.finalizerMap.set(thePage, timer);

        return thePage;
    }

    async ditchPage(page: Page) {
        if (this.finalizerMap.has(page)) {
            clearTimeout(this.finalizerMap.get(page)!);
            this.finalizerMap.delete(page);
        }
        if (page.isClosed()) {
            return;
        }
        const sn = this.snMap.get(page);
        this.logger.debug(`Closing page ${sn}`);
        await Promise.race([
            (async () => {
                const ctx = page.browserContext();
                try {
                    await page.close();
                } finally {
                    await ctx.close();
                }
            })(),
            delay(5000)
        ]).catch((err) => {
            this.logger.error(`Failed to destroy page ${sn}`, { err });
        });
        this.livePages.delete(page);
        this.pagePhase.delete(page);
    }

    async *scrap(parsedUrl: URL, options: ScrappingOptions = {}): AsyncGenerator<PageSnapshot | undefined> {
        // parsedUrl.search = '';
        const url = parsedUrl.toString();
        let snapshot: PageSnapshot | undefined;
        let screenshot: Buffer | undefined;
        let pageshot: Buffer | undefined;
        const pdfUrls: string[] = [];
        let navigationResponse: HTTPResponse | undefined;
        const page = await this.getNextPage();
        this.lifeCycleTrack.set(page, this.asyncLocalContext.ctx);
        this.pagePhase.set(page, 'active');
        page.on('response', (resp) => {
            this.blackHoleDetector.itWorked();
            const req = resp.request();
            if (req.frame() === page.mainFrame() && req.isNavigationRequest()) {
                navigationResponse = resp;
            }
            if (!resp.ok()) {
                return;
            }
            const headers = resp.headers();
            const url = resp.url();
            const contentType = headers['content-type'];
            if (contentType?.toLowerCase().includes('application/pdf')) {
                pdfUrls.push(url);
            }
        });
        page.on('request', async (req) => {
            if (req.isInterceptResolutionHandled()) {
                return;
            };
            const reqUrlParsed = new URL(req.url());
            if (!reqUrlParsed.protocol.startsWith('http')) {
                const overrides = req.continueRequestOverrides();

                return req.continue(overrides, 0);
            }
            const typ = req.resourceType();
            if (typ === 'media') {
                // Non-cooperative answer to block all media requests.
                return req.abort('blockedbyclient');
            }
            if (!options.proxyResources) {
                const isDocRequest = ['document', 'xhr', 'fetch', 'websocket', 'prefetch', 'eventsource', 'ping'].includes(typ);
                if (!isDocRequest) {
                    if (options.extraHeaders) {
                        const overrides = req.continueRequestOverrides();
                        const continueArgs = [{
                            ...overrides,
                            headers: {
                                ...req.headers(),
                                ...overrides?.headers,
                                ...options.extraHeaders,
                            }
                        }, 1] as const;

                        return req.continue(continueArgs[0], continueArgs[1]);
                    }
                    const overrides = req.continueRequestOverrides();

                    return req.continue(overrides, 0);
                }
            }
            const sideload = options.sideLoad;

            const impersonate = sideload?.impersonate[reqUrlParsed.href];
            if (impersonate) {
                let body;
                if (impersonate.body) {
                    body = await readFile(await impersonate.body.filePath);
                    if (req.isInterceptResolutionHandled()) {
                        return;
                    }
                }
                return req.respond({
                    status: impersonate.status,
                    headers: impersonate.headers,
                    contentType: impersonate.contentType,
                    body: body ? Uint8Array.from(body) : undefined,
                }, 999);
            }

            const proxy = options.proxyUrl || sideload?.proxyOrigin?.[reqUrlParsed.origin];
            const ctx = this.lifeCycleTrack.get(page);
            if (proxy && ctx) {
                return await this.asyncLocalContext.bridge(ctx, async () => {
                    try {
                        const curled = await this.curlControl.sideLoad(reqUrlParsed, {
                            ...options,
                            method: req.method(),
                            body: req.postData(),
                            extraHeaders: {
                                ...req.headers(),
                                ...options.extraHeaders,
                            },
                            proxyUrl: proxy
                        });
                        if (req.isInterceptResolutionHandled()) {
                            return;
                        };

                        if (curled.chain.length === 1) {
                            if (!curled.file) {
                                return req.respond({
                                    status: curled.status,
                                    headers: _.omit(curled.headers, 'result'),
                                    contentType: curled.contentType,
                                }, 3);
                            }
                            const body = await readFile(await curled.file.filePath);
                            if (req.isInterceptResolutionHandled()) {
                                return;
                            };
                            return req.respond({
                                status: curled.status,
                                headers: _.omit(curled.headers, 'result'),
                                contentType: curled.contentType,
                                body: Uint8Array.from(body),
                            }, 3);
                        }
                        options.sideLoad ??= curled.sideLoadOpts;
                        _.merge(options.sideLoad, curled.sideLoadOpts);
                        const firstReq = curled.chain[0];

                        return req.respond({
                            status: firstReq.result!.code,
                            headers: _.omit(firstReq, 'result'),
                        }, 3);
                    } catch (err: any) {
                        this.logger.warn(`Failed to sideload browser request ${reqUrlParsed.origin}`, { href: reqUrlParsed.href, err, proxy });
                    }
                    if (req.isInterceptResolutionHandled()) {
                        return;
                    };
                    const overrides = req.continueRequestOverrides();
                    const continueArgs = [{
                        ...overrides,
                        headers: {
                            ...req.headers(),
                            ...overrides?.headers,
                            ...options.extraHeaders,
                        }
                    }, 1] as const;

                    return req.continue(continueArgs[0], continueArgs[1]);
                });
            }

            if (req.isInterceptResolutionHandled()) {
                return;
            };
            const overrides = req.continueRequestOverrides();
            const continueArgs = [{
                ...overrides,
                headers: {
                    ...req.headers(),
                    ...overrides?.headers,
                    ...options.extraHeaders,
                }
            }, 1] as const;

            return req.continue(continueArgs[0], continueArgs[1]);
        });
        let pageScriptEvaluations: Promise<unknown>[] = [];
        let frameScriptEvaluations: Promise<unknown>[] = [];
        if (options.injectPageScripts?.length) {
            page.on('framenavigated', (frame) => {
                if (frame !== page.mainFrame()) {
                    return;
                }

                pageScriptEvaluations.push(
                    Promise.allSettled(options.injectPageScripts!.map((x) => frame.evaluate(x).catch((err) => {
                        this.logger.warn(`Error in evaluation of page scripts`, { err });
                    })))
                );
            });
        }
        if (options.injectFrameScripts?.length) {
            page.on('framenavigated', (frame) => {
                frameScriptEvaluations.push(
                    Promise.allSettled(options.injectFrameScripts!.map((x) => frame.evaluate(x).catch((err) => {
                        this.logger.warn(`Error in evaluation of frame scripts`, { err });
                    })))
                );
            });
        }
        const sn = this.snMap.get(page);
        this.logger.info(`Page ${sn}: Scraping ${url}`, { url });
        if (options.locale) {
            // Add headers via request interception to walk around this bug
            // https://github.com/puppeteer/puppeteer/issues/10235
            // await page.setExtraHTTPHeaders({
            //     'Accept-Language': options.locale
            // });

            await page.evaluateOnNewDocument(() => {
                Object.defineProperty(navigator, "language", {
                    get: function () {
                        return options.locale;
                    }
                });
                Object.defineProperty(navigator, "languages", {
                    get: function () {
                        return [options.locale];
                    }
                });
            });
        }

        if (options.cookies) {
            const mapped = options.cookies.map((x) => {
                const draft: CookieParam = {
                    name: x.name,
                    value: encodeURIComponent(x.value),
                    secure: x.secure,
                    domain: x.domain,
                    path: x.path,
                    expires: x.expires ? Math.floor(x.expires.valueOf() / 1000) : undefined,
                    sameSite: x.sameSite as any,
                };
                if (!draft.expires && x.maxAge) {
                    draft.expires = Math.floor(Date.now() / 1000) + x.maxAge;
                }
                if (!draft.domain) {
                    draft.url = parsedUrl.toString();
                }

                return draft;
            });
            try {
                await page.setCookie(...mapped);
            } catch (err: any) {
                this.logger.warn(`Page ${sn}: Failed to set cookies`, { err });
                throw new ParamValidationError({
                    path: 'cookies',
                    message: `Failed to set cookies: ${err?.message}`
                });
            }
        }
        if (options.overrideUserAgent) {
            await page.setUserAgent(options.overrideUserAgent);
        }
        if (options.viewport) {
            await page.setViewport(options.viewport);
        }

        let nextSnapshotDeferred = Defer();
        const crippleListener = () => nextSnapshotDeferred.reject(new ServiceCrashedError({ message: `Browser crashed, try again` }));
        this.once('crippled', crippleListener);
        nextSnapshotDeferred.promise.finally(() => {
            this.off('crippled', crippleListener);
        });
        let successfullyDone;
        const hdl = (s: any) => {
            if (snapshot === s) {
                return;
            }
            snapshot = s;
            if (snapshot) {
                const kit = this.pageReqCtrl.get(page);
                snapshot.lastContentResourceLoaded = kit?.lastContentResourceLoadedAt;
                snapshot.lastMediaResourceLoaded = kit?.lastMediaResourceLoadedAt;
            }
            if (s?.maxElemDepth && s.maxElemDepth > 256) {
                return;
            }
            if (s?.elemCount && s.elemCount > 10_000) {
                return;
            }
            nextSnapshotDeferred.resolve(s);
            nextSnapshotDeferred = Defer();
            this.once('crippled', crippleListener);
            nextSnapshotDeferred.promise.finally(() => {
                this.off('crippled', crippleListener);
            });
        };
        page.on('snapshot', hdl);
        page.once('abuse', (event: any) => {
            this.emit('abuse', { ...event, url: parsedUrl });
            if (snapshot?.href && parsedUrl.href !== snapshot.href) {
                this.emit('abuse', { ...event, url: snapshot.href });
            }

            nextSnapshotDeferred.reject(
                new SecurityCompromiseError(`Abuse detected: ${event.reason}`)
            );
        });

        const timeout = options.timeoutMs || 30_000;
        const goToOptions: GoToOptions = {
            waitUntil: ['load', 'domcontentloaded', 'networkidle0'],
            timeout,
        };

        if (options.referer) {
            goToOptions.referer = options.referer;
        }

        let waitForPromise: Promise<any> | undefined;
        let finalizationPromise: Promise<any> | undefined;
        const doFinalization = async () => {
            if (waitForPromise) {
                // SuccessfullyDone is meant for the finish of the page.
                // It doesn't matter if you are expecting something and it didn't show up.
                await waitForPromise.catch(() => void 0);
            }
            successfullyDone ??= true;
            try {
                const pSubFrameSnapshots = this.snapshotChildFrames(page);
                snapshot = await page.evaluate('giveSnapshot(true)') as PageSnapshot;
                screenshot = (await this.takeScreenShot(page)) || screenshot;
                pageshot = (await this.takeScreenShot(page, { fullPage: true })) || pageshot;
                if (snapshot) {
                    snapshot.childFrames = await pSubFrameSnapshots;
                }
            } catch (err: any) {
                this.logger.warn(`Page ${sn}: Failed to finalize ${url}`, { err });
            }
            if (!snapshot?.html) {
                return;
            }

            this.logger.info(`Page ${sn}: Snapshot of ${url} done`, { url, title: snapshot?.title, href: snapshot?.href });
            this.emit(
                'crawled',
                {
                    ...snapshot,
                    status: navigationResponse?.status(),
                    statusText: navigationResponse?.statusText(),
                    pdfs: _.uniq(pdfUrls), screenshot, pageshot,
                },
                { ...options, url: parsedUrl }
            );
        };
        const delayPromise = delay(timeout);
        const gotoPromise = page.goto(url, goToOptions)
            .catch((err) => {
                if (err instanceof TimeoutError) {
                    this.logger.warn(`Page ${sn}: Browsing of ${url} timed out`, { err });
                    return new AssertionFailureError({
                        message: `Failed to goto ${url}: ${err}`,
                        cause: err,
                    });
                }
                if (err?.message?.startsWith('net::ERR_ABORTED')) {
                    if (pdfUrls.length) {
                        // Not throw for pdf mode.
                        return;
                    }
                }

                this.logger.warn(`Page ${sn}: Browsing of ${url} failed`, { err });
                return new AssertionFailureError({
                    message: `Failed to goto ${url}: ${err}`,
                    cause: err,
                });
            }).then(async (stuff) => {
                // This check is necessary because without snapshot, the condition of the page is unclear
                // Calling evaluate directly may stall the process.
                if (!snapshot) {
                    if (stuff instanceof Error) {
                        throw stuff;
                    }
                }
                await Promise.race([Promise.allSettled([...pageScriptEvaluations, ...frameScriptEvaluations]), delayPromise])
                    .catch(() => void 0);
                finalizationPromise = doFinalization();
                return stuff;
            });
        if (options.waitForSelector) {
            const t0 = Date.now();
            waitForPromise = nextSnapshotDeferred.promise.then(() => {
                const t1 = Date.now();
                const elapsed = t1 - t0;
                const remaining = timeout - elapsed;
                const thisTimeout = remaining > 100 ? remaining : 100;
                const p = (Array.isArray(options.waitForSelector) ?
                    Promise.all(options.waitForSelector.map((x) => page.waitForSelector(x, { timeout: thisTimeout }))) :
                    page.waitForSelector(options.waitForSelector!, { timeout: thisTimeout }))
                    .then(() => {
                        successfullyDone = true;
                    })
                    .catch((err) => {
                        waitForPromise = undefined;
                        this.logger.warn(`Page ${sn}: Failed to wait for selector ${options.waitForSelector}`, { err });
                    });
                return p as any;
            });

        }

        try {
            let lastHTML = snapshot?.html;
            while (true) {
                const ckpt = [nextSnapshotDeferred.promise, gotoPromise];
                if (waitForPromise) {
                    ckpt.push(waitForPromise);
                }
                if (options.minIntervalMs) {
                    ckpt.push(delay(options.minIntervalMs));
                }
                let error;
                await Promise.race(ckpt).catch((err) => error = err);
                if (successfullyDone && !error) {
                    if (!snapshot && !screenshot) {
                        throw new AssertionFailureError(`Could not extract any meaningful content from the page`);
                    }
                    yield {
                        ...snapshot,
                        status: navigationResponse?.status(),
                        statusText: navigationResponse?.statusText(),
                        pdfs: _.uniq(pdfUrls), screenshot, pageshot
                    } as PageSnapshot;
                    break;
                }
                if (options.favorScreenshot && snapshot?.title && snapshot?.html !== lastHTML) {
                    screenshot = (await this.takeScreenShot(page)) || screenshot;
                    pageshot = (await this.takeScreenShot(page, { fullPage: true })) || pageshot;
                    lastHTML = snapshot.html;
                }
                if (snapshot || screenshot) {
                    yield {
                        ...snapshot,
                        status: navigationResponse?.status(),
                        statusText: navigationResponse?.statusText(),
                        pdfs: _.uniq(pdfUrls), screenshot, pageshot,
                        isIntermediate: true,
                    } as PageSnapshot;
                }
                if (error) {
                    throw error;
                }
                if (successfullyDone) {
                    break;
                }
            }
            await finalizationPromise;
            yield {
                ...snapshot,
                status: navigationResponse?.status(),
                statusText: navigationResponse?.statusText(),
                pdfs: _.uniq(pdfUrls), screenshot, pageshot
            } as PageSnapshot;
        } finally {
            this.pagePhase.set(page, 'background');
            Promise.allSettled([gotoPromise, waitForPromise, finalizationPromise]).finally(() => {
                page.off('snapshot', hdl);
                this.ditchPage(page);
            });
            nextSnapshotDeferred.resolve();
        }
    }

    protected async takeScreenShot(page: Page, opts?: Parameters<typeof page.screenshot>[0]): Promise<Buffer | undefined> {
        const r = await page.screenshot(opts).catch((err) => {
            this.logger.warn(`Failed to take screenshot`, { err });
        });

        if (r) {
            return Buffer.from(r);
        }

        return undefined;
    }

    async snapshotChildFrames(page: Page): Promise<PageSnapshot[]> {
        const childFrames = page.mainFrame().childFrames();
        const r = await Promise.all(childFrames.map(async (x) => {
            const thisUrl = x.url();
            if (!thisUrl || thisUrl === 'about:blank') {
                return undefined;
            }
            try {
                await x.evaluate(SCRIPT_TO_INJECT_INTO_FRAME);

                return await x.evaluate(`giveSnapshot()`);
            } catch (err) {
                this.logger.warn(`Failed to snapshot child frame ${thisUrl}`, { err });
                return undefined;
            }
        })) as PageSnapshot[];

        return r.filter(Boolean);
    }

}

const puppeteerControl = container.resolve(PuppeteerControl);

export default puppeteerControl;
