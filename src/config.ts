import { container } from 'tsyringe';
import { StorageLayer } from './db/noop-storage';
import { BaseAuthDTO } from './dto/base-auth';

export let AUTH_DTO_CLS = BaseAuthDTO;

export let STORAGE_CLS = StorageLayer;

if (process.env.GCP_STORAGE_ENDPOINT && (process.env.GCP_STORAGE_BUCKET || process.env.GCLOUD_PROJECT)) {
    STORAGE_CLS = require('./db/bucket-storage').BucketStorageLayer;
}

container.registerSingleton(StorageLayer, STORAGE_CLS);