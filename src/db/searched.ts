import { singleton, container } from 'tsyringe';
import { Also, Prop, AutoCastable } from 'civkit/civ-rpc';
import _ from 'lodash';
import { ObjectId } from 'mongodb';
import { MongoCollection } from '../services/mongodb';

@Also({
    dictOf: Object
})
export class SearchResult extends AutoCastable {
    @Prop({
        defaultFactory: () => new ObjectId()
    })
    _id!: string;

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
}

@singleton()
export class SerperResultsCollection extends MongoCollection<SearchResult> {
    override collectionName = 'serperSearchResults';
    override typeclass = SearchResult;
}

@singleton()
export class SERPResultsCollection extends MongoCollection<SearchResult> {
    override collectionName = 'SERPResults';
    override typeclass = SearchResult;
}

const instance = container.resolve(SERPResultsCollection);

export default instance;