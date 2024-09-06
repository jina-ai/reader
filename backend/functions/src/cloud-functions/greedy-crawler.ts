import {
    assignTransferProtocolMeta,
    RPCHost, RPCReflection,
} from 'civkit';
import { singleton } from 'tsyringe';
import { AsyncContext, CloudHTTPv2, Ctx, Logger, RPCReflect } from '../shared';
import { RateLimitControl } from '../shared/services/rate-limit';
import _ from 'lodash';
import { Request, Response } from 'express';
import { JinaEmbeddingsAuthDTO } from '../shared/dto/jina-embeddings-auth';
import robotsParser from 'robots-parser';
import { DOMParser } from 'xmldom';

import { FirebaseRoundTripChecker } from '../shared/services/firebase-roundtrip-checker';
import { CrawlerHost, indexProto } from './crawler';
import { GreedyCrawlerOptions } from '../dto/greedy-options';
import { CrawlerOptions } from '../dto/scrapping-options';
import { JinaEmbeddingsTokenAccount } from '../shared/db/jina-embeddings-token-account';

@singleton()
export class GreedyCrawlerHost extends RPCHost {
    logger = this.globalLogger.child({ service: this.constructor.name });

    constructor(
        protected globalLogger: Logger,
        protected rateLimitControl: RateLimitControl,
        protected threadLocal: AsyncContext,
        protected fbHealthCheck: FirebaseRoundTripChecker,
        protected crawler: CrawlerHost,
    ) {
        super(...arguments);
    }

    override async init() {
        await this.dependencyReady();

        this.emit('ready');
    }

    @CloudHTTPv2({
        runtime: {
            memory: '4GiB',
            timeoutSeconds: 300,
            concurrency: 22,
        },
        tags: ['Crawler'],
        httpMethod: ['post', 'get'],
        returnType: [String],
        exposeRoot: true,
    })
    async greedyCrawl(
        @RPCReflect() rpcReflect: RPCReflection,
        @Ctx() ctx: {
            req: Request,
            res: Response,
        },
        auth: JinaEmbeddingsAuthDTO,
        crawlerOptions: CrawlerOptions,
        greedyCrawlerOptions: GreedyCrawlerOptions,
    ) {
        this.logger.info({
            greedyCrawlerOptions,
            crawlerOptions,
        });


        const uid = await auth.solveUID();
        const { useSitemap, deepLevel, maxPageCount } = greedyCrawlerOptions;
        const targetUrl = await this.crawler.getTargetUrl(ctx.req.url, crawlerOptions);

        if (!targetUrl) {
            const latestUser = uid ? await auth.assertUser() : undefined;
            if (!ctx.req.accepts('text/plain') && (ctx.req.accepts('text/json') || ctx.req.accepts('application/json'))) {
                return this.getIndex(latestUser);
            }

            return assignTransferProtocolMeta(`${this.getIndex(latestUser)}`,
                { contentType: 'text/plain', envelope: null }
            );
        }

        if (useSitemap) {
            return this.crawlBySitemap(targetUrl, deepLevel, maxPageCount);
        } else {
            return this.crawlByRecursion(targetUrl, deepLevel, maxPageCount);
        }
    }

    getIndex(user?: JinaEmbeddingsTokenAccount) {
        // TODO: 需要更新使用方式
        const indexObject: Record<string, string | number | undefined> = Object.create(indexProto);

        Object.assign(indexObject, {
            usage1: 'https://r.jina.ai/YOUR_URL',
            usage2: 'https://s.jina.ai/YOUR_SEARCH_QUERY',
            homepage: 'https://jina.ai/reader',
            sourceCode: 'https://github.com/jina-ai/reader',
        });

        if (user) {
            indexObject[''] = undefined;
            indexObject.authenticatedAs = `${user.user_id} (${user.full_name})`;
            indexObject.balanceLeft = user.wallet.total_balance;
        }

        return indexObject;
    }

    async crawlBySitemap(url: URL, deepLevel: number, maxPageCount: number) {
        const sitemapsFromRobotsTxt = await this.getSitemapsFromRobotsTxt(url);
        // 4. 获取 sitemap.xml 中的所有链接
        const initialSitemaps: string[] = [];
        if (sitemapsFromRobotsTxt === null) {
            initialSitemaps.push(`${url.origin}/sitemap.xml`);
        } else {
            initialSitemaps.push(...sitemapsFromRobotsTxt);
        }

        // 递归获取sitemap中的所有URL
        const allUrls: Set<string> = new Set();
        const processedSitemaps: Set<string> = new Set();

        const fetchSitemapUrls = async (sitemapUrl: string, currentDepth: number = 0) => {
            if (currentDepth > deepLevel || processedSitemaps.has(sitemapUrl)) {
                return;
            }

            processedSitemaps.add(sitemapUrl);

            try {
                const response = await fetch(sitemapUrl);
                const sitemapContent = await response.text();
                const parser = new DOMParser();
                const xmlDoc = parser.parseFromString(sitemapContent, "text/xml");

                // handle normal sitemap
                const urlElements = xmlDoc.getElementsByTagName("url");
                for (let i = 0; i < urlElements.length; i++) {
                    const locElement = urlElements[i].getElementsByTagName("loc")[0];
                    if (locElement) {
                        allUrls.add(locElement.textContent || "");
                        if (allUrls.size >= maxPageCount) {
                            return;
                        }
                    }
                }

                // handle sitemap index
                const sitemapElements = xmlDoc.getElementsByTagName("sitemap");
                for (let i = 0; i < sitemapElements.length; i++) {
                    const locElement = sitemapElements[i].getElementsByTagName("loc")[0];
                    if (locElement) {
                        await fetchSitemapUrls(locElement.textContent || "", currentDepth + 1);
                        if (allUrls.size >= maxPageCount) {
                            return;
                        }
                    }
                }
            } catch (error) {
                this.logger.error(`Error fetching sitemap ${sitemapUrl}:`, error);
            }
        };

        for (const sitemapUrl of initialSitemaps) {
            await fetchSitemapUrls(sitemapUrl);
            if (allUrls.size >= maxPageCount) {
                break;
            }
        }

        const urlsToProcess = Array.from(allUrls).slice(0, maxPageCount);

        return urlsToProcess;
    }

    async crawlByRecursion(url: URL, deepLevel: number, maxPageCount: number) {
        // TODO:
        // 1. 获取当前 url 的内容，并解析出所有链接
        // 2. 递归获取所有链接的内容，并设置终止条件
        // 3. 将所有链接的内容存储到数据库中
    }

    async getSitemapsFromRobotsTxt(url: URL) {
        const hostname = url.origin;
        const robotsUrl = `${hostname}/robots.txt`;
        const response = await fetch(robotsUrl);
        if (response.status === 404) {
            return null;
        }
        const robotsTxt = await response.text();
        if (robotsTxt.length) {
            const robot = robotsParser(robotsUrl, robotsTxt);
            return robot.getSitemaps();
        }

        return null;
    }
}
