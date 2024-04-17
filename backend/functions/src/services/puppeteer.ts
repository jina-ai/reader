import { AssertionFailureError, AsyncService, Defer, HashManager, marshalErrorLike } from 'civkit';
import { container, singleton } from 'tsyringe';
import type { Browser, Page } from 'puppeteer';
import { Logger } from '../shared/services/logger';
import genericPool from 'generic-pool';
import os from 'os';
import fs from 'fs';
import { Crawled } from '../db/crawled';
import puppeteer from 'puppeteer-extra';

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
const md5Hasher = new HashManager('md5', 'hex');

const puppeteerStealth = require('puppeteer-extra-plugin-stealth');
puppeteer.use(puppeteerStealth());
// const puppeteerUAOverride = require('puppeteer-extra-plugin-stealth/evasions/user-agent-override');
// puppeteer.use(puppeteerUAOverride({
//     userAgent: `Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.0; +https://openai.com/gptbot)`,
//     platform: `Linux`,
// }))

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
        max: Math.max(1 + Math.floor(os.freemem() / 1024 * 1024 * 1024), 16),
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
        preparations.push(page.exposeFunction('reportSnapshot', (snapshot: any) => {
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
    }

    return r;
}
`));
        preparations.push(page.evaluateOnNewDocument(() => {
            let aftershot: any;
            const handlePageLoad = () => {
                // @ts-expect-error
                if (document.readyState !== 'complete' && document.readyState !== 'interactive') {
                    return;
                }
                // @ts-expect-error
                const parsed = giveSnapshot();
                if (parsed) {
                    // @ts-expect-error
                    window.reportSnapshot(parsed);
                } else {
                    if (aftershot) {
                        clearTimeout(aftershot);
                    }
                    aftershot = setTimeout(() => {
                        // @ts-expect-error
                        window.reportSnapshot(giveSnapshot());
                    }, 500);
                }
            };
            // setInterval(handlePageLoad, 1000);
            // @ts-expect-error
            document.addEventListener('readystatechange', handlePageLoad);
            // @ts-expect-error
            document.addEventListener('load', handlePageLoad);
        }));

        await Promise.all(preparations);

        // TODO: further setup the page;

        return page;
    }

    async *scrap(url: string, noCache: string | boolean = false): AsyncGenerator<PageSnapshot | undefined> {
        const parsedUrl = new URL(url);
        // parsedUrl.search = '';
        parsedUrl.hash = '';
        const normalizedUrl = parsedUrl.toString().toLowerCase();
        const digest = md5Hasher.hash(normalizedUrl);
        this.logger.info(`Scraping ${url}, normalized digest: ${digest}`, { url, digest });

        let snapshot: PageSnapshot | undefined;
        let screenshot: Buffer | undefined;

        if (!noCache) {
            const cached = (await Crawled.fromFirestoreQuery(Crawled.COLLECTION.where('urlPathDigest', '==', digest).orderBy('createdAt', 'desc').limit(1)))?.[0];

            if (cached && cached.createdAt.valueOf() > (Date.now() - 1000 * 300)) {
                const age = Date.now() - cached.createdAt.valueOf();
                this.logger.info(`Cache hit for ${url}, normalized digest: ${digest}, ${age}ms old`, { url, digest, age });
                snapshot = {
                    ...cached.snapshot
                };
                if (snapshot) {
                    delete snapshot.screenshot;
                }

                screenshot = cached.snapshot?.screenshot ? Buffer.from(cached.snapshot.screenshot, 'base64') : undefined;
                yield {
                    ...cached.snapshot,
                    screenshot: cached.snapshot?.screenshot ? Buffer.from(cached.snapshot.screenshot, 'base64') : undefined
                };

                return;
            }
        }

        const page = await this.pagePool.acquire();
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
                finalized = true;
                if (!snapshot?.html) {
                    return;
                }
                screenshot = await page.screenshot({
                    type: 'jpeg',
                    quality: 75,
                });
                snapshot = await page.evaluate('giveSnapshot()') as PageSnapshot;
                if (!snapshot.title || !snapshot.parsed?.content) {
                    const salvaged = await this.salvage(url, page);
                    if (salvaged) {
                        screenshot = await page.screenshot({
                            type: 'jpeg',
                            quality: 75,
                        });
                        snapshot = await page.evaluate('giveSnapshot()') as PageSnapshot;
                    }
                }
                this.logger.info(`Snapshot of ${url} done`, { url, digest, title: snapshot?.title, href: snapshot?.href });
                const nowDate = new Date();
                Crawled.save(
                    Crawled.from({
                        url,
                        createdAt: nowDate,
                        expireAt: new Date(nowDate.valueOf() + 1000 * 3600 * 24 * 7),
                        urlPathDigest: digest,
                        snapshot: { ...snapshot, screenshot: screenshot?.toString('base64') || '' },
                    }).degradeForFireStore()
                ).catch((err) => {
                    this.logger.warn(`Failed to save snapshot`, { err: marshalErrorLike(err) });
                });
            });

        try {
            while (true) {
                await Promise.race([nextSnapshotDeferred.promise, gotoPromise]);
                if (finalized) {
                    yield { ...snapshot, screenshot } as PageSnapshot;
                    break;
                }
                yield snapshot;
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

        return true;
    }
}

const puppeteerControl = container.resolve(PuppeteerControl);

export default puppeteerControl;
