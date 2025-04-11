import { AbstractObjectStorageService, ObjectStorageOptions } from 'civkit/abstract/object-storage';
import { GlobalLogger } from './logger';
import { SecretExposer } from '../shared';


export class StorageBucket extends AbstractObjectStorageService {

    logger = this.globalLogger.child({ service: this.constructor.name });
    options!: ObjectStorageOptions;

    constructor(
        protected globalLogger: GlobalLogger,
        protected config: SecretExposer,
    ) {
        super(...arguments);

        this.options = {
            bucket: process.env.GCP_STORAGE_BUCKET || `${process.env.GCLOUD_PROJECT}.appspot.com`,
            endPoint: 'https://storage.googleapis.com',
            region: 'auto',
            accessKey: this.config.GCP_STORAGE_ACCESS_KEY,
            secretKey: this.config.GCP_STORAGE_SECRET_KEY,
        };

        this.dependsOn(globalLogger);
    }
}
