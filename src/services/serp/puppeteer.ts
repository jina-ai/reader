import _ from 'lodash';
import { readFile } from 'fs/promises';
import { container, singleton } from 'tsyringe';

import type { Browser, BrowserContext, CookieParam, GoToOptions, Page, Viewport } from 'puppeteer';
import type { Cookie } from 'set-cookie-parser';
import puppeteer, { TimeoutError } from 'puppeteer';

import { Defer } from 'civkit/defer';
import { AssertionFailureError, ParamValidationError } from 'civkit/civ-rpc';
import { AsyncService } from 'civkit/async-service';
import { FancyFile } from 'civkit/fancy-file';
import { delay } from 'civkit/timeout';

import { SecurityCompromiseError, ServiceCrashedError, ServiceNodeResourceDrainError } from '../../shared/lib/errors';
import { CurlControl } from '../curl';
import { AsyncLocalContext } from '../async-context';
import { GlobalLogger } from '../logger';
import { minimalStealth } from '../minimal-stealth';
import { BlackHoleDetector } from '../blackhole-detector';


export interface ScrappingOptions {
    browserContext?: BrowserContext;
    proxyUrl?: string;
    cookies?: Cookie[];
    overrideUserAgent?: string;
    timeoutMs?: number;
    locale?: string;
    referer?: string;
    extraHeaders?: Record<string, string>;
    viewport?: Viewport;
    proxyResources?: boolean;
    allocProxy?: string;

    sideLoad?: {
        impersonate: {
            [url: string]: {
                status: number;
                headers: { [k: string]: string | string[]; };
                contentType?: string;
                body?: FancyFile | Blob;
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
${SIMULATE_SCROLL}
${MUTATION_IDLE_WATCH}
(${minimalStealth.toString()})();

(function(){

let lastMutationIdle = 0;
let initialAnalytics;
document.addEventListener('mutationIdle', ()=> lastMutationIdle = Date.now());

function waitForSelector(selectorText) {
  return new Promise((resolve) => {
    const existing = document.querySelector(selectorText);
    if (existing) {
      resolve(existing);
      return;
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
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
window.waitForSelector = waitForSelector;
})();
`;

@singleton()
export class SERPSpecializedPuppeteerControl extends AsyncService {

    _sn = 0;
    browser!: Browser;
    logger = this.globalLogger.child({ service: this.constructor.name });

    finalizerMap = new WeakMap<Page, ReturnType<typeof setTimeout>>();
    snMap = new WeakMap<Page, number>();
    livePages = new Set<Page>();
    lastPageCratedAt: number = 0;
    ua: string = '';
    effectiveUA: string = '';

    protected _REPORT_FUNCTION_NAME = 'bingo';

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
                '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'
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

        this.emit('ready');
    }

    async newPage<T>(context?: BrowserContext) {
        await this.serviceReady();
        const sn = this._sn++;
        let page;
        context ??= await this.browser.createBrowserContext();
        try {
            page = await context.newPage();
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
        preparations.push(page.exposeFunction(this._REPORT_FUNCTION_NAME, (thing: T) => {
            page.emit(this._REPORT_FUNCTION_NAME, thing);
        }));
        preparations.push(page.exposeFunction('setViewport', (viewport: Viewport | null) => {
            page.setViewport(viewport).catch(() => undefined);
        }));
        preparations.push(page.evaluateOnNewDocument(SCRIPT_TO_INJECT_INTO_FRAME));

        await Promise.all(preparations);

        this.snMap.set(page, sn);
        this.logger.debug(`Page ${sn} created.`);
        this.lastPageCratedAt = Date.now();
        this.livePages.add(page);

        return page;
    }

    async getNextPage(context?: BrowserContext) {
        const thePage = await this.newPage(context);
        if (!thePage) {
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
            page.close(),
            delay(5000)
        ]).catch((err) => {
            this.logger.error(`Failed to destroy page ${sn}`, { err });
        });
        this.livePages.delete(page);
    }

    async controlledScrap<T>(parsedUrl: URL, func: (this: void) => Promise<T>, options: ScrappingOptions = {}): Promise<T> {
        // parsedUrl.search = '';
        const url = parsedUrl.toString();
        const page = await this.getNextPage(options.browserContext);
        this.lifeCycleTrack.set(page, this.asyncLocalContext.ctx);
        page.on('response', (_resp) => {
            this.blackHoleDetector.itWorked();
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
            if (typ === 'media' || typ === 'font' || typ === 'image' || typ === 'stylesheet') {
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
                    if (impersonate.body instanceof Blob) {
                        body = new Uint8Array(await impersonate.body.arrayBuffer());
                    } else {
                        body = await readFile(await impersonate.body.filePath);
                    }
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
        await page.setRequestInterception(true);

        const sn = this.snMap.get(page);
        this.logger.info(`Page ${sn}: Scraping ${url}`, { url });

        await page.evaluateOnNewDocument(`(function () {
if (window.top !== window.self) {
    return;
}
const func = ${func.toString()};

func().then((result) => {
    window.${this._REPORT_FUNCTION_NAME}({data: result});
}).catch((err) => {
    window.${this._REPORT_FUNCTION_NAME}({err: err});
});

})();`);

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

        const resultDeferred = Defer<T>();
        const crippleListener = () => resultDeferred.reject(new ServiceCrashedError({ message: `Browser crashed, try again` }));
        this.once('crippled', crippleListener);
        resultDeferred.promise.finally(() => {
            this.off('crippled', crippleListener);
        });
        const hdl = (s: {
            err?: any;
            data?: T;
        }) => {
            if (s.err) {
                resultDeferred.reject(s.err);
            }
            resultDeferred.resolve(s.data);
        };
        page.on(this._REPORT_FUNCTION_NAME, hdl as any);
        page.once('abuse', (event: any) => {
            this.emit('abuse', { ...event, url: parsedUrl });

            resultDeferred.reject(
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


        const gotoPromise = page.goto(url, goToOptions)
            .catch((err) => {
                if (err instanceof TimeoutError) {
                    this.logger.warn(`Page ${sn}: Browsing of ${url} timed out`, { err });
                    return new AssertionFailureError({
                        message: `Failed to goto ${url}: ${err}`,
                        cause: err,
                    });
                }

                this.logger.warn(`Page ${sn}: Browsing of ${url} aborted`, { err });
                return undefined;
            }).then(async (r) => {
                await delay(5000);
                resultDeferred.reject(new TimeoutError(`Control function did not respond in time`));
                return r;
            });

        try {
            await Promise.race([resultDeferred.promise, gotoPromise]);

            return resultDeferred.promise;
        } finally {
            page.off(this._REPORT_FUNCTION_NAME, hdl as any);
            this.ditchPage(page);
            resultDeferred.resolve();
        }
    }

}

const puppeteerControl = container.resolve(SERPSpecializedPuppeteerControl);

export default puppeteerControl;
