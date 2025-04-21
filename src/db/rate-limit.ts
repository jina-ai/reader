import { container, singleton } from 'tsyringe';
import { Also, ApplicationError, AutoCastable, Prop, ResourcePolicyDenyError, RPCReflection } from 'civkit/civ-rpc';
import { ObjectId } from 'mongodb';
import { MongoCollection } from '../services/mongodb';
import { getTraceId } from 'civkit/async-context';
import { RateLimitTriggeredError } from '../services/errors';
import type { RateLimitDesc } from './jina-embeddings-token-account';


export enum API_CALL_STATUS {
    SUCCESS = 'success',
    ERROR = 'error',
    PENDING = 'pending',
}

@Also({ dictOf: Object })
export class APICallLog extends AutoCastable {

    @Prop({
        defaultFactory: () => new ObjectId()
    })
    _id!: ObjectId;

    @Prop({
        required: true,
        defaultFactory: () => getTraceId()
    })
    traceId!: string;

    @Prop()
    uid?: string;

    @Prop()
    ip?: string;

    @Prop({
        arrayOf: String,
        default: [],
    })
    tags!: string[];

    @Prop({
        required: true,
        defaultFactory: () => new Date(),
    })
    createdAt!: Date;

    @Prop()
    completedAt?: Date;

    @Prop({
        required: true,
        default: API_CALL_STATUS.PENDING,
    })
    status!: API_CALL_STATUS;

    @Prop({
        required: true,
        defaultFactory: () => new Date(Date.now() + 1000 * 60 * 60 * 24 * 90),
    })
    expireAt!: Date;

    [k: string]: any;

    tag(...tags: string[]) {
        for (const t of tags) {
            if (!this.tags.includes(t)) {
                this.tags.push(t);
            }
        }
    }
}


@singleton()
export class RateLimitCollection extends MongoCollection<APICallLog> {
    override collectionName = 'apiCallLogs';
    override typeclass = APICallLog;

    override async init() {
        await this.dependencyReady();

        this.emit('ready');
    }

    async assertUidPeriodicLimit(uid: string, pointInTime: Date, limit: number, ...tags: string[]) {
        if (limit <= 0) {
            throw new ResourcePolicyDenyError(`This UID(${uid}) is not allowed to call this endpoint (rate limit quota is 0).`);
        }

        const query: any = {
            createdAt: {
                $gte: pointInTime,
            },
            status: {
                $in: [API_CALL_STATUS.SUCCESS, API_CALL_STATUS.PENDING],
            },
            uid,
        };
        if (tags.length) {
            query.tags = {
                $in: tags,
            };
        }

        try {
            const count = await this.collection.countDocuments(query);

            if (count >= limit) {
                const r = await this.findOne(query, { sort: { createdAt: 1 } });
                if (!r) {
                    throw RateLimitTriggeredError.from({
                        message: `Per UID rate limit exceeded (${tags.join(',') || 'called'} ${limit} times since ${pointInTime})`,
                    });
                }

                const dtMs = Math.abs(r?.createdAt?.valueOf() - pointInTime.valueOf());
                const dtSec = Math.ceil(dtMs / 1000);

                throw RateLimitTriggeredError.from({
                    message: `Per UID rate limit exceeded (${tags.join(',') || 'called'} ${limit} times since ${pointInTime})`,
                    retryAfter: dtSec,
                    retryAfterDate: new Date(Date.now() + dtMs),
                });
            }

            return count + 1;
        } catch (err) {
            if (err instanceof ApplicationError) {
                throw err;
            }
            this.logger.error(`Failed to query rate limit, firebase just cant handle it. Ignoring and just continue.`, { err });
        }

        return 0;
    }

