import { singleton } from 'tsyringe';
import { AbstractObjectStorageService, ObjectStorageOptions } from 'civkit/abstract/object-storage';
import { GlobalLogger } from './logger';
import { EnvConfig } from './envconfig';
import { once } from 'events';

@singleton()
export class DefaultBucket extends AbstractObjectStorageService {
    logger = this.globalLogger.child({ service: this.constructor.name });

    override options!: ObjectStorageOptions;

    constructor(
        protected globalLogger: GlobalLogger,
        protected envConfig: EnvConfig,
    ) {
        super(...arguments);
    }

    override async init() {
        await this.dependencyReady();
        const bucketUrl = new URL(process.env.GCP_STORAGE_ENDPOINT || 'https://storage.googleapis.com');
        this.options = {
            region: this.envConfig.GCP_STORAGE_REGION || 'us-central1',
            bucket: process.env.GCP_STORAGE_BUCKET || `${process.env.GCLOUD_PROJECT}.appspot.com`,
            endPoint: bucketUrl.hostname,
            port: Number(bucketUrl.port) || (bucketUrl.protocol === 'https:' ? 443 : 80),
            useSSL: bucketUrl.protocol === 'https:',
            accessKey: this.envConfig.GCP_STORAGE_ACCESS_KEY,
            secretKey: this.envConfig.GCP_STORAGE_SECRET_KEY,
        };
        await super.init();
        this.emit('ready');
    }

    async readSingleFile(path: string) {
        const stream = await this.minioClient.getObject(this.bucket, path);
        const chunks: Buffer[] = [];
        stream.on('data', (chunk: Buffer) => {
            chunks.push(chunk);
        });
        await once(stream, 'end');

        return Buffer.concat(chunks);
    }

    async putBuffer(path: string, buffer: Buffer, metadata?: Record<string, any>) {
        const r = await this.minioClient.putObject(this.bucket, path, buffer, metadata);

        return r;
    }

    async putBufferIfNotExist(path: string, buffer: Buffer, metadata?: Record<string, any>) {
        const s = await this.minioClient.statObject(this.bucket, path).catch(() => undefined);
        if (!s) {
            const r = await this.minioClient.putObject(this.bucket, path, buffer, metadata);
            return r;
        }

        return s;
    }

}