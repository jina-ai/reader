import _ from "lodash";
import { injectable } from "tsyringe";
import { GeminiPro } from './google-gemini';
import { GoogleAuth } from 'google-auth-library';
import { VertexGeminiHTTP } from '../../3rd-party/google-gemini';
import { PromptChunk } from './misc';
import { readFile } from 'fs/promises';
import { InjectProperty } from '../registry';
import { HashManager } from 'civkit/hash';
import { DefaultBucket } from '../default-bucket';
import { maxConcurrency } from 'civkit/decorators';
import { downloadFile } from 'civkit/download';
import { mimeOf } from 'civkit/mime';


const sha256Hasher = new HashManager('sha256', 'hex');

@injectable()
export class VertexGeminiPro extends GeminiPro {
    static override description = 'Vertex AI Gemini Pro 1.0 Model';
    static override aliases = ['vertex-gemini-1.0-pro'];
    static override modelName = 'gemini-1.0-pro';

    protected gAuth = new GoogleAuth({
        scopes: 'https://www.googleapis.com/auth/cloud-platform',
    });

    @InjectProperty(DefaultBucket)
    defaultBucket!: DefaultBucket;

    protected refreshCredsInterval?: ReturnType<typeof setInterval>;

    constructor() {
        // @ts-ignore
        super(...arguments);
    }

    override async init() {
        await this.dependencyReady();
        if (process.env.NODE_ENV?.includes('dry-run') || !process.env.GCLOUD_PROJECT) {
            this.emit('ready');
            return;
        }
        if (this.refreshCredsInterval) {
            clearInterval(this.refreshCredsInterval);
            this.refreshCredsInterval = undefined;
        }
        try {
            const cred = await this.refreshCreds();
            this.clients = [
                new VertexGeminiHTTP(cred.token, cred.project),
            ];
            for (const x of this.clients) {
                x.on('unauthorized', () => this.refreshCreds());
            }
            this.refreshCredsInterval = setInterval(() => {
                this.refreshCreds().catch((e) => {
                    this.logger.error('Failed to refresh creds', e);
                });
            }, 60 * 20 * 1000);
        } catch (err) {
            this.logger.warn('Failed to initialize Vertex Gemini clients', err);
        }
        this.emit('ready');
    }

    @maxConcurrency(1)
    async refreshCreds() {
        const ad = await this.gAuth.getApplicationDefault();
        const token = (await ad.credential.getAccessToken()).token;
        if (!token) {
            throw new Error('Failed to get access token');
        }
        if (!ad.projectId) {
            throw new Error('Failed to get project ID');
        }

        for (const x of this.clients) {
            x.apiKey = token;
        }

        return {
            project: ad.projectId,
            token
        };
    }

    override async encodePromptChunks(promptChunks: string | PromptChunk[] | null): Promise<any> {
        if (!(this.constructor as typeof GeminiPro).interleavedPromptSupported) {
            return super.encodePromptChunks(promptChunks);
        }

        if (typeof promptChunks === 'string') {
            return super.encodePromptChunks(promptChunks);
        }

        if (!promptChunks) {
            return super.encodePromptChunks(promptChunks);
        }

        const ps = promptChunks.map(async (x) => {
            if (typeof x === 'string') {
                return { text: x };
            }
            if (x instanceof URL) {
                const tmpPath = this.tempFileManager.alloc();
                await downloadFile(x.toString(), tmpPath);
                const buff = await readFile(tmpPath);
                const mimeVec = await mimeOf(buff);
                if (x.hostname === 'storage.googleapis.com') {
                    const gsUrl = `gs://${x.pathname.slice(1)}`;

                    return {
                        fileData: {
                            mimeType: `${mimeVec.mediaType}/${mimeVec.subType}`,
                            fileUri: gsUrl,
                        }
                    };
                }
                const digest = sha256Hasher.hash(buff);
                const fname = `llmTmp/${digest}`;
                await this.defaultBucket.putBufferIfNotExist(fname, buff, {
                    'Content-Type': `${mimeVec.mediaType}/${mimeVec.subType}`
                });
                const r = {
                    fileData: {
                        mimeType: `${mimeVec.mediaType}/${mimeVec.subType}`,
                        fileUri: `gs://${this.defaultBucket.bucket}/${fname}`,
                    }
                };
                this.tempFileManager.bindPathTo(r, tmpPath);

                return r;
            }

            if (x instanceof Blob) {

                const buff = Buffer.from(await x.arrayBuffer());
                const digest = sha256Hasher.hash(buff);
                const fname = `llmTmp/${digest}`;
                await this.defaultBucket.putBufferIfNotExist(fname, buff, {
                    'Content-Type': x.type
                });

                return {
                    fileData: {
                        mimeType: x.type,
                        fileUri: `gs://${this.defaultBucket.bucket}/${fname}`,
                    }
                };
            }

            if (Buffer.isBuffer(x)) {
                const buff = x;
                const mimeVec = await mimeOf(buff);
                const digest = sha256Hasher.hash(buff);
                const fname = `llmTmp/${digest}`;
                await this.defaultBucket.putBufferIfNotExist(fname, buff, {
                    'Content-Type': `${mimeVec.mediaType}/${mimeVec.subType}`,
                });

                return {
                    fileData: {
                        mimeType: `${mimeVec.mediaType}/${mimeVec.subType}`,
                        fileUri: `gs://${this.defaultBucket.bucket}/${fname}`,
                    }
                };
            }

            return x;
        });

        return await Promise.all(ps);
    }

}

export class VertexGemini25Flash extends VertexGeminiPro {
    static override description = 'Vertex AI Gemini 2.5 Flash Model';
    static override aliases = ['vertex-gemini-2.5-flash'];
    static override modelName = 'gemini-2.5-flash';
    static override interleavedPromptSupported = true;
    static override jsonModeSchemaSupported = true;

    static override windowSize = 1_000_000;
}

export class VertexGemini25FlashLite extends VertexGeminiPro {
    static override description = 'Vertex AI Gemini 2.5 Flash Lite Model';
    static override aliases = ['vertex-gemini-2.5-flash-lite'];
    static override modelName = 'gemini-2.5-flash-lite';
    static override interleavedPromptSupported = true;
    static override jsonModeSchemaSupported = true;

    static override windowSize = 1_000_000;
}