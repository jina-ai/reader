import { Also, Prop, parseJSONText } from 'civkit';
import { FirestoreRecord } from '../shared/lib/firestore';
import _ from 'lodash';

export enum GreedyCrawlStateStatus {
    PENDING = 'pending',
    PROCESSING = 'processing',
    COMPLETED = 'completed',
    FAILED = 'failed',
}

@Also({
    dictOf: Object
})
export class GreedyCrawlState extends FirestoreRecord {
    static override collectionName = 'greedyCrawlStates';

    override _id!: string;

    @Prop({
        required: true
    })
    status!: GreedyCrawlStateStatus;

    @Prop({
        required: true
    })
    statusText!: string;

    @Prop()
    meta?: { [k: string]: any; };

    @Prop()
    urls!: string[];

    @Prop()
    processed!: string[];

    @Prop()
    createdAt!: Date;

    static patchedFields = [
        'meta'
    ];

    static override from(input: any) {
        for (const field of this.patchedFields) {
            if (typeof input[field] === 'string') {
                input[field] = parseJSONText(input[field]);
            }
        }

        return super.from(input) as GreedyCrawlState;
    }

    override degradeForFireStore() {
        const copy: any = { ...this };

        for (const field of (this.constructor as typeof GreedyCrawlState).patchedFields) {
            if (typeof copy[field] === 'object') {
                copy[field] = JSON.stringify(copy[field]) as any;
            }
        }

        return copy;
    }

    [k: string]: any;
}
