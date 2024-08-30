import { Also, AutoCastable, Prop, RPC_CALL_ENVIRONMENT } from 'civkit';
import type { Request, Response } from 'express';


@Also({
    openapi: {
        operation: {
            parameters: {
                'X-Use-Sitemap': {
                    description: 'Use sitemap to crawl the website.',
                    in: 'header',
                    schema: { type: 'string' }
                },
                'X-Deep-Level': {
                    description: 'Max deep level to crawl.',
                    in: 'header',
                    schema: { type: 'string' }
                },
                'X-Max-Page-Count': {
                    description: 'Max number of pages to crawl.',
                    in: 'header',
                    schema: { type: 'string' }
                },
            }
        }
    }
})
export class GreedyCrawlerOptions extends AutoCastable {
    @Prop({
        default: false,
        desc: 'Use sitemap to crawl the website.',
    })
    useSitemap?: boolean;

    @Prop({
        default: 5,
        desc: 'Max deep level to crawl.',
        validate: (v: number) => v >= 0 && v <= 10,
    })
    deepLevel?: number;

    @Prop({
        default: 10,
        desc: 'Max number of pages to crawl.',
        validate: (v: number) => v >= 0 && v <= 1000,
    })
    maxPageCount?: number;

    static override from(input: any) {
        const instance = super.from(input) as GreedyCrawlerOptions;
        const ctx = Reflect.get(input, RPC_CALL_ENVIRONMENT) as {
            req: Request,
            res: Response,
        } | undefined;

        let deepLevel = parseInt(ctx?.req.get('x-deep-level') || '');
        if (!isNaN(deepLevel) && deepLevel > 0) {
            instance.deepLevel = deepLevel <= 10 ? deepLevel : 10;
        } else {
            instance.deepLevel = 5;
        }

        let maxPageCount = parseInt(ctx?.req.get('x-max-page-count') || '');
        if (!isNaN(maxPageCount) && maxPageCount > 0) {
            instance.maxPageCount = maxPageCount <= 1000 ? maxPageCount : 1000;
        } else {
            instance.maxPageCount = 10;
        }

        const useSitemap = ctx?.req.get('x-use-sitemap');
        if (useSitemap !== undefined) {
            instance.useSitemap = Boolean(useSitemap);
        }

        return instance;
    }
}
