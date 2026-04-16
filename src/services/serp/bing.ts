import { singleton } from 'tsyringe';
import { AsyncService } from 'civkit/async-service';
import { GlobalLogger } from '../logger';
import { JSDomControl } from '../jsdom';
import { isMainThread } from 'worker_threads';
import _ from 'lodash';
import { WebSearchEntry } from './compat';
import { ScrappingOptions, SERPSpecializedPuppeteerControl } from './puppeteer';
import { CurlControl } from '../curl';
import { ApplicationError } from 'civkit/civ-rpc';
import { ServiceBadApproachError, ServiceBadAttemptError } from '../errors';
import { retry, retryWith } from 'civkit/decorators';
import { SERPProxyProviderService } from '../proxy-provider';
import { readBlob, WEB_SUPPORTED_ENCODINGS } from '../../utils/encoding';
import { createContext, Script } from 'vm';
import { BrowserContext } from 'puppeteer';
import { createPool } from 'generic-pool';
import { AsyncLocalContext } from '../async-context';
import parse from 'set-cookie-parser';

interface SerpContext {
    proxyUrl?: string;
    browserContext?: BrowserContext;
    validTill?: Date;
}

@singleton()
export class BingSERP extends AsyncService {
    logger = this.globalLogger.child({ service: this.constructor.name });
    bingDomain = process.env.OVERRIDE_BING_DOMAIN || 'www.bing.com';

    nativeIPHealthy = true;

    contextPool = createPool({
        create: () => {
            return this.createContext();
        },
        destroy: async (ctx: SerpContext) => {
            if (ctx.browserContext) {
                try {
                    await ctx.browserContext.close();
                } catch (err) {
                    this.logger.warn('Error closing browser context', { err });
                }
            }
        },
        validate: async (ctx: SerpContext) => {
            if (ctx.validTill && ctx.validTill > (new Date(Date.now() + 5 * 60 * 1000))) {
                return true;
            }

            return !ctx.proxyUrl;
        },
    }, {
        max: 3_000,
        testOnBorrow: true,
    });

    protected async createContext() {
        await this.serviceReady();
        this.asyncLocalContext.ctx.ctxIsNew = true;

        return {
            validTill: new Date(Date.now() + 30 * 60 * 1000),
        } as SerpContext;
    }

    constructor(
        protected globalLogger: GlobalLogger,
        protected puppeteerControl: SERPSpecializedPuppeteerControl,
        protected jsDomControl: JSDomControl,
        protected curlControl: CurlControl,
        protected proxyProvider: SERPProxyProviderService,
        protected asyncLocalContext: AsyncLocalContext,
    ) {
        const filteredDeps = isMainThread ? arguments : _.without(arguments, puppeteerControl);
        super(...filteredDeps);
    }

    override async init() {
        await this.dependencyReady();

        this.emit('ready');
    }

    nativeIPBlocked() {
        this.nativeIPHealthy = false;
        this.logger.warn('Native IP is not healthy.');
        setTimeout(() => {
            this.nativeIPHealthy = true;
            this.logger.debug('Presume native IP healthy again after timeout.');
        }, 1000 * 60 * 60);
    }

    @retryWith((err) => {
        if (err instanceof ServiceBadApproachError) {
            return false;
        }
        if (err instanceof ServiceBadAttemptError) {
            // Keep trying
            return true;
        }
        if (err instanceof ApplicationError) {
            // Quit with this error
            return false;
        }
        return undefined;
    }, 3)
    async sideLoadWithAllocatedProxy(url: URL, opts?: ScrappingOptions) {
        if (opts?.allocProxy === 'none' || opts?.proxyUrl) {
            return this.curlControl.sideLoadBlob(url, opts);
        }

        const proxy = await this.proxyProvider.alloc();
        this.logger.debug(`Proxy allocated`, { proxy: proxy.href });
        const r = await this.curlControl.sideLoadBlob(url, {
            ...opts,
            proxyUrl: proxy.href,
        });

        if (r.status === 429) {
            throw new ServiceBadAttemptError('Bing returned a 429 error. This may happen due to various reasons, including rate limiting or other issues.');
        }

        if (opts && opts.allocProxy) {
            opts.proxyUrl ??= proxy.href;
        }

        return { ...r, proxy };
    }

    digestQuery(query: { [k: string]: any; }) {
        const url = new URL(`https://${this.bingDomain}/search`);
        const clone: any = { ...query, q: query.q, pq: query.q, };
        if (clone.page) {
            const page = parseInt(clone.page);
            delete clone.page;
            if (page > 1) {
                clone.first = (page - 1) * 10 + 1;
            }
            if (page === 2) {
                clone.FORM = 'PERE';
            } else if (page > 2) {
                clone.FORM = `PERE${page - 2}`;
            }
        }
        if (clone.location) {
            delete clone.location;
        }
        if (clone.autocorrect) {
            delete clone.autocorrect;
        }
        if (clone.gl) {
            delete clone.gl;
        }
        if (clone.hl) {
            delete clone.hl;
        }

        for (const [k, v] of Object.entries(clone)) {
            if (v === undefined || v === null) {
                continue;
            }
            url.searchParams.set(k, `${v}`);
        }

        return url;
    }

