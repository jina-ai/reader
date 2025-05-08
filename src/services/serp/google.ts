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
import { parseJSONText } from 'civkit/vectorize';
import { retry, retryWith } from 'civkit/decorators';
import { SERPProxyProviderService } from '../../shared/services/proxy-provider';
import { readBlob } from '../../utils/encoding';
import { createContext, Script } from 'vm';
import { BrowserContext } from 'puppeteer';
import { createPool } from 'generic-pool';
import { randomBytes } from 'crypto';
import { AsyncLocalContext } from '../async-context';

interface SerpContext {
    proxyUrl?: string;
    browserContext?: BrowserContext;
    validTill?: Date;
    magicId?: string;
}

@singleton()
export class GoogleSERP extends AsyncService {
    logger = this.globalLogger.child({ service: this.constructor.name });
    googleDomain = process.env.OVERRIDE_GOOGLE_DOMAIN || 'www.google.com';

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
            magicId: randomBytes(17).toString('base64url'),
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
            throw new ServiceBadAttemptError('Google returned a 429 error. This may happen due to various reasons, including rate limiting or other issues.');
        }

        if (opts && opts.allocProxy) {
            opts.proxyUrl ??= proxy.href;
        }

        return { ...r, proxy };
    }

    digestQuery(query: { [k: string]: any; }) {
        const url = new URL(`https://${this.googleDomain}/search`);
        const clone = { ...query };
        const num = clone.num || 10;
        if (clone.page) {
            const page = parseInt(clone.page);
            delete clone.page;
            clone.start = (page - 1) * num;
            if (clone.start === 0) {
                delete clone.start;
            }
        }
        if (clone.location) {
            delete clone.location;
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
        if (!url.searchParams.has('start')) {
            url.searchParams.set('start', '0');
        }
        url.searchParams.set('asearch', 'arc');

        const ctx = await this.contextPool.acquire();

        url.searchParams.set('async', getMagicAsyncParam(query.start, ctx.magicId));

        const t0 = performance.now();
        const sideLoaded = await this.sideLoadWithAllocatedProxy(url, {
            ...opts,
            allocProxy: opts?.allocProxy || (this.nativeIPHealthy ? 'none' : 'auto'),
            proxyUrl: ctx.proxyUrl,
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
                message: 'Google returned an error page. This may happen due to various reasons, including rate limiting or other issues.',
            });
        }

        if (opts && sideLoaded.sideLoadOpts) {
            opts.sideLoad = sideLoaded.sideLoadOpts;
        }

        if (!sideLoaded.file) {
            throw new ServiceBadAttemptError('Google returned an error page. This may happen due to various reasons, including rate limiting or other issues.');
        }
        const contentType = sideLoaded.contentType;
        const encoding: string | undefined = contentType.includes('charset=') ? contentType.split('charset=')[1]?.trim().toLowerCase() : 'utf-8';

        let html = await readBlob(sideLoaded.file, encoding);
        let innerCharset;
        const peek = html.slice(0, 1024);
        innerCharset ??= peek.match(/<meta[^>]+text\/html;\s*?charset=([^>"]+)/i)?.[1]?.toLowerCase();
        innerCharset ??= peek.match(/<meta[^>]+charset="([^>"]+)\"/i)?.[1]?.toLowerCase();
        if (innerCharset && innerCharset !== encoding) {
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
                message: 'Google returned an error page. This may happen due to various reasons, including rate limiting or other issues.',
                err
            });
        }
    }

    @retry(2)
    async imageSearch(query: { [k: string]: any; }, opts?: ScrappingOptions) {
        const url = this.digestQuery(query);

        url.searchParams.set('tbm', 'isch');
        url.searchParams.set('asearch', 'isch');
        url.searchParams.set('async', `_fmt:json,p:1,ijn:${query.start ? Math.floor(query.start / (query.num || 10)) : 0}`);
        const ctx = await this.contextPool.acquire();

        const sideLoaded = await this.sideLoadWithAllocatedProxy(url, {
            ...opts,
            proxyUrl: ctx.proxyUrl,
            allocProxy: opts?.allocProxy || (this.nativeIPHealthy ? 'none' : 'auto'),
        }).catch((err) => {
            this.contextPool.destroy(ctx);

            return Promise.reject(err);
        });

        if ('proxy' in sideLoaded) {
            ctx.proxyUrl = sideLoaded.proxy.href;
            ctx.validTill = new Date(Date.now() + 30 * 60 * 1000);
        }

        if (sideLoaded.status === 200) {
            this.contextPool.release(ctx);
        } else {
            this.contextPool.destroy(ctx);
            if (this.nativeIPHealthy && this.asyncLocalContext.ctx.ctxIsNew) {
                this.nativeIPBlocked();
            }
        }

        if (sideLoaded.status !== 200 || !sideLoaded.file) {
            throw new ServiceBadAttemptError('Google returned an error page. This may happen due to various reasons, including rate limiting or other issues.');
        }

        const jsonTxt = (await readBlob(sideLoaded.file)).toString();
        const rJSON = parseJSONText(jsonTxt.slice(jsonTxt.indexOf('{"ischj":')));

        return _.get(rJSON, 'ischj.metadata').map((x: any) => {

            return {
                link: _.get(x, 'result.referrer_url'),
                title: _.get(x, 'result.page_title'),
                snippet: _.get(x, 'text_in_grid.snippet'),
                source: _.get(x, 'result.site_title'),
                imageWidth: _.get(x, 'original_image.width'),
                imageHeight: _.get(x, 'original_image.height'),
                imageUrl: _.get(x, 'original_image.url'),
                variant: 'images',
            };
        }) as WebSearchEntry[];
    }
}


