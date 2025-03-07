import { Also, Prop } from 'civkit';
import { FirestoreRecord } from '../shared/lib/firestore';
import _ from 'lodash';

@Also({
    dictOf: Object
})
export class ImgAlt extends FirestoreRecord {
    static override collectionName = 'imgAlts';

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
    width?: number;

    @Prop()
    height?: number;

    @Prop()
    generatedAlt?: string;

    @Prop()
    originalAlt?: string;

    @Prop()
    createdAt!: Date;

    @Prop()
    expireAt?: Date;

    [k: string]: any;
}
