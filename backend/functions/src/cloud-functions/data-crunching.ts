import {
    Defer,
    PromiseThrottle,
    RPCHost,
} from 'civkit';
import { singleton } from 'tsyringe';
import {
    // CloudScheduleV2, CloudTaskV2,
    FirebaseStorageBucketControl, Logger, Param, TempFileManager
} from '../shared';
import _ from 'lodash';
import { CrawlerHost } from './crawler';

import { Crawled } from '../db/crawled';
import dayjs from 'dayjs';
import { createReadStream } from 'fs';
import { appendFile } from 'fs/promises';
import { createGzip } from 'zlib';
import { getFunctions } from 'firebase-admin/functions';
import { SnapshotFormatter } from '../services/snapshot-formatter';
import { getFunctionUrl } from '../utils/get-function-url';

dayjs.extend(require('dayjs/plugin/utc'));

@singleton()
export class DataCrunchingHost extends RPCHost {
    logger = this.globalLogger.child({ service: this.constructor.name });

    pageCacheCrunchingPrefix = 'crunched-pages';
    pageCacheCrunchingBatchSize = 5000;
    pageCacheCrunchingTMinus = 6 * 24 * 60 * 60 * 1000;
    rev = 7;

    constructor(
        protected globalLogger: Logger,

        protected crawler: CrawlerHost,
        protected snapshotFormatter: SnapshotFormatter,
        protected tempFileManager: TempFileManager,
        protected firebaseObjectStorage: FirebaseStorageBucketControl,
    ) {
        super(..._.without(arguments, crawler));
    }

    override async init() {
        await this.dependencyReady();

        this.emit('ready');
    }

    // @CloudTaskV2({
    //     runtime: {
    //         cpu: 2,
    //         memory: '4GiB',
    //         timeoutSeconds: 3600,
    //         concurrency: 2,
    //         maxInstances: 200,
    //         retryConfig: {
    //             maxAttempts: 3,
    //             minBackoffSeconds: 60,
    //         },
    //         rateLimits: {
    //             maxConcurrentDispatches: 150,
    //             maxDispatchesPerSecond: 2,
    //         },
    //     },
    //     tags: ['DataCrunching'],
    // })
    async crunchPageCacheWorker(
        @Param('date') date: string,
        @Param('offset', { default: 0 }) offset: number
    ) {
        this.logger.info(`Crunching page cache @${date}+${offset}...`);
        for await (const { fileName, records } of this.iterPageCacheRecords(date, offset)) {
            this.logger.info(`Crunching ${fileName}...`);
            const fileOnDrive = await this.crunchCacheRecords(records);
            const fstream = createReadStream(fileOnDrive.path);
            const gzipStream = createGzip();
            fstream.pipe(gzipStream, { end: true });
            await this.firebaseObjectStorage.bucket.file(fileName).save(gzipStream, {
                contentType: 'application/jsonl+gzip',
            });
        }

        this.logger.info(`Crunching page cache @${date}+${offset} done.`);

        return true;
    }

    // @CloudScheduleV2('2 0 * * *', {
    //     name: 'crunchPageCacheEveryday',
    //     runtime: {
    //         cpu: 2,
    //         memory: '4GiB',
    //         timeoutSeconds: 1800,
    //         timeZone: 'UTC',
    //         retryCount: 3,
    //         minBackoffSeconds: 60,
    //     },
    //     tags: ['DataCrunching'],
    // })
    async dispatchPageCacheCrunching() {
        for await (const { fileName, date, offset } of this.iterPageCacheChunks()) {
            this.logger.info(`Dispatching ${fileName}...`);
            // sse.write({ data: `Dispatching ${fileName}...` });

            await getFunctions().taskQueue('crunchPageCacheWorker').enqueue({ date, offset }, {
                dispatchDeadlineSeconds: 1800,
                uri: await getFunctionUrl('crunchPageCacheWorker'),
            });
        }

        return true;
    }

    // @CloudHTTPv2({
    //     runtime: {
    //         cpu: 2,
    //         memory: '4GiB',
    //         timeoutSeconds: 3600,
    //         concurrency: 2,
    //         maxInstances: 200,
    //     },
    //     tags: ['DataCrunching'],
    // })
    // async dispatchPageCacheCrunching(
    //     @RPCReflect() rpcReflect: RPCReflection
    // ) {
    //     const sse = new OutputServerEventStream({ highWaterMark: 4096 });
    //     rpcReflect.return(sse);
    //     rpcReflect.catch((err) => {
    //         sse.end({ data: `Error: ${err.message}` });
    //     });
    //     for await (const { fileName, date, offset } of this.iterPageCacheChunks()) {
    //         this.logger.info(`Dispatching ${fileName}...`);
    //         sse.write({ data: `Dispatching ${fileName}...` });

