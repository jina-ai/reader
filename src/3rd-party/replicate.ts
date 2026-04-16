import { HTTPService, HTTPServiceRequestOptions, } from 'civkit/http';
import { DownstreamServiceFailureError, JSONPrimitive } from 'civkit/civ-rpc';
import { mimeOf } from 'civkit/mime';
import { TimeoutError } from 'civkit/defer';
import { delay } from 'civkit/timeout';
import _ from 'lodash';
import type { Model, ModelVersion, Page, Prediction, WebhookEventType } from 'replicate';
import { InputServerEventStream } from '../lib/transform-server-event-stream';

export class ReplicateHTTP extends HTTPService {
    name = 'Replicate';

    versionMap = new Map<string, string>();

    constructor(public token: string, public baseUri: string = 'https://api.replicate.com/v1') {
        super(baseUri);

        this.baseHeaders['Authorization'] = `Token ${token}`;

        this.baseOptions.timeout = 1000 * 30;
    }

    getModel(modelPath: string) {
        return this.get<Model>(`/models/${modelPath}`);
    }

    getLatestVersionId(modelPath: string) {
        return this.getModel(modelPath).then((r) => r.data.latest_version?.id);
    }

    listModelVersions(modelPath: string) {
        return this.get<Page<ModelVersion>>(`/models/${modelPath}/versions`);
    }

    getVersionDetail(modelPath: string, version: string) {
        return this.get<ModelVersion>(`/models/${modelPath}/versions/${version}`);
    }

    async encodeInput(input: object) {

        const mapped: { [k: string]: JSONPrimitive; } = {};

        for (const [k, v] of Object.entries(input)) {
            if (Buffer.isBuffer(v)) {
                const mimeVec = await mimeOf(v);
                mapped[k] = `data:${mimeVec.mediaType}/${mimeVec.subType};base64,${v.toString('base64')}`;
            } else if (v instanceof Blob) {
                mapped[k] = `data:${v.type};base64,${Buffer.from(await v.arrayBuffer()).toString('base64')}`;
            } else {
                mapped[k] = v;
            }
        }

        return mapped;
    }


    async resolveVersion(text: string) {
        if (!text.includes('/')) {
            return text;
        }

        const r = this.versionMap.get(text);
        if (r) {
            return r;
        }

        const latestVersion = await this.getLatestVersionId(text);
        if (!latestVersion) {
            throw new Error(`Replicate model ${text} cannot be resolved`);
        }
        this.versionMap.set(text, latestVersion);
        setTimeout(() => {
            this.versionMap.delete(text);
        }, 3600 * 1000);

        return latestVersion;
    }

    async createPrediction(version: string,
        input: object, webhook?: string, webhook_events_filter?: WebhookEventType[], opts?: typeof this['baseOptions']
    ) {
        const resolvedVersion = await this.resolveVersion(version);

        return this.postJson<Prediction>(`/predictions`, {
            version: resolvedVersion,
            input: await this.encodeInput(input),
            webhook,
            webhook_events_filter
        }, opts);
    }

    async createPredictionPreferringWait(version: string,
        input: object, webhook?: string, webhook_events_filter?: WebhookEventType[], opts?: typeof this['baseOptions']
    ) {
        const resolvedVersion = await this.resolveVersion(version);

        return this.postJson<Prediction>(`/predictions`, {
            version: resolvedVersion,
            input: await this.encodeInput(input),
            webhook,
            webhook_events_filter
        }, {
            headers: {
                'Prefer': 'wait'
            },
            timeout: 1000 * 70,
            ...opts
        });
    }

    async createStreamPrediction(version: string,
        input: object, webhook?: string, webhook_events_filter?: WebhookEventType[], opts?: typeof this['baseOptions']
    ) {
        const resolvedVersion = await this.resolveVersion(version);

        return this.postJson<Prediction>(`/predictions`, {
            version: resolvedVersion,
            input: await this.encodeInput(input),
            stream: true,
            webhook,
            webhook_events_filter
        }, opts);
    }

    checkPrediction(predictionId: string, opts?: typeof this['baseOptions']) {
        return this.get<Prediction>(`/predictions/${predictionId}`, opts);
    }

    async *iterPollPrediction(predictionId: string, interval: number = 1000, maxAttempts: number = 210, opts?: typeof this['baseOptions']) {
        let lastCheckpoint = Date.now();
        const deadline = lastCheckpoint + maxAttempts * interval;

        while (lastCheckpoint <= deadline) {
            const now = Date.now();
            const dt = now - lastCheckpoint;
            if (dt < interval) {
                await delay(interval - dt);
            }

            lastCheckpoint = now;
            const prediction = (await this.checkPrediction(predictionId, opts)).data;

            switch (prediction.status as typeof prediction['status'] | 'queued') {
                case 'starting':
                case 'queued': {
                    continue;
                }
                case 'processing': {
                    yield prediction;
                    continue;
                }

                case 'succeeded': {
                    yield prediction;
                    return prediction;
                }
                case 'failed': {
                    throw new DownstreamServiceFailureError({ message: 'Prediction failed', prediction });
                }
                case 'canceled': {
                    throw new DownstreamServiceFailureError({ message: 'Prediction canceled', prediction });
                }

                default: {
                    throw new Error('Unknown status');
                }
            }
        }

        throw new TimeoutError('Prediction timeout');
    }

    async pollPrediction(predictionId: string, interval: number = 2000, maxAttempts: number = 105, opts?: typeof this['baseOptions']) {
        let r: Prediction;
        for await (const prediction of this.iterPollPrediction(predictionId, interval, maxAttempts, opts)) {
            r = prediction;
        }

        return r!;
    }

    async expectStream(url: string, opts?: typeof this['baseOptions']) {
        const r = await this.get(url, {
            headers: {
                ...this.baseHeaders,
                'Accept': 'text/event-stream'
            },
            responseType: 'stream',
            timeout: 1000 * 3600,
            ...opts,
        });

        const sseStream = new InputServerEventStream();
        r.parsed.pipe(sseStream, { end: true });

        r.parsed.once('error', (err: any) => {
            sseStream.destroy(err);
        });

        sseStream.on('data', (sse) => {
            if (sse.event === 'error') {
                sseStream.destroy(new this.Error(sse.data?.detail));

                return;
            }

            if (sse.event === 'done') {
                sseStream.end();

                return;
            }
        });

        return sseStream;
    }

    override async __processResponse(options: HTTPServiceRequestOptions, r: Response): Promise<any> {
        if (!r.ok) {
            throw await r.json();
        }
        const s = await super.__processResponse(options, r);

        return s;
    }
}
