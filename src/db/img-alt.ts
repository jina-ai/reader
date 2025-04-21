import { singleton, container } from 'tsyringe';
import { Also, AutoCastable, Prop } from 'civkit/civ-rpc';
import _ from 'lodash';
import { ObjectId } from 'mongodb';
import { MongoCollection } from '../services/mongodb';

@Also({
    dictOf: Object
})
export class ImgAlt extends AutoCastable {

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


@singleton()
export class ImageAltCollection extends MongoCollection<ImgAlt> {
    override collectionName = 'imageAlts';
    override typeclass = ImgAlt;
}

const instance = container.resolve(ImageAltCollection);

export default instance;