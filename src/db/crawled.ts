import { singleton, container } from 'tsyringe';
import { Also, AutoCastable, Prop } from 'civkit/civ-rpc';
import _ from 'lodash';
import type { PageSnapshot } from '../services/puppeteer';
import { MongoCollection } from '../services/mongodb';
import { ObjectId } from 'mongodb';

@Also({
    dictOf: Object
})
export class Crawled extends AutoCastable {
    @Prop({
        defaultFactory: () => new ObjectId()
    })
    _id!: ObjectId;

    @Prop({
        required: true
    })
    url!: string;

    @Prop({
        required: true
    })
    urlPathDigest!: string;

    @Prop()
    htmlSignificantlyModifiedByJs?: boolean;

    @Prop()
    snapshot?: PageSnapshot & { screenshot: never; pageshot: never; };

    @Prop()
    screenshotAvailable?: boolean;

    @Prop()
    pageshotAvailable?: boolean;

    @Prop()
    snapshotAvailable?: boolean;

    @Prop()
    createdAt!: Date;

    @Prop()
    expireAt!: Date;

    [k: string]: any;
}

@singleton()
export class PageCacheCollection extends MongoCollection<Crawled> {
    override collectionName = 'pageCaches';
    override typeclass = Crawled;
}

const instance = container.resolve(PageCacheCollection);

export default instance;