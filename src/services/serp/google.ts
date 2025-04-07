import { singleton } from 'tsyringe';
import { AsyncService } from 'civkit/async-service';
import { GlobalLogger } from '../logger';
import { JSDomControl } from '../jsdom';
import { isMainThread } from 'worker_threads';
import _ from 'lodash';
import { WebSearchEntry } from './compat';
import { ScrappingOptions, SERPSpecializedPuppeteerControl } from './puppeteer';
import { CurlControl } from '../curl';
import { readFile } from 'fs/promises';
import { ApplicationError } from 'civkit/civ-rpc';
import { ServiceBadApproachError, ServiceBadAttemptError } from '../errors';
import { parseJSONText } from 'civkit/vectorize';
import { retryWith } from 'civkit/decorators';
import { ProxyProviderService } from '../../shared/services/proxy-provider';

@singleton()
export class GoogleSERP extends AsyncService {
    logger = this.globalLogger.child({ service: this.constructor.name });
    googleDomain = process.env.OVERRIDE_GOOGLE_DOMAIN || 'www.google.com';

    constructor(
        protected globalLogger: GlobalLogger,
        protected puppeteerControl: SERPSpecializedPuppeteerControl,
        protected jsDomControl: JSDomControl,
        protected curlControl: CurlControl,
        protected proxyProvider: ProxyProviderService,
    ) {
        const filteredDeps = isMainThread ? arguments : _.without(arguments, puppeteerControl);
        super(...filteredDeps);
    }

    override async init() {
        await this.dependencyReady();

        this.emit('ready');
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
        if (opts?.allocProxy === 'none') {
            return this.curlControl.sideLoad(url, opts);
        }

        const proxy = await this.proxyProvider.alloc(
            process.env.PREFERRED_PROXY_COUNTRY || 'auto'
        );
        this.logger.debug(`Proxy allocated`, { proxy: proxy.href });
        const r = await this.curlControl.sideLoad(url, {
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

    async webSearch(query: { [k: string]: any; }, opts?: ScrappingOptions) {
        const url = this.digestQuery(query);

        const sideLoaded = await this.sideLoadWithAllocatedProxy(url, opts);
        if (opts && sideLoaded.sideLoadOpts) {
            opts.sideLoad = sideLoaded.sideLoadOpts;
        }

        const snapshot = await this.puppeteerControl.controlledScrap(url, getWebSearchResults, opts);

        return snapshot;
    }

    async newsSearch(query: { [k: string]: any; }, opts?: ScrappingOptions) {
        const url = this.digestQuery(query);

        url.searchParams.set('tbm', 'nws');

        const sideLoaded = await this.sideLoadWithAllocatedProxy(url, opts);
        if (opts && sideLoaded.sideLoadOpts) {
            opts.sideLoad = sideLoaded.sideLoadOpts;
        }

        const snapshot = await this.puppeteerControl.controlledScrap(url, getNewsSearchResults, opts);

        return snapshot;
    }

    async imageSearch(query: { [k: string]: any; }, opts?: ScrappingOptions) {
        const url = this.digestQuery(query);

        url.searchParams.set('tbm', 'isch');
        url.searchParams.set('asearch', 'isch');
        url.searchParams.set('async', `_fmt:json,p:1,ijn:${query.start ? Math.floor(query.start / (query.num || 10)) : 0}`);

        const sideLoaded = await this.sideLoadWithAllocatedProxy(url, opts);

        if (sideLoaded.status !== 200 || !sideLoaded.file) {
            throw new ServiceBadAttemptError('Google returned an error page. This may happen due to various reasons, including rate limiting or other issues.');
        }

        const jsonTxt = (await readFile((await sideLoaded.file.filePath))).toString();
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