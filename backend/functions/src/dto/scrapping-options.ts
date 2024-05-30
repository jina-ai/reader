import { AutoCastable, Prop, RPC_CALL_ENVIRONMENT } from 'civkit'; // Adjust the import based on where your decorators are defined
import type { Request, Response } from 'express';
import type { CookieParam } from 'puppeteer';
import { parseString as parseSetCookieString } from 'set-cookie-parser';

export class CrawlerOptions extends AutoCastable {

    @Prop({
        default: 'default',
    })
    respondWith!: string;

    @Prop({
        default: false,
    })
    withGeneratedAlt!: boolean;

    @Prop({
        default: false,
    })
    withLinksSummary!: boolean;

    @Prop({
        default: false,
    })
    withImagesSummary!: boolean;

    @Prop({
        default: false,
    })
    noCache!: boolean;

    @Prop()
    cacheTolerance?: number;

    @Prop()
    targetSelector?: string;

    @Prop()
    waitForSelector?: string;

    @Prop({
        arrayOf: String,
    })
    setCookies?: CookieParam[];

    @Prop()
    proxyUrl?: string;

    static override from(input: any) {
        const instance = super.from(input) as CrawlerOptions;
        const ctx = Reflect.get(input, RPC_CALL_ENVIRONMENT) as {
            req: Request,
            res: Response,
        };

        const customMode = ctx.req.get('x-respond-with') || ctx.req.get('x-return-format');
        if (customMode !== undefined) {
            instance.respondWith = customMode;
        }

        const withGeneratedAlt = ctx.req.get('x-with-generated-alt');
        if (withGeneratedAlt !== undefined) {
            instance.withGeneratedAlt = Boolean(withGeneratedAlt);
        }
        const withLinksSummary = ctx.req.get('x-with-links-summary');
        if (withLinksSummary !== undefined) {
            instance.withLinksSummary = Boolean(withLinksSummary);
        }
        const withImagesSummary = ctx.req.get('x-with-images-summary');
        if (withImagesSummary !== undefined) {
            instance.withImagesSummary = Boolean(withImagesSummary);
        }
        const noCache = ctx.req.get('x-no-cache');
        if (noCache !== undefined) {
            instance.noCache = Boolean(noCache);
            if (instance.noCache && instance.cacheTolerance === undefined) {
                instance.cacheTolerance = 0;
            }
        }
        let cacheTolerance = parseInt(ctx.req.get('x-cache-tolerance') || '');
        if (!isNaN(cacheTolerance)) {
            instance.cacheTolerance = cacheTolerance;
        }

        const targetSelector = ctx.req.get('x-target-selector');
        instance.targetSelector ??= targetSelector;
        const waitForSelector = ctx.req.get('x-wait-for-selector');
        instance.waitForSelector ??= waitForSelector || instance.targetSelector;

        const cookies: CookieParam[] = [];
        const setCookieHeaders = ctx.req.headers['x-set-cookie'] || (instance.setCookies as any as string[]);
        if (Array.isArray(setCookieHeaders)) {
            for (const setCookie of setCookieHeaders) {
                cookies.push({
                    ...parseSetCookieString(setCookie, { decodeValues: false }) as CookieParam,
                });
            }
        } else if (setCookieHeaders && typeof setCookieHeaders === 'string') {
            cookies.push({
                ...parseSetCookieString(setCookieHeaders, { decodeValues: false }) as CookieParam,
            });
        }

        const proxyUrl = ctx.req.get('x-proxy-url');
        instance.proxyUrl ??= proxyUrl;

        return instance;
    }
}
