import {
    assignTransferProtocolMeta,
    HashManager,
    RPCHost, RPCReflection,
} from 'civkit';
import { singleton } from 'tsyringe';
import { CloudHTTPv2, CloudTaskV2, Ctx, Logger, Param, RPCReflect } from '../shared';
import _ from 'lodash';
import { Request, Response } from 'express';
import { JinaEmbeddingsAuthDTO } from '../shared/dto/jina-embeddings-auth';
import robotsParser from 'robots-parser';
import { DOMParser } from 'xmldom';

import { AdaptiveCrawlerOptions } from '../dto/adaptive-crawler-options';
import { CrawlerOptions } from '../dto/scrapping-options';
import { JinaEmbeddingsTokenAccount } from '../shared/db/jina-embeddings-token-account';
import { AdaptiveCrawlTask, AdaptiveCrawlTaskStatus } from '../db/adaptive-crawl-task';
import { getFunctions } from 'firebase-admin/functions';
import { getFunctionUrl } from '../utils/get-function-url';
import { Timestamp } from 'firebase-admin/firestore';

const md5Hasher = new HashManager('md5', 'hex');

@singleton()
export class AdaptiveCrawlerHost extends RPCHost {
    logger = this.globalLogger.child({ service: this.constructor.name });

    static readonly __singleCrawlQueueName = 'singleCrawlQueue';

    constructor(
        protected globalLogger: Logger,
    ) {
        super(...arguments);
    }

    override async init() {
        await this.dependencyReady();

        this.emit('ready');
    }

    @CloudHTTPv2({
        runtime: {
            memory: '1GiB',
            timeoutSeconds: 300,
            concurrency: 22,
        },
        tags: ['Crawler'],
        httpMethod: ['post', 'get'],
        returnType: [String],
    })
    async adaptiveCrawl(
        @RPCReflect() rpcReflect: RPCReflection,
        @Ctx() ctx: {
            req: Request,
            res: Response,
        },
        auth: JinaEmbeddingsAuthDTO,
        crawlerOptions: CrawlerOptions,
        adaptiveCrawlerOptions: AdaptiveCrawlerOptions,
    ) {
        this.logger.debug({
            adaptiveCrawlerOptions,
            crawlerOptions,
        });


        const uid = await auth.solveUID();
        const { useSitemap, maxDepth, maxPages } = adaptiveCrawlerOptions;

        let tmpUrl = ctx.req.url.slice(1)?.trim();
        if (!tmpUrl) {
            tmpUrl = crawlerOptions.url?.trim() ?? '';
        }
        const targetUrl = new URL(tmpUrl);

        if (!targetUrl) {
            const latestUser = uid ? await auth.assertUser() : undefined;
            if (!ctx.req.accepts('text/plain') && (ctx.req.accepts('text/json') || ctx.req.accepts('application/json'))) {
                return this.getIndex(latestUser);
            }

            return assignTransferProtocolMeta(`${this.getIndex(latestUser)}`,
                { contentType: 'text/plain', envelope: null }
            );
        }

        const digest = md5Hasher.hash(targetUrl.toString());
        const shortDigest = Buffer.from(digest, 'hex').toString('base64url');
        const existing = await AdaptiveCrawlTask.fromFirestore(shortDigest);

        if (existing) {
            return { taskId: shortDigest };
        }

        await AdaptiveCrawlTask.COLLECTION.doc(shortDigest).set({
            _id: shortDigest,
            status: AdaptiveCrawlTaskStatus.PENDING,
            statusText: 'Pending',
            meta: {
                targetUrl: targetUrl.toString(),
                useSitemap,
                maxDepth,
                maxPages,
            },
            createdAt: new Date(),
            urls: [],
            processed: [],
        });

        if (useSitemap) {
            const urls = await this.crawlBySitemap(targetUrl, maxDepth, maxPages);

            await AdaptiveCrawlTask.COLLECTION.doc(shortDigest).update({
                status: AdaptiveCrawlTaskStatus.PROCESSING,
                statusText: `Processing 0/${urls.length}`,
                urls,
            });

            const promises = [];
            for (const url of urls) {
                promises.push(getFunctions().taskQueue(AdaptiveCrawlerHost.__singleCrawlQueueName).enqueue({
                    shortDigest, url, token: auth.bearerToken
                }, {
                    dispatchDeadlineSeconds: 1800,
                    uri: await getFunctionUrl(AdaptiveCrawlerHost.__singleCrawlQueueName),
                }));
            };

            await Promise.all(promises);

            return { taskId: shortDigest };
        } else {
            // TODO:
            return this.crawlByRecursion(targetUrl, maxDepth, maxPages);
        }
    }

