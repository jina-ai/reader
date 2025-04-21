import { singleton, container } from 'tsyringe';
import { ArrayOf, AutoCastable, Prop } from 'civkit';
import _ from 'lodash';
import { ObjectId } from 'mongodb';
import { MongoCollection } from '../services/mongodb';


export class RateLimitDesc extends AutoCastable {
    @Prop({
        default: 1000
    })
    _id!: ObjectId;

    @Prop({
        default: 1000
    })
    occurrence!: number;

    @Prop({
        default: 3600
    })
    periodSeconds!: number;

    @Prop()
    notBefore?: Date;

    @Prop()
    notAfter?: Date;

    isEffective() {
        const now = new Date();
        if (this.notBefore && this.notBefore > now) {
            return false;
        }
        if (this.notAfter && this.notAfter < now) {
            return false;
        }

        return true;
    }
}

export class JinaWallet extends AutoCastable {
    @Prop({
        default: ''
    })
    user_id!: string;

    @Prop({
        default: 0
    })
    trial_balance!: number;

    @Prop()
    trial_start?: Date;

    @Prop()
    trial_end?: Date;

    @Prop({
        default: 0
    })
    regular_balance!: number;

    @Prop({
        default: 0
    })
    total_balance!: number;
}

export class JinaEmbeddingsTokenAccount extends AutoCastable {
    @Prop({
        defaultFactory: () => new ObjectId()
    })
    _id!: string;

    @Prop({
        required: true
    })
    user_id!: string;

    @Prop({
        nullable: true,
        type: String,
    })
    email?: string;

    @Prop({
        nullable: true,
        type: String,
    })
    full_name?: string;

    @Prop({
        nullable: true,
        type: String,
    })
    customer_id?: string;

    @Prop({
        nullable: true,
        type: String,
    })
    avatar_url?: string;

    // Not keeping sensitive info for now
    // @Prop()
    // billing_address?: object;

    // @Prop()
    // payment_method?: object;

    @Prop({
        required: true
    })
    wallet!: JinaWallet;

    @Prop({
        type: Object
    })
    metadata?: { [k: string]: any; };

    @Prop({
        defaultFactory: () => new Date()
    })
    lastSyncedAt!: Date;

    @Prop({
        dictOf: [ArrayOf(RateLimitDesc)]
    })
    customRateLimits?: { [k: string]: RateLimitDesc[]; };

    [k: string]: any;
}


@singleton()
export class JinaEmbeddingsTokenAccountCollection extends MongoCollection<JinaEmbeddingsTokenAccount> {
    override collectionName = 'embeddingsTokenAccounts';
    override typeclass = JinaEmbeddingsTokenAccount;
}

const instance = container.resolve(JinaEmbeddingsTokenAccountCollection);

export default instance;