import { Also, AutoCastable, Prop } from 'civkit/civ-rpc';
import type { PageSnapshot } from '../services/puppeteer';
import { UUID } from 'bson';

@Also({
    dictOf: Object
})
export class ConsecutiveError extends AutoCastable {
    @Prop({
        required: true,
    })
    _id!: string;

    @Prop({
        required: true
    })
    url!: string;

    @Prop({
        required: true,
        default: 0,
    })
    count!: number;

    @Prop()
    lastError?: string;

    @Prop()
    createdAt!: Date;
    @Prop()
    updatedAt!: Date;

    @Prop()
    expireAt?: Date;

    [k: string]: any;
}

@Also({
    dictOf: Object
})
export class Crawled extends AutoCastable {
    @Prop({
        required: true
    })
    _id!: string;

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
    coerced?: boolean;

    @Prop({ arrayOf: String })
    traits?: string[];

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


@Also({
    dictOf: Object
})
export class DomainBlockade extends AutoCastable {
    @Prop({
        defaultFactory: () => new UUID()
    })
    _id!: UUID;

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

@Also({
    dictOf: Object
})
export class ImgAlt extends AutoCastable {

    @Prop({
        required: true,
    })
    _id!: string;

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


export class IndexedPage extends AutoCastable {
    @Prop({ required: true })
    _id!: string;

    @Prop({ required: true })
    url!: string;

    @Prop({ required: true })
    urlPathDigest!: string;

    @Prop({ required: true })
    domain!: string;
    @Prop({ required: true })
    tld!: string;
    @Prop()
    language?: string;
    @Prop()
    geolocation?: string;

    @Prop()
    title?: string;
    @Prop()
    description?: string;
    @Prop()
    text?: Record<string, string>;

    @Prop()
    semanticText?: string;

    @Prop()
    createdAt!: Date;
    @Prop()
    publishedAt?: Date;
    @Prop()
    scrappedAt?: Date;

    @Prop()
    expireAt!: Date;

    [k: string]: any;
}


@Also({
    dictOf: Object
})
export class PDFContent extends AutoCastable {

    @Prop({
        required: true
    })
    _id!: string;

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


@Also({
    dictOf: Object
})
export class SERPResult extends AutoCastable {
    @Prop({
        defaultFactory: () => new UUID()
    })
    _id!: UUID;

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
