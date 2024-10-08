import {
    assignTransferProtocolMeta,
    HashManager,
    RPCHost, RPCReflection,
} from 'civkit';
import { singleton } from 'tsyringe';
import { CloudHTTPv2, CloudTaskV2, Ctx, FirebaseStorageBucketControl, Logger, Param, RPCReflect } from '../shared';
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
const removeURLHash = (url: string) => {
    try {
        const o = new URL(url);
        o.hash = '';
        return o.toString();
    } catch (e) {
        return url;
    }
}

@singleton()
export class AdaptiveCrawlerHost extends RPCHost {
    logger = this.globalLogger.child({ service: this.constructor.name });

    static readonly __singleCrawlQueueName = 'singleCrawlQueue';

    constructor(
        protected globalLogger: Logger,
        protected firebaseObjectStorage: FirebaseStorageBucketControl,
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
        const { useSitemap, maxPages } = adaptiveCrawlerOptions;

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

        const meta = {
            targetUrl: targetUrl.toString(),
            useSitemap,
            maxPages,
        };

        const digest = md5Hasher.hash(JSON.stringify(meta));
        const shortDigest = Buffer.from(digest, 'hex').toString('base64url');
        const existing = await AdaptiveCrawlTask.fromFirestore(shortDigest);

        if (existing) {
            return { taskId: shortDigest };
        }

        await AdaptiveCrawlTask.COLLECTION.doc(shortDigest).set({
            _id: shortDigest,
            status: AdaptiveCrawlTaskStatus.PENDING,
            statusText: 'Pending',
            meta,
            createdAt: new Date(),
            urls: [],
            processed: {},
            failed: {},
        });

        let urls: string[] = [];
        if (useSitemap) {
            urls = await this.crawlUrlsFromSitemap(targetUrl, maxPages);
        }

        if (urls.length > 0) {
            await AdaptiveCrawlTask.COLLECTION.doc(shortDigest).update({
                status: AdaptiveCrawlTaskStatus.PROCESSING,
                statusText: `Processing 0/${urls.length}`,
                urls,
            });

            const promises = [];
            for (const url of urls) {
                promises.push(getFunctions().taskQueue(AdaptiveCrawlerHost.__singleCrawlQueueName).enqueue({
                    shortDigest, url, token: auth.bearerToken, meta
                }, {
                    dispatchDeadlineSeconds: 1800,
                    uri: await getFunctionUrl(AdaptiveCrawlerHost.__singleCrawlQueueName),
                }));
            };

            await Promise.all(promises);
        } else {
            await AdaptiveCrawlTask.COLLECTION.doc(shortDigest).update({
                urls: [targetUrl.toString()],
            });

            await getFunctions().taskQueue(AdaptiveCrawlerHost.__singleCrawlQueueName).enqueue({
                shortDigest, url: targetUrl.toString(), token: auth.bearerToken, meta
            }, {
                dispatchDeadlineSeconds: 1800,
                uri: await getFunctionUrl(AdaptiveCrawlerHost.__singleCrawlQueueName),
            })
        }

        return { taskId: shortDigest };
    }

