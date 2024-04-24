import os from 'os';
import fs from 'fs';
import { container, singleton } from 'tsyringe';
import genericPool from 'generic-pool';
import { AsyncService, Defer, marshalErrorLike, AssertionFailureError } from 'civkit';
import { Logger } from '../shared/services/logger';

import type { Browser, CookieParam, Page } from 'puppeteer';
import puppeteer from 'puppeteer-extra';

import puppeteerBlockResources from 'puppeteer-extra-plugin-block-resources';
import puppeteerPageProxy from 'puppeteer-extra-plugin-page-proxy';


const READABILITY_JS = fs.readFileSync(require.resolve('@mozilla/readability/Readability.js'), 'utf-8');

export interface ImgBrief {
    src: string;
    loaded: boolean;
    width: number;
    height: number;
    naturalWidth: number;
    naturalHeight: number;
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
    href: string;
    html: string;
    text: string;
    parsed?: Partial<ReadabilityParsed> | null;
    screenshot?: Buffer;
    imgs?: ImgBrief[];
}

export interface ScrappingOptions {
    proxyUrl?: string;
    cookies?: CookieParam[];
}


const puppeteerStealth = require('puppeteer-extra-plugin-stealth');
puppeteer.use(puppeteerStealth());
// const puppeteerUAOverride = require('puppeteer-extra-plugin-stealth/evasions/user-agent-override');
// puppeteer.use(puppeteerUAOverride({
//     userAgent: `Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.0; +https://openai.com/gptbot)`,
//     platform: `Linux`,
// }))

puppeteer.use(puppeteerBlockResources({
    blockedTypes: new Set(['media']),
    interceptResolutionPriority: 1,
}));
puppeteer.use(puppeteerPageProxy({
    interceptResolutionPriority: 1,
}));

@singleton()
export class PuppeteerControl extends AsyncService {

    browser!: Browser;
    logger = this.globalLogger.child({ service: this.constructor.name });

    pagePool = genericPool.createPool({
        create: async () => {
            const page = await this.newPage();
            return page;
        },
        destroy: async (page) => {
            await page.browserContext().close();
        },
        validate: async (page) => {
            return page.browser().connected && !page.isClosed();
        }
    }, {
        max: Math.max(1 + Math.floor(os.totalmem() / (384 * 1024 * 1024)), 16),
        min: 1,
        acquireTimeoutMillis: 60_000,
        testOnBorrow: true,
        testOnReturn: true,
        autostart: false,
    });

    constructor(protected globalLogger: Logger) {
        super(...arguments);
    }

    override async init() {
        await this.dependencyReady();
        this.logger.info(`PuppeteerControl initializing with pool size ${this.pagePool.max}`, { poolSize: this.pagePool.max });
        this.pagePool.start();

        if (this.browser) {
            if (this.browser.connected) {
                await this.browser.close();
            } else {
                this.browser.process()?.kill();
            }
        }
        this.browser = await puppeteer.launch({
            timeout: 10_000
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
            this.emit('crippled');
        });
        this.logger.info(`Browser launched: ${this.browser.process()?.pid}`);

        this.emit('ready');
    }

    async newPage() {
        await this.serviceReady();
        const dedicatedContext = await this.browser.createBrowserContext();

        const page = await dedicatedContext.newPage();
        const preparations = [];

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
        preparations.push(page.evaluateOnNewDocument(READABILITY_JS));
        preparations.push(page.evaluateOnNewDocument(`
function briefImgs(elem) {
    const imageTags = Array.from((elem || document).querySelectorAll('img[src]'));

    return imageTags.map((x)=> ({
        src: x.src,
        loaded: x.complete,
        width: x.width,
        height: x.height,
        naturalWidth: x.naturalWidth,
        naturalHeight: x.naturalHeight,
        alt: x.alt || x.title,
    }));
}
function giveSnapshot() {
    let parsed;
    try {
        parsed = new Readability(document.cloneNode(true)).parse();
    } catch (err) {
        void 0;
    }

    const r = {
        title: document.title,
        href: document.location.href,
        html: document.documentElement.outerHTML,
        text: document.body.innerText,
        parsed: parsed,
        imgs: [],
    };
    if (parsed && parsed.content) {
        const elem = document.createElement('div');
        elem.innerHTML = parsed.content;
        r.imgs = briefImgs(elem);
    } else {
        const allImgs = briefImgs();
        if (allImgs.length === 1) {
            r.imgs = allImgs;
        }
    }

    return r;
}
`));
        preparations.push(page.evaluateOnNewDocument(`
let aftershot = undefined;
const handlePageLoad = () => {
    if (document.readyState !== 'complete') {
        return;
    }
    const parsed = giveSnapshot();
    window.reportSnapshot(parsed);
    if (!parsed.text) {
        if (aftershot) {
            clearTimeout(aftershot);
        }
        aftershot = setTimeout(() => {
            const r = giveSnapshot();
            if (r && r.text) {
                window.reportSnapshot(r);
            }
        }, 500);
    }
};
document.addEventListener('readystatechange', handlePageLoad);
document.addEventListener('load', handlePageLoad);
`));
        await Promise.all(preparations);

        // TODO: further setup the page;

        return page;
    }

