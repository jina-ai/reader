import { Also, Prop } from 'civkit';
import { FirestoreRecord } from '../shared/lib/firestore';

@Also({
    dictOf: Object
})
export class DomainProfile extends FirestoreRecord {
    static override collectionName = 'domainProfiles';

    override _id!: string;

    @Prop({
        required: true
    })
    domain!: string;

    @Prop({ required: true })
    triggerReason!: string;

    @Prop()
    triggerUrl?: string;

    @Prop({ required: true })
    engine: string;

    @Prop()
    createdAt!: Date;

    @Prop()
    expireAt?: Date;

    [k: string]: any;
}