    @CloudHTTPv2({
        runtime: {
            memory: '1GiB',
            timeoutSeconds: 300,
            concurrency: 22,
        },
        tags: ['Crawler'],
        httpMethod: ['post', 'get'],
        returnType: AdaptiveCrawlTask,
    })
    async adaptiveCrawlStatus(
        @RPCReflect() rpcReflect: RPCReflection,
        @Ctx() ctx: {
            req: Request,
            res: Response,
        },
        auth: JinaEmbeddingsAuthDTO,
        @Param('taskId') taskId: string,
        @Param('urls') urls: string[] = [],
    ) {
        if (!taskId) {
            throw new Error('taskId is required');
        }

        const state = await AdaptiveCrawlTask.fromFirestore(taskId);

        if (urls.length) {
            const promises = Object.entries(state?.processed ?? {}).map(async ([url, cachePath]) => {
                if (urls.includes(url)) {
                    const raw = await this.firebaseObjectStorage.downloadFile(cachePath);
                    state!.processed[url] = JSON.parse(raw.toString('utf-8'));
                }
            });

            await Promise.all(promises);
        }


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
        }
    })
    async singleCrawlQueue(
        @Param('shortDigest') shortDigest: string,
        @Param('url') url: string,
        @Param('token') token: string,
        @Param('meta') meta: AdaptiveCrawlTask['meta'],
    ) {
        const error = {
            reason: ''
        };

        const state = await AdaptiveCrawlTask.fromFirestore(shortDigest);
        if (state?.status === AdaptiveCrawlTaskStatus.COMPLETED) {
            return;
        }

        try {
            url = removeURLHash(url);
        } catch(e) {
            error.reason = `Failed to parse url: ${url}`;
        }

        this.logger.debug(shortDigest, url, meta);
        const cachePath = `adaptive-crawl-task/${shortDigest}/${md5Hasher.hash(url)}`;

        if (!error.reason) {
            const result = meta.useSitemap
                ? await this.handleSingleCrawl(shortDigest, url, token, cachePath)
                : await this.handleSingleCrawlRecursively(shortDigest, url, token, meta, cachePath);

            if (!result) {
                return;
            }

            error.reason = result.error.reason;
        }

        await AdaptiveCrawlTask.DB.runTransaction(async (transaction) => {
            const ref = AdaptiveCrawlTask.COLLECTION.doc(shortDigest);
            const state = await transaction.get(ref);
            const data = state.data() as AdaptiveCrawlTask & { createdAt: Timestamp };

            if (error.reason) {
                data.failed[url] = error;
            } else {
                data.processed[url] = cachePath;
            }

            const status = Object.keys(data.processed).length + Object.keys(data.failed).length >= data.urls.length
                ? AdaptiveCrawlTaskStatus.COMPLETED : AdaptiveCrawlTaskStatus.PROCESSING;
            const statusText = Object.keys(data.processed).length + Object.keys(data.failed).length >= data.urls.length
                ? `Completed ${Object.keys(data.processed).length} Succeeded, ${Object.keys(data.failed).length} Failed`
                : `Processing ${Object.keys(data.processed).length + Object.keys(data.failed).length}/${data.urls.length}`;

            const payload: Partial<AdaptiveCrawlTask> = {
                status,
                statusText,
                processed: data.processed,
                failed: data.failed,
            };

            if (status === AdaptiveCrawlTaskStatus.COMPLETED) {
                payload.finishedAt = new Date();
                payload.duration = new Date().getTime() - data.createdAt.toDate().getTime();
            }

            transaction.update(ref, payload);
        });
    }

    async handleSingleCrawl(shortDigest: string, url: string, token: string, cachePath: string) {
        const error = {
            reason: ''
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
            error.reason = `Failed to crawl ${url}, ${response.statusText}`;
        } else {
            const json = await response.json();

            await this.firebaseObjectStorage.saveFile(cachePath,
                Buffer.from(
                    JSON.stringify(json),
                    'utf-8'
                ),
                {
                    metadata: {
                        contentType: 'application/json',
                    }
                }
            )
        }

        return {
            error,
        }
    }

    async handleSingleCrawlRecursively(
        shortDigest: string, url: string, token: string, meta: AdaptiveCrawlTask['meta'], cachePath: string
    ) {
        const error = {
            reason: ''
        }
        const response = await fetch('https://r.jina.ai', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`,
                'Accept': 'application/json',
                'X-With-Links-Summary': 'true',
            },
            body: JSON.stringify({ url })
        });

        if (!response.ok) {
            error.reason = `Failed to crawl ${url}, ${response.statusText}`;
        } else {
            const json = await response.json();
            await this.firebaseObjectStorage.saveFile(cachePath,
                Buffer.from(
                    JSON.stringify(json),
                    'utf-8'
                ),
                {
                    metadata: {
                        contentType: 'application/json',
                    }
                }
            )

            const title = json.data.title;
            const description = json.data.description;
            const rerankQuery = `TITLE: ${title}; DESCRIPTION: ${description}`;
            const links = json.data.links as Record<string, string>;

            const relevantUrls = await this.getRelevantUrls(token, { query: rerankQuery, links });
            this.logger.debug(`Total urls: ${Object.keys(links).length}, relevant urls: ${relevantUrls.length}`);

            for (const url of relevantUrls) {
                let abortContinue = false;
                let abortBreak = false;
                await AdaptiveCrawlTask.DB.runTransaction(async (transaction) => {
                    const ref = AdaptiveCrawlTask.COLLECTION.doc(shortDigest);
                    const state = await transaction.get(ref);
                    const data = state.data() as AdaptiveCrawlTask & { createdAt: Timestamp };

                    if (data.urls.includes(url)) {
                        this.logger.debug('Recursive CONTINUE', data);
                        abortContinue = true;
                        return;
                    }

                    const urls = [
                        ...data.urls,
                        url
                    ];

                    if (urls.length > meta.maxPages || data.status === AdaptiveCrawlTaskStatus.COMPLETED) {
                        this.logger.debug('Recursive BREAK', data);
                        abortBreak = true;
                        return;
                    }

                    transaction.update(ref, { urls });
                });

                if (abortContinue) {
                    continue;
                }
                if (abortBreak) {
                    break;
                }

                await getFunctions().taskQueue(AdaptiveCrawlerHost.__singleCrawlQueueName).enqueue({
                    shortDigest, url, token, meta
                }, {
                    dispatchDeadlineSeconds: 1800,
                    uri: await getFunctionUrl(AdaptiveCrawlerHost.__singleCrawlQueueName),
                });
            };
        }

        return {
            error,
        }
    }

    async getRelevantUrls(token: string, {
        query, links
    }: {
        query: string;
        links: Record<string, string>;
    }) {
        const invalidSuffix = [
            '.zip',
            '.docx',
            '.pptx',
            '.xlsx',
        ];

        const validLinks = Object.entries(links)
            .map(([title, link]) => link)
            .filter(link => link.startsWith('http') && !invalidSuffix.some(suffix => link.endsWith(suffix)));

        const data = {
            model: 'jina-reranker-v2-base-multilingual',
            query,
            top_n: 15,
            documents: validLinks,
        };

        const response = await fetch('https://api.jina.ai/v1/rerank', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify(data)
        });

        const json = (await response.json()) as {
            results: {
                index: number;
                document: {
                    text: string;
                };
                relevance_score: number;
            }[];
        };

        return json.results.filter(r => r.relevance_score > 0.3).map(r => removeURLHash(r.document.text));
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

    async crawlUrlsFromSitemap(url: URL, maxPages: number) {
        const sitemapsFromRobotsTxt = await this.getSitemapsFromRobotsTxt(url);

        const initialSitemaps: string[] = [];
        if (sitemapsFromRobotsTxt === null) {
            initialSitemaps.push(`${url.origin}/sitemap.xml`);
        } else {
            initialSitemaps.push(...sitemapsFromRobotsTxt);
        }


        const allUrls: Set<string> = new Set();
        const processedSitemaps: Set<string> = new Set();

        const fetchSitemapUrls = async (sitemapUrl: string) => {
            sitemapUrl = sitemapUrl.trim();

            if (processedSitemaps.has(sitemapUrl)) {
                return;
            }

            processedSitemaps.add(sitemapUrl);

            try {
                const response = await fetch(sitemapUrl);
                const sitemapContent = await response.text();
                const parser = new DOMParser();
                const xmlDoc = parser.parseFromString(sitemapContent, 'text/xml');

                // handle normal sitemap
                const urlElements = xmlDoc.getElementsByTagName('url');
                for (let i = 0; i < urlElements.length; i++) {
                    const locElement = urlElements[i].getElementsByTagName('loc')[0];
                    if (locElement) {
                        const loc = locElement.textContent?.trim() || '';
                        if (loc.startsWith(url.origin) && !loc.endsWith('.xml')) {
                            allUrls.add(removeURLHash(loc));
                        }
                        if (allUrls.size >= maxPages) {
                            return;
                        }
                    }
                }

                // handle sitemap index
                const sitemapElements = xmlDoc.getElementsByTagName('sitemap');
                for (let i = 0; i < sitemapElements.length; i++) {
                    const locElement = sitemapElements[i].getElementsByTagName('loc')[0];
                    if (locElement) {
                        await fetchSitemapUrls(locElement.textContent?.trim() || '');
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