    async *scrap(parsedUrl: URL, options: ScrappingOptions): AsyncGenerator<PageSnapshot | undefined> {
        // parsedUrl.search = '';
        const url = parsedUrl.toString();

        this.logger.info(`Scraping ${url}`, { url });

        let snapshot: PageSnapshot | undefined;
        let screenshot: Buffer | undefined;

        const page = await this.pagePool.acquire();
        if (options.proxyUrl) {
            await page.useProxy(options.proxyUrl);
        }
        if (options.cookies) {
            await page.setCookie(...options.cookies);
        }

        let nextSnapshotDeferred = Defer();
        let finalized = false;
        const hdl = (s: any) => {
            if (snapshot === s) {
                return;
            }
            snapshot = s;
            nextSnapshotDeferred.resolve(s);
            nextSnapshotDeferred = Defer();
        };
        page.on('snapshot', hdl);

        const gotoPromise = page.goto(url, { waitUntil: ['load', 'domcontentloaded', 'networkidle0'], timeout: 30_000 })
            .catch((err) => {
                this.logger.warn(`Browsing of ${url} did not fully succeed`, { err: marshalErrorLike(err) });
                return Promise.reject(new AssertionFailureError({
                    message: `Failed to goto ${url}: ${err}`,
                    cause: err,
                }));
            }).finally(async () => {
                if (!snapshot?.html) {
                    finalized = true;
                    return;
                }
                snapshot = await page.evaluate('giveSnapshot()') as PageSnapshot;
                screenshot = await page.screenshot();
                if (!snapshot.title || !snapshot.parsed?.content) {
                    const salvaged = await this.salvage(url, page);
                    if (salvaged) {
                        snapshot = await page.evaluate('giveSnapshot()') as PageSnapshot;
                        screenshot = await page.screenshot();
                    }
                }
                finalized = true;
                this.logger.info(`Snapshot of ${url} done`, { url, title: snapshot?.title, href: snapshot?.href });
                this.emit(
                    'crawled',
                    { ...snapshot, screenshot },
                    { ...options, url: parsedUrl }
                );
            });

        try {
            let lastHTML = snapshot?.html;
            while (true) {
                await Promise.race([nextSnapshotDeferred.promise, gotoPromise]);
                if (finalized) {
                    yield { ...snapshot, screenshot } as PageSnapshot;
                    break;
                }
                if (snapshot?.title && snapshot?.html !== lastHTML) {
                    screenshot = await page.screenshot();
                    lastHTML = snapshot.html;
                }
                if (snapshot || screenshot) {
                    yield { ...snapshot, screenshot } as PageSnapshot;
                }
            }
        } finally {
            gotoPromise.finally(() => {
                page.off('snapshot', hdl);
                this.pagePool.destroy(page).catch((err) => {
                    this.logger.warn(`Failed to destroy page`, { err: marshalErrorLike(err) });
                });
            });
        }
    }

    async salvage(url: string, page: Page) {
        this.logger.info(`Salvaging ${url}`);
        const googleArchiveUrl = `https://webcache.googleusercontent.com/search?q=cache:${encodeURIComponent(url)}`;
        const resp = await fetch(googleArchiveUrl, {
            headers: {
                'User-Agent': `Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.0; +https://openai.com/gptbot)`
            }
        });
        resp.body?.cancel().catch(() => void 0);
        if (!resp.ok) {
            this.logger.warn(`No salvation found for url: ${url}`, { status: resp.status, url });
            return null;
        }

        await page.goto(googleArchiveUrl, { waitUntil: ['load', 'domcontentloaded', 'networkidle0'], timeout: 15_000 }).catch((err) => {
            this.logger.warn(`Page salvation did not fully succeed.`, { err: marshalErrorLike(err) });
        });

        this.logger.info(`Salvation completed.`);

        return true;
    }
}

const puppeteerControl = container.resolve(PuppeteerControl);

export default puppeteerControl;
