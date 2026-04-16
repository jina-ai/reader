import { AsyncService } from 'civkit/async-service';
import { singleton } from 'tsyringe';
import { ConsecutiveError, Crawled, DomainBlockade, ImgAlt, IndexedPage, SERPResult } from './models';
import { Context } from '../services/registry';
import { RPCReflection } from 'civkit/civ-rpc';
// import { JinaEmbeddingsAuthDTO } from '../dto/jina-embeddings-auth';
import _ from 'lodash';
import type { PageSnapshot } from '../services/puppeteer';
import { WebSearchEntry } from '../services/serp/compat';
import { BaseAuthDTO } from '../dto/base-auth';

@singleton()
export class StorageLayer extends AsyncService {

    override async init() {
        await this.dependencyReady();

        this.emit('ready');
    }

    async findImageAlt(_query: Partial<ImgAlt>): Promise<ImgAlt | undefined> {
        return undefined;
    }

    async storeImageAlt(_draft: ImgAlt): Promise<unknown> {
        return undefined;
    }

    async findDomainBlockade(_query: Partial<DomainBlockade>): Promise<DomainBlockade | undefined> {
        return undefined;
    }

    async storeDomainBlockade(_draft: DomainBlockade): Promise<unknown> {
        return undefined;
    }


    async rateLimit(ctx: Context, _rpcReflect: RPCReflection, auth: BaseAuthDTO): Promise<{
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

    async findConsecutiveError(query: Partial<ConsecutiveError>): Promise<ConsecutiveError | undefined> {
        if (!query.count) {
            throw new Error('Count is required when finding consecutive error record');
        }

        return undefined;
    }

    async storeConsecutiveError(_draft: ConsecutiveError): Promise<unknown> {
        return undefined;
    }

    async clearConsecutiveError(draft: Partial<ConsecutiveError>): Promise<unknown> {
        if (!draft._id) {
            throw new Error('ID is required to clear consecutive error record');
        }
        return undefined;
    }

    async findPageCache(_query: Partial<Crawled>): Promise<Crawled | undefined> {
        return undefined;
    }

    async storePageCache(_draft: Crawled): Promise<unknown> {
        return undefined;
    }

    async clearPageCache(draft: Partial<Crawled>): Promise<unknown> {
        if (!draft._id) {
            throw new Error('ID is required to clear page cache record');
        }
        return undefined;
    }

    async indexSnapshot(_digest: string, _snapshot: PageSnapshot): Promise<unknown> {
        return undefined;
    }

    async indexWebSearchEntry(webSearchEntry: WebSearchEntry, additional?: Partial<IndexedPage>): Promise<unknown> {
        return undefined;
    }

    async searchLocalIndex(_query: string,
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

    async storeSERPResult(_draft: SERPResult): Promise<unknown> {
        return undefined;
    }

    async findSERPResult(_query: Partial<SERPResult>): Promise<SERPResult | undefined> {
        return undefined;
    }

    async storeFile(_path: string, _buffer: Buffer, _metadata?: Record<string, any>): Promise<unknown> {
        return undefined;
    }

    async readFile(_path: string): Promise<Buffer> {
        throw new Error('Not implemented');
    }

    async fileExists(_path: string): Promise<boolean> {
        return false;
    }

    async signDownloadUrl(_path: string, _expirySec?: number): Promise<string> {
        return '';
    }

}