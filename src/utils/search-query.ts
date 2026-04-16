import { SerperSearchQueryParams } from '../3rd-party/serper-search';

const tldExtract = require('tld-extract');

function mapDomainQuery(_q: string) {
    let q = _q.toLowerCase();
    if (URL.canParse(q)) {
        const url = new URL(q);
        q = url.hostname;
    }
    let tld;
    try {
        const tldParsed = tldExtract.parse_host(q);
        tld = tldParsed.domain;
    } catch (_err) {
        tld = q;
    }
    if (tld && q === tld) {
        return { path: 'tld', value: tld };
    }

    return { path: 'domain', value: q };
}

export function parseSearchQuery(inputQuery: SerperSearchQueryParams) {
    const q = inputQuery.q || '';
    const chunks = q.trim().split(/\s+/g);
    const query = [];

    const queryMixins: { filter?: any[], should?: any[], must?: any[], mustNot?: any[]; } = {};

    const sites = [];
    const noSites = [];

    for (const x of chunks) {
        const columnIdx = x.indexOf(':');
        if (columnIdx <= 0) {
            query.push(x);
            continue;
        }
        const cmd = x.slice(0, columnIdx).toLowerCase();
        const value = x.slice(columnIdx + 1).trim();

        if (value) {
            if (cmd === 'site') {
                sites.push(value.toLowerCase());
                continue;
            } else if (cmd === '-site') {
                noSites.push(value.toLowerCase());
                continue;
            }
        }

        query.push(x);
    }

    if (sites.length) {
        queryMixins.filter ??= [];
        const mapped = sites.map(mapDomainQuery);
        const tlds = mapped.filter((x) => x.path === 'tld').map((x)=> x.value);
        const domains = mapped.filter((x) => x.path === 'domain').map((x)=> x.value);
        if (tlds.length) {
            queryMixins.filter.push({
                in: {
                    path: 'tld',
                    value: tlds,
                }
            });
        }
        if (domains.length) {
            queryMixins.filter.push({
                in: {
                    path: 'domain',
                    value: domains,
                }
            });
        }
    }
    if (noSites.length) {
        queryMixins.mustNot ??= [];
        queryMixins.mustNot.push(...noSites.map(mapDomainQuery).map((x) => ({ equals: x })));
    }

    // if (inputQuery.gl) {
    //     searchFilter.geolocation = `geolocation:${inputQuery.gl}`;
    // }
    // if (inputQuery.hl) {
    //     searchFilter.language = `language:${inputQuery.hl}`;
    // }

    return {
        query: query.join(' '),
        queryMixins,
    };
}