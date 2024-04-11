import { Also, parseJSONText, Prop } from 'civkit';
import { FirestoreRecord } from '../shared/lib/firestore';
import _ from 'lodash';

@Also({
    dictOf: Object
})
export class Crawled extends FirestoreRecord {
    static override collectionName = 'crawled';

    override _id!: string;

    @Prop({
        required: true
    })
    url!: string;

    @Prop({
        required: true
    })
    urlPathDigest!: string;

    @Prop()
    snapshot!: any;

    @Prop()
    createdAt!: Date;

    @Prop()
    expireAt!: Date;

    static patchedFields = [
        'snapshot'
    ];

    static override from(input: any) {
        for (const field of this.patchedFields) {
            if (typeof input[field] === 'string') {
                input[field] = parseJSONText(input[field]);
            }
        }

        return super.from(input) as Crawled;
    }

    override degradeForFireStore() {
        const copy: any = { ...this };

        for (const field of (this.constructor as typeof Crawled).patchedFields) {
            if (typeof copy[field] === 'object') {
                copy[field] = JSON.stringify(copy[field]) as any;
            }
        }

        return copy;
    }

    [k: string]: any;
}