    @retry(2)
    async webSearch(query: { [k: string]: any; }, opts?: ScrappingOptions) {
        const url = this.digestQuery(query);
        const origHref = url.href;

        const ctx = await this.contextPool.acquire();

        const t0 = performance.now();
        const sideLoaded = await this.sideLoadWithAllocatedProxy(url, {
            ...opts,
            allocProxy: opts?.allocProxy || (this.nativeIPHealthy ? 'none' : 'auto'),
            proxyUrl: ctx.proxyUrl,
            cookies: parse([
                `_EDGE_CD=m=${query.gl || 'us'}&u=${query.hl || 'en'}`,
                `_EDGE_S=mkt=${query.gl || 'us'}&ui=${query.hl || 'en'}`
            ]),
            timeoutMs: 3_700
        }).catch((err) => {
            this.contextPool.destroy(ctx);

            return Promise.reject(err);
        });

        const dt = performance.now() - t0;

        if ('proxy' in sideLoaded) {
            ctx.proxyUrl = sideLoaded.proxy.href;
            ctx.validTill = new Date(Date.now() + 30 * 60 * 1000);
        }

        if (sideLoaded.status === 200) {
            if (dt < 1_700) {
                this.contextPool.release(ctx);
            } else {
                this.contextPool.destroy(ctx);
            }
        } else {
            if (this.nativeIPHealthy && this.asyncLocalContext.ctx.ctxIsNew) {
                this.nativeIPBlocked();
            }
            this.contextPool.destroy(ctx);
            throw new ServiceBadAttemptError({
                message: 'Bing returned an error page. This may happen due to various reasons, including rate limiting or other issues.',
            });
        }

        if (opts && sideLoaded.sideLoadOpts) {
            opts.sideLoad = sideLoaded.sideLoadOpts;
        }

        if (!sideLoaded.file) {
            throw new ServiceBadAttemptError('Bing returned an error page. This may happen due to various reasons, including rate limiting or other issues.');
        }
        const contentType = sideLoaded.contentType;
        let encoding: string | undefined = contentType.includes('charset=') ? contentType.split('charset=')[1]?.trim().toLowerCase().replaceAll(/["';]/gi, '') : 'utf-8';
        if (!WEB_SUPPORTED_ENCODINGS.has(encoding)) {
            encoding = 'utf-8';
        }

        let html = await readBlob(sideLoaded.file, encoding);
        let innerCharset;
        const peek = html.slice(0, 1024);
        innerCharset ??= peek.match(/<meta[^>]+text\/html;\s*?charset=([^>"]+)/i)?.[1]?.toLowerCase();
        innerCharset ??= peek.match(/<meta[^>]+charset="([^>"]+)\"/i)?.[1]?.toLowerCase();
        if (innerCharset && innerCharset !== encoding && WEB_SUPPORTED_ENCODINGS.has(innerCharset)) {
            html = await readBlob(sideLoaded.file, innerCharset);
        }

        const jsdom = this.jsDomControl.linkedom.parseHTML(html, { location: { href: origHref } });
        try {
            const r = runGetWebSearchResultsScript(createContext(jsdom));
            if (!Array.isArray(r)) {
                throw new Error('Failed to parse response as SERP results');
            }

            return r;
        } catch (err) {
            throw new ServiceBadAttemptError({
                message: 'Bing returned an error page. This may happen due to various reasons, including rate limiting or other issues.',
                err
            });
        }
    }
}

function getWebSearchResultsSync() {
    const candidates = Array.from(document.querySelectorAll('ol#b_results li.b_algo'));

    return candidates.map((x, pos) => {
        const primaryLink = x.querySelector('h2 a');
        if (!primaryLink) {
            return undefined;
        }
        let url = primaryLink.getAttribute('href') || '';
        if (url.startsWith('https://www.bing.com/ck/a?')) {
            const parsed = new URL(url);
            const encoded = (parsed.searchParams.get('u') || '').slice(2);
            url = Buffer.from(encoded, 'base64url').toString('utf-8');
        }
        const title = primaryLink.textContent || undefined;
        const source = x.querySelector('.tptt')?.textContent || undefined;
        let snippet = x.querySelector('p')?.textContent;
        if (snippet?.includes(' · ')) {
            snippet = snippet.split(' · ')[1].trim();
        }
        const date = x.querySelector('p span.news_dt')?.textContent || undefined;
        const imageUrl = x.querySelector('.b_imgcap_altitle img[src]:not(img[src^="data"])')?.getAttribute('src') || undefined;

        return {
            link: url,
            title,
            source,
            date,
            snippet: snippet ?? undefined,
            imageUrl: imageUrl?.startsWith('data:') ? undefined : imageUrl,
            variant: 'web',
        };
    }).filter(Boolean) as WebSearchEntry[];
}
const script = new Script(`(${getWebSearchResultsSync.toString()})()`);
function runGetWebSearchResultsScript(ctx: object) {
    return script.runInContext(ctx);
}