@singleton()
export class GoogleSERPOldFashion extends GoogleSERP {
    override async createContext() {
        await this.serviceReady();
        this.asyncLocalContext.ctx.ctxIsNew = true;

        return {
            browserContext: await this.puppeteerControl.browser.createBrowserContext(),
            magicId: randomBytes(17).toString('base64url'),
            validTill: new Date(Date.now() + 30 * 60 * 1000),
        } as SerpContext;
    }

    override async webSearch(query: { [k: string]: any; }, opts?: ScrappingOptions) {
        const url = this.digestQuery(query);

        const ctx = await this.contextPool.acquire();

        const sideLoaded = await this.sideLoadWithAllocatedProxy(url, {
            ...opts,
            proxyUrl: ctx.proxyUrl,
        }).catch((err) => {
            this.contextPool.destroy(ctx);

            return Promise.reject(err);
        });

        if ('proxy' in sideLoaded) {
            ctx.proxyUrl = sideLoaded.proxy.href;
            ctx.validTill = new Date(Date.now() + 30 * 60 * 1000);
        }

        if (sideLoaded.status === 200) {
            this.contextPool.release(ctx);
        } else {
            this.contextPool.destroy(ctx);
        }

        if (opts && sideLoaded.sideLoadOpts) {
            opts.sideLoad = sideLoaded.sideLoadOpts;
        }

        const snapshot = await this.puppeteerControl.controlledScrap(url, getWebSearchResults, opts);

        if (!Array.isArray(snapshot)) {
            throw new ServiceBadAttemptError('Google returned an error page. This may happen due to various reasons, including rate limiting or other issues.');
        }

        return snapshot;
    }

    async newsSearch(query: { [k: string]: any; }, opts?: ScrappingOptions) {
        const url = this.digestQuery(query);

        url.searchParams.set('tbm', 'nws');

        const ctx = await this.contextPool.acquire();

        const sideLoaded = await this.sideLoadWithAllocatedProxy(url, {
            ...opts,
            proxyUrl: ctx.proxyUrl,
        }).catch((err) => {
            this.contextPool.destroy(ctx);

            return Promise.reject(err);
        });

        if ('proxy' in sideLoaded) {
            ctx.proxyUrl = sideLoaded.proxy.href;
            ctx.validTill = new Date(Date.now() + 30 * 60 * 1000);
        }

        const snapshot = await this.puppeteerControl.controlledScrap(url, getNewsSearchResults, {
            ...opts,
            proxyUrl: ctx.proxyUrl,
            browserContext: ctx.browserContext,
        }).catch((err) => {
            this.contextPool.destroy(ctx);

            return Promise.reject(err);
        });

        this.contextPool.release(ctx);

        return snapshot;
    }
}

