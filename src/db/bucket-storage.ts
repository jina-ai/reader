import { singleton } from 'tsyringe';
import { ConsecutiveError, Crawled, DomainBlockade, ImgAlt, IndexedPage, SERPResult } from './models';
import { Context } from '../services/registry';
import { RPCReflection } from 'civkit/civ-rpc';
import { HashManager } from 'civkit/hash';
// import { JinaEmbeddingsAuthDTO } from '../dto/jina-embeddings-auth';
import _ from 'lodash';
import type { PageSnapshot } from '../services/puppeteer';
import { WebSearchEntry } from '../services/serp/compat';
import { StorageLayer } from './noop-storage';
import { DefaultBucket } from '../services/default-bucket';
import { BaseAuthDTO } from '../dto/base-auth';

const md5Hasher = new HashManager('md5', 'hex');

@singleton()
export class BucketStorageLayer extends StorageLayer {

    constructor(protected defaultBucket: DefaultBucket) {
        super(...arguments);
    }

    override async init() {
        await this.dependencyReady();

        this.emit('ready');
    }

    override async findImageAlt(query: Partial<ImgAlt>): Promise<ImgAlt | undefined> {
        const id = query.urlDigest || query._id;
        if (!id) {
            throw new Error('ID or URL digest is required when finding image alt text');
        }

        try {
            const buff = await this.defaultBucket.readSingleFile(`image-alts/${id}`);
            return ImgAlt.from(JSON.parse(buff.toString()));
        } catch (err) {
            return undefined;
        }
    }

    override async storeImageAlt(draft: ImgAlt): Promise<unknown> {
        const id = draft.urlDigest || draft._id;
        if (!id) {
            throw new Error('ID or URL digest is required when storing image alt text');
        }

        await this.defaultBucket.putBuffer(`image-alts/${id}`, Buffer.from(JSON.stringify(draft)), {
            contentType: 'application/json',
        });

        return undefined;
    }

    override async findDomainBlockade(query: Partial<DomainBlockade>): Promise<DomainBlockade | undefined> {
        const id = query.domain;
        if (!id) {
            throw new Error('ID or URL digest is required when finding domain blockade');
        }

        try {
            const buff = await this.defaultBucket.readSingleFile(`domain-blockade/${md5Hasher.hash(id.toString())}`);
            return DomainBlockade.from(JSON.parse(buff.toString()));
        } catch (err) {
            return undefined;
        }
    }

    override async storeDomainBlockade(draft: DomainBlockade): Promise<unknown> {
        const id = draft.domain;
        if (!id) {
            throw new Error('ID or URL digest is required when storing domain blockade');
        }

        await this.defaultBucket.putBuffer(`domain-blockade/${md5Hasher.hash(id.toString())}`, Buffer.from(JSON.stringify(draft)), {
            contentType: 'application/json',
        });

        return undefined;
    }


    override async rateLimit(ctx: Context, _rpcReflect: RPCReflection, auth: BaseAuthDTO): Promise<{
        isAnonymous: boolean;
        record: object;
        uid?: string;
        rateLimitPolicies?: object[];
        reportOptions?: (opts: object) => void;
        reportUsage?: (amount: number, desc?: string) => void;
    }> {
        const uid = await auth.solveUID();
        let isAnonymous = uid ? false : true;
        let reportOptions;
        let reportUsage;

        const apiRoll: Record<string, any> = {
            uid,
            ip: ctx.ip,
        };
        reportOptions = (opts: object) => apiRoll.crawlerOptions = opts;
        reportUsage = (amount: number, _desc?: string) => {
            apiRoll.chargeAmount = amount;
        };


        return {
            isAnonymous,
            record: apiRoll,
            uid,
            rateLimitPolicies: [],
            reportOptions,
            reportUsage,
        };
    }

    override async findConsecutiveError(query: Partial<ConsecutiveError>): Promise<ConsecutiveError | undefined> {
        if (!query.count) {
            throw new Error('Count is required when finding consecutive error record');
        }
        let id = query._id;
        if (!id && query.url) {
            id = md5Hasher.hash<string>(query.url.toLowerCase());
        }
        if (!id) {
            throw new Error('URL is required when finding consecutive error record');
        }
        try {
            const buff = await this.defaultBucket.readSingleFile(`consecutive-error/${id}`);
            const record = ConsecutiveError.from(JSON.parse(buff.toString()));

            if (record.count > query.count) {
                return record;
            }

            return undefined;
        } catch (err) {
            return undefined;
        }
    }

