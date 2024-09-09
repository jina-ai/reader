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
                'X-Max-Depth': {
                    description: 'Max deep level to crawl.',
                    in: 'header',
                    schema: { type: 'string' }
                },
                'X-Max-Pages': {
                    description: 'Max number of pages to crawl.',
                    in: 'header',
                    schema: { type: 'string' }
                },
            }
        }
    }
})
export class AdaptiveCrawlerOptions extends AutoCastable {
    @Prop({
        default: true,
        desc: 'Use sitemap to crawl the website.',
    })
    useSitemap!: boolean;

    @Prop({
        default: 2,
        desc: 'Max depth to crawl.',
        validate: (v: number) => v >= 0 && v <= 5,
    })
    maxDepth!: number;

    @Prop({
        default: 10,
        desc: 'Max number of pages to crawl.',
        validate: (v: number) => v >= 0 && v <= 100,
    })
    maxPages!: number;

    static override from(input: any) {
        const instance = super.from(input) as AdaptiveCrawlerOptions;
        const ctx = Reflect.get(input, RPC_CALL_ENVIRONMENT) as {
            req: Request,
            res: Response,
        } | undefined;

        let maxDepth = parseInt(ctx?.req.get('x-max-depth') || '');
        if (!isNaN(maxDepth) && maxDepth > 0) {
            instance.maxDepth = maxDepth <= 2 ? maxDepth : 2;
        }

        let maxPages = parseInt(ctx?.req.get('x-max-pages') || '');
        if (!isNaN(maxPages) && maxPages > 0) {
            instance.maxPages = maxPages <= 100 ? maxPages : 100;
        }

        const useSitemap = ctx?.req.get('x-use-sitemap');
        if (useSitemap !== undefined) {
            instance.useSitemap = Boolean(useSitemap);
        } else {
            instance.useSitemap = true;
        }

        return instance;
    }
}
