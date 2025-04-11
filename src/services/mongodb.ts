import _ from 'lodash';

import { singleton, container } from 'tsyringe';
import {
    MongoClientOptions, ObjectId,
} from 'mongodb';

import { AbstractMongoDB, AbstractMongoCollection, AbstractMongoCappedCollection } from 'civkit/abstract/mongo';


import { LoggerInterface } from 'civkit/logger';
import globalLogger, { GlobalLogger } from '../services/logger';
import { Finalizer } from './finalizer';
import { InjectProperty } from './registry';
import { SecretExposer } from '../shared/services/secrets';

@singleton()
export class MongoDB extends AbstractMongoDB {
    options?: MongoClientOptions;
    url!: string;
    logger = this.globalLogger.child({ service: this.constructor.name });

    @InjectProperty() protected config!: SecretExposer;

    constructor(
        protected globalLogger: GlobalLogger
    ) {
        super(...arguments);

        this.dependsOn(this.config);
    }

    override async init() {
        await this.dependencyReady();
        if (!this.options) {
            this.options = {
                minPoolSize: 2,
                maxPoolSize: 10,
                maxIdleTimeMS: 1000 * 60,
            };
        }
        if (!this.url) {
            this.url = this.config.MONGO_URI;
        }

        await super.init();

        this.emit('ready');
    }

    @Finalizer()
    override async standDown() {
        if (this.serviceStatus !== 'ready') {
            return;
        }
        await this.client.close(true);
        super.standDown();
    }
}

export abstract class MongoCollection<T extends object, P = ObjectId> extends AbstractMongoCollection<T, P> {
    @InjectProperty()
    mongo!: MongoDB;

    logger: LoggerInterface = globalLogger.child({ service: this.constructor.name });

    constructor(...whatever: any[]) {
        super(...whatever);

        this.dependsOn(globalLogger);
    }
}

export abstract class MongoCappedCollection<T extends object, P = ObjectId> extends
    AbstractMongoCappedCollection<T, P> {

    logger: LoggerInterface = globalLogger.child({ service: this.constructor.name });

    @InjectProperty()
    mongo!: MongoDB;

}

export const mongoClient = container.resolve(MongoDB);

export default mongoClient;
