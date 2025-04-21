import { singleton, container } from 'tsyringe';
import { Also, AutoCastable, Prop } from 'civkit/civ-rpc';
import _ from 'lodash';
import { ObjectId } from 'mongodb';
import { MongoCollection } from '../services/mongodb';

@Also({
    dictOf: Object
})
export class PDFContent extends AutoCastable {

    @Prop({
        defaultFactory: () => new ObjectId()
    })
    _id!: ObjectId;

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

    [k: string]: any;
}


@singleton()
export class PDFContentCollection extends MongoCollection<PDFContent> {
    override collectionName = 'pdfs';
    override typeclass = PDFContent;
}

const instance = container.resolve(PDFContentCollection);

export default instance;