    override async storeConsecutiveError(draft: ConsecutiveError): Promise<unknown> {
        let id = draft._id;
        if (!id && draft.url) {
            id = md5Hasher.hash<string>(draft.url.toLowerCase());
        }
        if (!id) {
            throw new Error('URL is required when finding consecutive error record');
        }
        const r = await this.findConsecutiveError(draft);
        await this.defaultBucket.putBuffer(`consecutive-error/${id}`, Buffer.from(JSON.stringify({
            ...r, ...draft,
            count: (r?.count || 0) + draft.count
        })), {
            contentType: 'application/json',
        });

        return undefined;
    }

    override async clearConsecutiveError(draft: Partial<ConsecutiveError>): Promise<unknown> {
        let id = draft._id;
        if (!id && draft.url) {
            id = md5Hasher.hash<string>(draft.url.toLowerCase());
        }
        if (!id) {
            throw new Error('URL is required when clearing consecutive error record');
        }
        await this.defaultBucket.removeSingleFile(`consecutive-error/${id}`);

        return undefined;
    }

    override async findPageCache(query: Partial<Crawled>): Promise<Crawled | undefined> {
        const id = query.urlPathDigest || query._id;
        if (!id) {
            throw new Error('ID or URL digest is required when finding page cache record');
        }
        try {
            const buff = await this.defaultBucket.readSingleFile(`page-cache/${id}`);
            return Crawled.from(JSON.parse(buff.toString()));
        } catch (err) {
            return undefined;
        }
    }

    override async storePageCache(draft: Crawled): Promise<unknown> {
        const id = draft.urlPathDigest || draft._id;
        if (!id) {
            throw new Error('URL digest or id is required when storing page cache record');
        }
        await this.defaultBucket.putBuffer(`page-cache/${id}`, Buffer.from(JSON.stringify(draft)), {
            contentType: 'application/json',
        });
        return undefined;
    }

    override async clearPageCache(draft: Partial<Crawled>): Promise<unknown> {
        const id = draft.urlDigest || draft._id;
        if (!id) {
            throw new Error('URL digest or id is required when clearing page cache record');
        }
        await this.defaultBucket.removeSingleFile(`page-cache/${id}`);
        return undefined;
    }

    override async indexSnapshot(_digest: string, _snapshot: PageSnapshot): Promise<unknown> {
        return undefined;
    }

    override async indexWebSearchEntry(webSearchEntry: WebSearchEntry, additional?: Partial<IndexedPage>): Promise<unknown> {
        return undefined;
    }

    override async searchLocalIndex(_query: string,
        _options: {
            queryMixins?: { filter?: any[], should?: any[], must?: any[], mustNot?: any[]; };
            num?: number;
            lang?: string;
        } = {}
    ): Promise<{
        _id: string;
        title: string;
        url: string;
        domain: string;
        description?: string;
        publishedAt?: Date;
        highlights?: {
            path: string;
            texts: { value: string, type: string; }[];
            score: number;
        }[];
        score: number;
        seq: string;
    }[]> {
        return [];
    }

    override async storeSERPResult(draft: SERPResult): Promise<unknown> {
        const id = draft.queryDigest || draft._id;
        if (!id) {
            throw new Error('URL digest or id is required when storing SERP result');
        }
        await this.defaultBucket.putBuffer(`serp-results/${id}`, Buffer.from(JSON.stringify(draft)), {
            contentType: 'application/json',
        });
        return undefined;
    }

    override async findSERPResult(query: Partial<SERPResult>): Promise<SERPResult | undefined> {
        const id = query.queryDigest || query._id;
        if (!id) {
            throw new Error('ID or URL digest is required when finding SERP result');
        }
        try {
            const buff = await this.defaultBucket.readSingleFile(`serp-results/${id}`);
            return SERPResult.from(JSON.parse(buff.toString()));
        } catch (err) {
            return undefined;
        }
    }

    override async storeFile(path: string, buffer: Buffer, metadata?: Record<string, any>): Promise<unknown> {
        await this.defaultBucket.putBuffer(path, buffer, metadata);
        return undefined;
    }

    override async readFile(path: string): Promise<Buffer> {
        try {
            return await this.defaultBucket.readSingleFile(path);
        } catch (err) {
            throw new Error(`Failed to read file ${path}: ${err}`);
        }
    }

    override async fileExists(path: string): Promise<boolean> {
        try {
            await this.defaultBucket.getSingleFileStat(path);

            return true;
        } catch (_err) {
            return false;
        }
    }

    override async signDownloadUrl(path: string, expirySec?: number): Promise<string> {
        const url = await this.defaultBucket.signDownloadObject(path, expirySec);

        return url;
    }

}