    //         await getFunctions().taskQueue('crunchPageCacheWorker').enqueue({ date, offset }, {
    //             dispatchDeadlineSeconds: 1800,
    //             uri: await getFunctionUrl('crunchPageCacheWorker'),
    //         });
    //     }

    //     sse.end({ data: 'done' });

    //     return true;
    // }

    async* iterPageCacheRecords(date?: string, inputOffset?: number | string) {
        const startOfToday = dayjs().utc().startOf('day');
        const startingPoint = dayjs().utc().subtract(this.pageCacheCrunchingTMinus, 'ms').startOf('day');
        let theDay = startingPoint;

        if (date) {
            theDay = dayjs(date).utc().startOf('day');
        }

        let counter = 0;
        if (inputOffset) {
            counter = parseInt(inputOffset as string, 10);
        }

        while (theDay.isBefore(startOfToday)) {
            const fileName = `${this.pageCacheCrunchingPrefix}/r${this.rev}/${theDay.format('YYYY-MM-DD')}/${counter}.jsonl.gz`;
            const offset = counter;
            counter += this.pageCacheCrunchingBatchSize;
            const fileExists = (await this.firebaseObjectStorage.bucket.file(fileName).exists())[0];
            if (fileExists) {
                continue;
            }

            const records = await Crawled.fromFirestoreQuery(Crawled.COLLECTION
                .where('createdAt', '>=', theDay.toDate())
                .where('createdAt', '<', theDay.add(1, 'day').toDate())
                .orderBy('createdAt', 'asc')
                .offset(offset)
                .limit(this.pageCacheCrunchingBatchSize)
            );

            this.logger.info(`Found ${records.length} records for ${theDay.format('YYYY-MM-DD')} at offset ${offset}`, { fileName, counter });

            if (!records.length) {
                if (date) {
                    break;
                }
                theDay = theDay.add(1, 'day');
                counter = 0;
                continue;
            }

            yield { fileName, records };

            if (offset) {
                break;
            }
        }
    }

    async* iterPageCacheChunks() {
        const startOfToday = dayjs().utc().startOf('day');
        const startingPoint = dayjs().utc().subtract(this.pageCacheCrunchingTMinus, 'ms').startOf('day');
        let theDay = startingPoint;

        let counter = 0;

        while (theDay.isBefore(startOfToday)) {
            const fileName = `${this.pageCacheCrunchingPrefix}/r${this.rev}/${theDay.format('YYYY-MM-DD')}/${counter}.jsonl.gz`;
            const offset = counter;
            counter += this.pageCacheCrunchingBatchSize;
            const fileExists = (await this.firebaseObjectStorage.bucket.file(fileName).exists())[0];
            if (fileExists) {
                continue;
            }

            const nRecords = (await Crawled.COLLECTION
                .where('createdAt', '>=', theDay.toDate())
                .where('createdAt', '<', theDay.add(1, 'day').toDate())
                .orderBy('createdAt', 'asc')
                .offset(offset)
                .limit(this.pageCacheCrunchingBatchSize)
                .count().get()).data().count;

            this.logger.info(`Found ${nRecords} records for ${theDay.format('YYYY-MM-DD')} at offset ${offset}`, { fileName, counter });
            if (nRecords < this.pageCacheCrunchingBatchSize) {
                theDay = theDay.add(1, 'day');
                counter = 0;
            }
            if (nRecords) {
                yield { fileName, date: theDay.toISOString(), offset };
            }
        }
    }

    async crunchCacheRecords(records: Crawled[]) {
        const throttle = new PromiseThrottle(30);
        const localFilePath = this.tempFileManager.alloc();
        let nextDrainDeferred = Defer();
        nextDrainDeferred.resolve();

        for (const record of records) {
            await throttle.acquire();
            this.firebaseObjectStorage.downloadFile(`snapshots/${record._id}`)
                .then(async (snapshotTxt) => {
                    try {
                        const snapshot = JSON.parse(snapshotTxt.toString('utf-8'));

                        let formatted = await this.snapshotFormatter.formatSnapshot('default', snapshot);
                        if (!formatted.content) {
                            formatted = await this.snapshotFormatter.formatSnapshot('markdown', snapshot);
                        }

                        await nextDrainDeferred.promise;
                        await appendFile(localFilePath, JSON.stringify({
                            url: snapshot.href,
                            title: snapshot.title || '',
                            html: snapshot.html || '',
                            text: snapshot.text || '',
                            content: formatted.content || '',
                        }) + '\n', { encoding: 'utf-8' });

                    } catch (err) {
                        this.logger.warn(`Failed to parse snapshot for ${record._id}`, { err });
                    }
                })
                .finally(() => {
                    throttle.release();
                });
        }

        await throttle.nextDrain();


        const ro = {
            path: localFilePath
        };

        this.tempFileManager.bindPathTo(ro, localFilePath);

        return ro;
    }
}
