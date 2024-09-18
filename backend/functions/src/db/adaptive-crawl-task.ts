import { Also, Prop, parseJSONText } from 'civkit';
import { FirestoreRecord } from '../shared/lib/firestore';
import _ from 'lodash';

export enum AdaptiveCrawlTaskStatus {
    PENDING = 'pending',
    PROCESSING = 'processing',
    COMPLETED = 'completed',
    FAILED = 'failed',
}

@Also({
    dictOf: Object
})
export class AdaptiveCrawlTask extends FirestoreRecord {
    static override collectionName = 'adaptiveCrawlTasks';

    override _id!: string;

    @Prop({
        required: true
    })
    status!: AdaptiveCrawlTaskStatus;

    @Prop({
        required: true
    })
    statusText!: string;

    @Prop()
    meta!: {
        useSitemap: boolean;
        maxPages: number;
        targetUrl: string;
    };

    @Prop()
    urls!: string[];

    @Prop()
    processed!: {
        [url: string]: string;
    };

    @Prop()
    failed!: {
        [url: string]: any;
    };

    @Prop()
    createdAt!: Date;

    @Prop()
    finishedAt?: Date;

    @Prop()
    duration?: number;

    static patchedFields = [
        'meta',
    ];

    static override from(input: any) {
        for (const field of this.patchedFields) {
            if (typeof input[field] === 'string') {
                input[field] = parseJSONText(input[field]);
            }
        }

        return super.from(input) as AdaptiveCrawlTask;
    }

    override degradeForFireStore() {
        const copy: any = { ...this };

        for (const field of (this.constructor as typeof AdaptiveCrawlTask).patchedFields) {
            if (typeof copy[field] === 'object') {
                copy[field] = JSON.stringify(copy[field]) as any;
            }
        }

        return copy;
    }

    [k: string]: any;
}
