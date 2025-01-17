import { Also, Prop } from 'civkit';
import { FirestoreRecord } from '../shared/lib/firestore';
import { ENGINE_TYPE } from '../dto/scrapping-options';

@Also({
    dictOf: Object
})
export class DomainProfile extends FirestoreRecord {
    static override collectionName = 'domainProfiles';

    override _id!: string;

    @Prop({
        required: true
    })
    path!: string;

    @Prop()
    triggerUrl?: string;

    @Prop({ required: true, type: ENGINE_TYPE })
    engine!: string;

    @Prop()
    createdAt!: Date;

    @Prop()
    expireAt?: Date;

    [k: string]: any;
}