    @CloudHTTPv2({
        runtime: {
            memory: '1GiB',
            timeoutSeconds: 300,
            concurrency: 22,
        },
        tags: ['Crawler'],
        httpMethod: ['post', 'get'],
        returnType: [String],
    })
    async adaptiveCrawlStatus(
        @RPCReflect() rpcReflect: RPCReflection,
        @Ctx() ctx: {
            req: Request,
            res: Response,
        },
        auth: JinaEmbeddingsAuthDTO,
        @Param('taskId') taskId: string
    ) {
        if (!taskId) {
            throw new Error('taskId is required');
        }

        const state = await AdaptiveCrawlTask.fromFirestore(taskId);

        return state;
    }

    @CloudTaskV2({
        name: AdaptiveCrawlerHost.__singleCrawlQueueName,
        runtime: {
            cpu: 1,
            memory: '1GiB',
            timeoutSeconds: 3600,
            concurrency: 2,
            maxInstances: 200,
            retryConfig: {
                maxAttempts: 3,
                minBackoffSeconds: 60,
            },
            rateLimits: {
                maxConcurrentDispatches: 150,
                maxDispatchesPerSecond: 5,
            },
        },
    })
    async singleCrawlQueue(
        @Param('shortDigest') shortDigest: string,
        @Param('url') url: string,
        @Param('token') token: string,
    ) {
        this.logger.debug(shortDigest, url);
        const state = await AdaptiveCrawlTask.fromFirestore(shortDigest);
        if (state?.status === AdaptiveCrawlTaskStatus.COMPLETED) {
            return 'ok';
        }

        const response = await fetch('https://r.jina.ai', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`,
                'Accept': 'application/json',
            },
            body: JSON.stringify({ url })
        })

        if (!response.ok) {
            throw new Error(`Failed to crawl ${url}, ${response.statusText}`);
        }

        const json = await response.json();

        await AdaptiveCrawlTask.DB.runTransaction(async (transaction) => {
            const ref = AdaptiveCrawlTask.COLLECTION.doc(shortDigest);
            const state = await transaction.get(ref);
            const data = state.data() as AdaptiveCrawlTask & { createdAt: Timestamp };

            const processed = [
                ...data.processed,
                { [url]: json }
            ];

            const status = processed.length >= data.urls.length ? AdaptiveCrawlTaskStatus.COMPLETED : AdaptiveCrawlTaskStatus.PROCESSING;
            const statusText = processed.length >= data.urls.length ? 'Completed' : `Processing ${processed.length}/${data.urls.length}`;

            const payload: Partial<AdaptiveCrawlTask> = {
                status,
                statusText,
                processed
            };

            if (status === AdaptiveCrawlTaskStatus.COMPLETED) {
                payload.finishedAt = new Date();
                payload.duration = new Date().getTime() - data.createdAt.toDate().getTime();
            }

            transaction.update(ref, payload);
        });


        return 'ok';
    }

    getIndex(user?: JinaEmbeddingsTokenAccount) {
        // TODO: 需要更新使用方式
        // const indexObject: Record<string, string | number | undefined> = Object.create(indexProto);

        // Object.assign(indexObject, {
        //     usage1: 'https://r.jina.ai/YOUR_URL',
        //     usage2: 'https://s.jina.ai/YOUR_SEARCH_QUERY',
        //     homepage: 'https://jina.ai/reader',
        //     sourceCode: 'https://github.com/jina-ai/reader',
        // });

        // if (user) {
        //     indexObject[''] = undefined;
        //     indexObject.authenticatedAs = `${user.user_id} (${user.full_name})`;
        //     indexObject.balanceLeft = user.wallet.total_balance;
        // }

        // return indexObject;
    }

    async crawlBySitemap(url: URL, maxDepth: number, maxPages: number) {
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
            if (currentDepth > maxDepth || processedSitemaps.has(sitemapUrl)) {
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
                        if (allUrls.size >= maxPages) {
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
                        if (allUrls.size >= maxPages) {
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
            if (allUrls.size >= maxPages) {
                break;
            }
        }

        const urlsToProcess = Array.from(allUrls).slice(0, maxPages);

        return urlsToProcess;
    }

    async crawlByRecursion(url: URL, maxDepth: number, maxPages: number) {
        // TODO:
        // 1. 获取当前 url 的内容，并解析出所有链接
        // 2. 递归获取所有链接的内容，并设置终止条件
        // 3. 将所有链接的内容存储到数据库中
        throw new Error('Not implemented');
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
