import { singleton, container } from 'tsyringe';
import { Also, AutoCastable, Prop } from 'civkit/civ-rpc';
import { ObjectId } from 'mongodb';
import { MongoCollection } from '../services/mongodb';

@Also({
    dictOf: Object
})
export class DomainBlockade extends AutoCastable {
    @Prop({
        defaultFactory: () => new ObjectId()
    })
    _id!: string;

    @Prop({
        required: true
    })
    domain!: string;

    @Prop({ required: true })
    triggerReason!: string;

    @Prop()
    triggerUrl?: string;

    @Prop()
    createdAt!: Date;

    @Prop()
    expireAt?: Date;

    [k: string]: any;
}


@singleton()
export class DomainBlockadeCollection extends MongoCollection<DomainBlockade> {
    override collectionName = 'domainBlockades';
    override typeclass = DomainBlockade;
}

const instance = container.resolve(DomainBlockadeCollection);

export default instance;