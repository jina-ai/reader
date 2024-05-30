import { Also, Prop, parseJSONText } from 'civkit';
import { FirestoreRecord } from '../shared/lib/firestore';
import _ from 'lodash';

@Also({
    dictOf: Object
})
export class PDFContent extends FirestoreRecord {
    static override collectionName = 'pdfs';

    override _id!: string;

    @Prop({
        required: true
    })
    src!: string;

    @Prop({
        required: true
    })
    urlDigest!: string;

    @Prop()
    meta?: { [k: string]: any; };

    @Prop()
    text?: string;

    @Prop()
    content?: string;

    @Prop()
    createdAt!: Date;

    @Prop()
    expireAt?: Date;

    static patchedFields = [
        'meta'
    ];

    static override from(input: any) {
        for (const field of this.patchedFields) {
            if (typeof input[field] === 'string') {
                input[field] = parseJSONText(input[field]);
            }
        }

        return super.from(input) as PDFContent;
    }

    override degradeForFireStore() {
        const copy: any = { ...this };

        for (const field of (this.constructor as typeof PDFContent).patchedFields) {
            if (typeof copy[field] === 'object') {
                copy[field] = JSON.stringify(copy[field]) as any;
            }
        }

        return copy;
    }

    [k: string]: any;
}