async function getWebSearchResults() {
    if (location.pathname.startsWith('/sorry') || location.pathname.startsWith('/error')) {
        throw new Error('Google returned an error page. This may happen due to various reasons, including rate limiting or other issues.');
    }

    // @ts-ignore
    await Promise.race([window.waitForSelector('div[data-async-context^="query"]'), window.waitForSelector('#botstuff .mnr-c')]);

    const wrapper1 = document.querySelector('div[data-async-context^="query"]');

    if (!wrapper1) {
        return undefined;
    }

    const query = decodeURIComponent(wrapper1.getAttribute('data-async-context')?.split('query:')[1] || '');

    if (!query) {
        return undefined;
    }

    const candidates = Array.from(wrapper1.querySelectorAll('div[lang],div[data-surl]'));

    return candidates.map((x, pos) => {
        const primaryLink = x.querySelector('a:not([href="#"])');
        if (!primaryLink) {
            return undefined;
        }
        const url = primaryLink.getAttribute('href');

        if (primaryLink.querySelector('div[role="heading"]')) {
            // const spans = primaryLink.querySelectorAll('span');
            // const title = spans[0]?.textContent;
            // const source = spans[1]?.textContent;
            // const date = spans[spans.length - 1].textContent;

            // return {
            //     link: url,
            //     title,
            //     source,
            //     date,
            //     variant: 'video'
            // };
            return undefined;
        }

        const title = primaryLink.querySelector('h3')?.textContent;
        const source = Array.from(primaryLink.querySelectorAll('span')).find((x) => x.textContent)?.textContent;
        const cite = primaryLink.querySelector('cite[role=text]')?.textContent;
        let date = cite?.split('·')[1]?.trim();
        const snippets = Array.from(x.querySelectorAll('div[data-sncf*="1"] span'));
        let snippet = snippets[snippets.length - 1]?.textContent;
        if (!snippet) {
            snippet = x.querySelector('div.IsZvec')?.textContent?.trim() || null;
        }
        date ??= snippets[snippets.length - 2]?.textContent?.trim();
        const imageUrl = x.querySelector('div[data-sncf*="1"] img[src]:not(img[src^="data"])')?.getAttribute('src');
        let siteLinks = Array.from(x.querySelectorAll('div[data-sncf*="3"] a[href]')).map((l) => {
            return {
                link: l.getAttribute('href'),
                title: l.textContent,
            };
        });
        const perhapsParent = x.parentElement?.closest('div[data-hveid]');
        if (!siteLinks?.length && perhapsParent) {
            const candidates = Array.from(perhapsParent.querySelectorAll('td h3'));
            if (candidates.length) {
                siteLinks = candidates.map((l) => {
                    const link = l.querySelector('a');
                    if (!link) {
                        return undefined;
                    }
                    const snippet = l.nextElementSibling?.textContent;
                    return {
                        link: link.getAttribute('href'),
                        title: link.textContent,
                        snippet,
                    };
                }).filter(Boolean) as any;
            }
        }

        return {
            link: url,
            title,
            source,
            date,
            snippet: snippet ?? undefined,
            imageUrl: imageUrl?.startsWith('data:') ? undefined : imageUrl,
            siteLinks: siteLinks.length ? siteLinks : undefined,
            variant: 'web',
        };
    }).filter(Boolean) as WebSearchEntry[];
}
function getWebSearchResultsSync() {
    const wrapper1 = document.querySelector('div[data-async-context^="query"]');

    if (!wrapper1) {
        return undefined;
    }

    const query = decodeURIComponent(wrapper1.getAttribute('data-async-context')?.split('query:')[1] || '');

    if (!query) {
        return undefined;
    }

    const candidates = Array.from(wrapper1.querySelectorAll('div[lang],div[data-surl]'));

    return candidates.map((x, pos) => {
        const primaryLink = x.querySelector('a:not([href="#"])');
        if (!primaryLink) {
            return undefined;
        }
        const url = primaryLink.getAttribute('href');

        if (primaryLink.querySelector('div[role="heading"]')) {
            // const spans = primaryLink.querySelectorAll('span');
            // const title = spans[0]?.textContent;
            // const source = spans[1]?.textContent;
            // const date = spans[spans.length - 1].textContent;

            // return {
            //     link: url,
            //     title,
            //     source,
            //     date,
            //     variant: 'video'
            // };
            return undefined;
        }

        const title = primaryLink.querySelector('h3')?.textContent;
        const source = Array.from(primaryLink.querySelectorAll('span')).find((x) => x.textContent)?.textContent;
        const cite = primaryLink.querySelector('cite[role=text]')?.textContent;
        let date = cite?.split('·')[1]?.trim();
        const snippets = Array.from(x.querySelectorAll('div[data-sncf*="1"] span'));
        let snippet = snippets[snippets.length - 1]?.textContent;
        if (!snippet) {
            snippet = x.querySelector('div.IsZvec')?.textContent?.trim() || null;
        }
        date ??= snippets[snippets.length - 2]?.textContent?.trim();
        const imageUrl = x.querySelector('div[data-sncf*="1"] img[src]:not(img[src^="data"])')?.getAttribute('src');
        let siteLinks = Array.from(x.querySelectorAll('div[data-sncf*="3"] a[href]')).map((l) => {
            return {
                link: l.getAttribute('href'),
                title: l.textContent,
            };
        });
        const perhapsParent = x.parentElement?.closest('div[data-hveid]');
        if (!siteLinks?.length && perhapsParent) {
            const candidates = Array.from(perhapsParent.querySelectorAll('td h3'));
            if (candidates.length) {
                siteLinks = candidates.map((l) => {
                    const link = l.querySelector('a');
                    if (!link) {
                        return undefined;
                    }
                    const snippet = l.nextElementSibling?.textContent;
                    return {
                        link: link.getAttribute('href'),
                        title: link.textContent,
                        snippet,
                    };
                }).filter(Boolean) as any;
            }
        }

        return {
            link: url,
            title,
            source,
            date,
            snippet: snippet ?? undefined,
            imageUrl: imageUrl?.startsWith('data:') ? undefined : imageUrl,
            siteLinks: siteLinks.length ? siteLinks : undefined,
            variant: 'web',
        };
    }).filter(Boolean) as WebSearchEntry[];
}
const script = new Script(`(${getWebSearchResultsSync.toString()})()`);
function runGetWebSearchResultsScript(ctx: object) {
    return script.runInContext(ctx);
}

