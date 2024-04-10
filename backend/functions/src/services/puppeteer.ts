import { AsyncService, Defer } from 'civkit';
import { container, singleton } from 'tsyringe';
import puppeteer, { Browser } from 'puppeteer';
import { Logger } from '../shared/services/logger';
import genericPool from 'generic-pool';
import os from 'os';
import fs from 'fs';


const READABILITY_JS = fs.readFileSync(require.resolve('@mozilla/readability/Readability.js'), 'utf-8');

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
            return this.browser.connected && !page.isClosed();
        }
    }, {
        max: Math.ceil(os.freemem() / 1024 * 1024 * 1024),
        min: 0,
    });

    constructor(protected globalLogger: Logger) {
        super(...arguments);
    }

    override async init() {
        await this.dependencyReady();

        if (this.browser) {
            await this.browser.close();
        }
        this.browser = await puppeteer.launch({
            headless: false,
            args: ['--no-sandbox', '--disable-setuid-sandbox'],
        });
        this.browser.once('disconnected', () => {
            this.logger.warn(`Browser disconnected`);
            this.emit('crippled');
        });

        this.emit('ready');
    }

    async newPage() {
        await this.serviceReady();
        const dedicatedContext = await this.browser.createBrowserContext();

        const page = await dedicatedContext.newPage();
        await page.setUserAgent(`Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)`);
        await page.setViewport({ width: 1920, height: 1080 });
        await page.exposeFunction('reportSnapshot', (snapshot: any) => {
            page.emit('snapshot', snapshot);
        });

        await page.evaluateOnNewDocument(READABILITY_JS);

        await page.evaluateOnNewDocument(() => {
            // @ts-expect-error
            window.giveSnapshot() = () => {
                // @ts-expect-error
                return new Readability(document.cloneNode(true)).parse();
            };
            let aftershot: any;
            const handlePageLoad = () => {
                // @ts-expect-error
                if (document.readyState !== 'complete' && document.readyState !== 'interactive') {
                    return;
                }

                // @ts-expect-error
                const parsed = window.giveSnapshot();
                console.log(parsed);
                if (parsed) {
                    // @ts-expect-error
                    window.reportSnapshot(parsed);
                } else {
                    if (aftershot) {
                        clearTimeout(aftershot);
                    }
                    aftershot = setTimeout(() => {
                        // @ts-expect-error
                        window.reportSnapshot(window.giveSnapshot());
                    }, 500);
                }
            };
            // setInterval(handlePageLoad, 1000);
            // @ts-expect-error
            document.addEventListener('readystatechange', handlePageLoad);
            // @ts-expect-error
            document.addEventListener('load', handlePageLoad);
        });

        // TODO: further setup the page;

        return page;
    }

    async *scrap(url: string) {
        const page = await this.pagePool.acquire();
        let snapshot: unknown;
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
        const gotoPromise = page.goto(url, { waitUntil: 'networkidle2', timeout: 30_000 });
        gotoPromise.finally(() => finalized = true);

        try {
            while (true) {
                await Promise.race([nextSnapshotDeferred.promise, gotoPromise]);
                const screenshot = await page.screenshot();
                if (finalized) {
                    await gotoPromise;
                    snapshot = await page.evaluate('window.giveSnapshot()');
                    yield { snapshot, screenshot };
                    break;
                }
                yield { snapshot, screenshot };
            }
        } catch (_err) {
            void 0;
        } finally {
            page.off('snapshot', hdl);
            await this.pagePool.destroy(page);
        }

    }

}

const puppeteerControl = container.resolve(PuppeteerControl);

export default puppeteerControl;
