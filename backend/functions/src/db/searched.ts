import { Also, parseJSONText, Prop } from 'civkit';
import { FirestoreRecord } from '../shared/lib/firestore';
import _ from 'lodash';

@Also({
    dictOf: Object
})
export class SearchResult extends FirestoreRecord {
    static override collectionName = 'searchResults';

    override _id!: string;

    @Prop({
        required: true
    })
    query!: any;

    @Prop({
        required: true
    })
    queryDigest!: string;

    @Prop()
    response?: any;

    @Prop()
    createdAt!: Date;

    @Prop()
    expireAt?: Date;

    [k: string]: any;

    static patchedFields = [
        'query',
        'response',
    ];

    static override from(input: any) {
        for (const field of this.patchedFields) {
            if (typeof input[field] === 'string') {
                input[field] = parseJSONText(input[field]);
            }
        }

        return super.from(input) as SearchResult;
    }

    override degradeForFireStore() {
        const copy: any = { ...this };

        for (const field of (this.constructor as typeof SearchResult).patchedFields) {
            if (typeof copy[field] === 'object') {
                copy[field] = JSON.stringify(copy[field]) as any;
            }
        }

        return copy;
    }
}