    async assertIPPeriodicLimit(ip: string, pointInTime: Date, limit: number, ...tags: string[]) {
        const query: any = {
            createdAt: {
                $gte: pointInTime,
            },
            status: {
                $in: [API_CALL_STATUS.SUCCESS, API_CALL_STATUS.PENDING],
            },
            ip,
        };
        if (tags.length) {
            query.tags = {
                $in: tags,
            };
        }

        try {
            const count = await this.collection.countDocuments(query);

            if (count >= limit) {
                const r = await this.collection.findOne(query, { sort: { createdAt: 1 } });

                if (!r) {
                    throw RateLimitTriggeredError.from({
                        message: `Per IP rate limit exceeded (${tags.join(',') || 'called'} ${limit} times since ${pointInTime})`,
                    });
                }

                const dtMs = Math.abs(r.createdAt?.valueOf() - pointInTime.valueOf());
                const dtSec = Math.ceil(dtMs / 1000);

                throw RateLimitTriggeredError.from({
                    message: `Per IP rate limit exceeded (${tags.join(',') || 'called'} ${limit} times since ${pointInTime})`,
                    retryAfter: dtSec,
                    retryAfterDate: new Date(Date.now() + dtMs),
                });
            }

            return count + 1;
        } catch (err) {
            if (err instanceof ApplicationError) {
                throw err;
            }
            this.logger.error(`Failed to query rate limit, firebase just cant handle it. Ignoring and just continue.`, { err });
        }

        return 0;
    }

    record(partialRecord: Partial<APICallLog>) {
        if (partialRecord.uid) {
            const record = APICallLog.from(partialRecord);

            return record;
        }
        const record = APICallLog.from(partialRecord);

        return record;
    }

    async simpleRPCUidBasedLimit(rpcReflect: RPCReflection, uid: string, tags: string[] = [],
        ...inputCriterion: RateLimitDesc[] | [Date, number][]) {
        const criterion = inputCriterion.map((c) => { return Array.isArray(c) ? c : this.rateLimitDescToCriterion(c); });

        await Promise.all(criterion.map(([pointInTime, n]) =>
            this.assertUidPeriodicLimit(uid, pointInTime, n, ...tags)));

        const r = this.record({
            uid,
            tags,
        });

        this.insertOne(r).catch((err) => this.logger.warn(`Failed to save rate limit record`, { err }));

        rpcReflect.then(() => {
            r.status = API_CALL_STATUS.SUCCESS;
            this.updateOne({ _id: r._id }, { $set: { status: API_CALL_STATUS.SUCCESS } })
                .catch((err) => this.logger.warn(`Failed to save rate limit record`, { err }));
        });
        rpcReflect.catch((err) => {
            r.status = API_CALL_STATUS.ERROR;
            r.error = err.toString();
            this.updateOne({ _id: r._id }, { $set: { status: API_CALL_STATUS.ERROR, error: err.toString() } })
                .catch((err) => this.logger.warn(`Failed to save rate limit record`, { err }));
        });

        return r;
    }

    rateLimitDescToCriterion(rateLimitDesc: RateLimitDesc) {
        return [new Date(Date.now() - rateLimitDesc.periodSeconds * 1000), rateLimitDesc.occurrence] as [Date, number];
    }

    async simpleRpcIPBasedLimit(rpcReflect: RPCReflection, ip: string, tags: string[] = [],
        ...inputCriterion: RateLimitDesc[] | [Date, number][]) {
        const criterion = inputCriterion.map((c) => { return Array.isArray(c) ? c : this.rateLimitDescToCriterion(c); });
        await Promise.all(criterion.map(([pointInTime, n]) =>
            this.assertIPPeriodicLimit(ip, pointInTime, n, ...tags)));

        const r = this.record({
            ip,
            tags,
        });
        this.collection.insertOne(r).catch((err) => this.logger.warn(`Failed to save rate limit record`, { err }));
        rpcReflect.then(() => {
            r.status = API_CALL_STATUS.SUCCESS;
            this.collection.updateOne({ _id: r._id }, { $set: { status: API_CALL_STATUS.SUCCESS } })
                .catch((err) => this.logger.warn(`Failed to save rate limit record`, { err }));
        });
        rpcReflect.catch((err) => {
            r.status = API_CALL_STATUS.ERROR;
            r.error = err.toString();
            this.collection.updateOne({ _id: r._id }, { $set: { status: API_CALL_STATUS.ERROR, error: err.toString() } })
                .catch((err) => this.logger.warn(`Failed to save rate limit record`, { err }));
        });

        return r;
    }
}

const instance = container.resolve(RateLimitCollection);

export default instance;