async function getNewsSearchResults() {
    if (location.pathname.startsWith('/sorry') || location.pathname.startsWith('/error')) {
        throw new Error('Google returned an error page. This may happen due to various reasons, including rate limiting or other issues.');
    }

    // @ts-ignore
    await Promise.race([window.waitForSelector('div[data-async-context^="query"]'), window.waitForSelector('#botstuff .mnr-c')]);

    const wrapper1 = document.querySelector('div[data-async-context^="query"]');

    if (!wrapper1) {
        return undefined;
    }

    const query = decodeURIComponent(wrapper1.getAttribute('data-async-context')?.split('query:')[1] || '');

    if (!query) {
        return undefined;
    }

    const candidates = Array.from(wrapper1.querySelectorAll('div[data-news-doc-id]'));

    return candidates.map((x) => {
        const primaryLink = x.querySelector('a:not([href="#"])');
        if (!primaryLink) {
            return undefined;
        }
        const url = primaryLink.getAttribute('href');
        const titleElem = primaryLink.querySelector('div[role="heading"]');

        if (!titleElem) {
            return undefined;
        }

        const title = titleElem.textContent?.trim();
        const source = titleElem.previousElementSibling?.textContent?.trim();
        const snippet = titleElem.nextElementSibling?.textContent?.trim();

        const innerSpans = Array.from(titleElem.parentElement?.querySelectorAll('span') || []);
        const date = innerSpans[innerSpans.length - 1]?.textContent?.trim();

        return {
            link: url,
            title,
            source,
            date,
            snippet,
            variant: 'news',
        };
    }).filter(Boolean) as WebSearchEntry[];
}

function getMagicAsyncParam(start: number = 0, inputArcid?: string) {
    const arcid = inputArcid || randomBytes(17).toString('base64url');

    return `arc_id:srp_${arcid}_1${start.toString().padStart(2, '0')},use_ac:true,_fmt:prog`;
}