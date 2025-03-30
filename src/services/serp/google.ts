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
import { parseJSONText } from 'civkit';



@singleton()
export class GoogleSERP extends AsyncService {

    constructor(
        protected globalLogger: GlobalLogger,
        protected puppeteerControl: SERPSpecializedPuppeteerControl,
        protected jsDomControl: JSDomControl,
        protected curlControl: CurlControl,
    ) {
        const filteredDeps = isMainThread ? arguments : _.without(arguments, puppeteerControl);
        super(...filteredDeps);
    }

    override async init() {
        await this.dependencyReady();

        this.emit('ready');
    }

    async webSearch(query: { [k: string]: any; }, opts?: ScrappingOptions) {
        const url = new URL(`https://www.google.com/search`);
        for (const [k, v] of Object.entries(query)) {
            if (v === undefined || v === null) {
                continue;
            }
            url.searchParams.set(k, `${v}`);
        }

        const snapshot = await this.puppeteerControl.controlledScrap(url, getWebSearchResults, opts);

        return snapshot;
    }

    async newsSearch(query: { [k: string]: any; }, opts?: ScrappingOptions) {
        const url = new URL(`https://www.google.com/search`);
        for (const [k, v] of Object.entries(query)) {
            if (v === undefined || v === null) {
                continue;
            }
            url.searchParams.set(k, `${v}`);
        }
        url.searchParams.set('tbm', 'nws');

        const snapshot = await this.puppeteerControl.controlledScrap(url, getNewsSearchResults, opts);

        return snapshot;
    }

    async imageSearch(query: { [k: string]: any; }, opts?: ScrappingOptions) {
        const url = new URL(`https://www.google.com/search`);
        for (const [k, v] of Object.entries(query)) {
            if (v === undefined || v === null) {
                continue;
            }
            url.searchParams.set(k, `${v}`);
        }
        url.searchParams.set('tbm', 'isch');
        url.searchParams.set('asearch', 'isch');
        url.searchParams.set('async', `_fmt:json,p:1,ijn:${query.start ? Math.floor(query.start / (query.num || 10)) : 0}`);

        const r = await this.curlControl.urlToFile(url, opts);

        const jsonTxt = (await readFile((await r.data?.filePath!))).toString();
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
    await window.waitForSelector('div[data-async-context^="query"]');

    const wrapper1 = document.querySelector('div[data-async-context^="query"]');

    if (!wrapper1) {
        return undefined;
    }

    const query = decodeURIComponent(wrapper1.getAttribute('data-async-context')?.split('query:')[1] || '');

    if (!query) {
        return undefined;
    }

    const candidates = Array.from(wrapper1.querySelectorAll('div[lang],div[data-surl]'));

    return candidates.map((x) => {
        const primaryLink = x.querySelector('a:not([href="#"])');
        if (!primaryLink) {
            return undefined;
        }
        const url = primaryLink.getAttribute('href');

        if (primaryLink.querySelector('div[role="heading"]')) {
            const spans = primaryLink.querySelectorAll('span');
            const title = spans[0]?.textContent;
            const source = spans[1]?.textContent;
            const date = spans[spans.length - 1].textContent;

            return {
                link: url,
                title,
                source,
                date,
                variant: 'video'
            };
        }

        const title = primaryLink.querySelector('h3')?.textContent;
        const source = Array.from(primaryLink.querySelectorAll('span')).find((x) => x.textContent)?.textContent;
        const cite = primaryLink.querySelector('cite[role=text]')?.textContent;
        let date = cite?.split('·')[1]?.trim();
        const snippets = Array.from(x.querySelectorAll('div[data-sncf*="1"] span'));
        const snippet = snippets[snippets.length - 1]?.textContent;
        date ??= snippets[snippets.length - 2]?.textContent?.trim();
        const imageUrl = x.querySelector('div[data-sncf*="1"] img[src]:not(img[src^="data"])')?.getAttribute('src');
        const subLinks = Array.from(x.querySelectorAll('div[data-sncf*="3"] a[href]')).map((l) => {
            return {
                url: l.getAttribute('href'),
                text: l.textContent,
            };
        });

        return {
            link: url,
            title,
            source,
            date,
            snippet,
            imageUrl: imageUrl?.startsWith('data:') ? undefined : imageUrl,
            subLinks: subLinks.length ? subLinks : undefined,
            variant: 'web',
        };
    }).filter(Boolean) as WebSearchEntry[];
}

async function getNewsSearchResults() {
    if (location.pathname.startsWith('/sorry') || location.pathname.startsWith('/error')) {
        throw new Error('Google returned an error page. This may happen due to various reasons, including rate limiting or other issues.');
    }

    // @ts-ignore
    await window.waitForSelector('div[data-async-context^="query"]');

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