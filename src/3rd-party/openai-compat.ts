import { HTTPService, HTTPServiceRequestOptions } from 'civkit/http';
import type OpenAI from 'openai';
import { InputServerEventStream } from '../lib/transform-server-event-stream';
import _ from 'lodash';
import { ProxyAgent, Agent } from 'undici';
import { Readable } from 'stream';

export abstract class OpenAICompatHTTP extends HTTPService {
    abstract name: string;

    abstract supportedCompletionModels: string[];

    abstract supportedChatCompletionModels: string[];

    abstract supportedImageGenerationModels: string[];

    functionCallingSupported = true;

    constructor(public apiKey: string, baseUri: string, public organization?: string) {
        super(baseUri);

        this.baseHeaders['Authorization'] = `Bearer ${apiKey}`;
        if (organization) {
            this.baseHeaders['OpenAI-Organization'] = organization;
        }

        let agent: ProxyAgent | Agent;
        const proxyUri = process.env.http_proxy;
        const proxyOptions: Omit<ProxyAgent.Options, 'uri'> = {
            connectTimeout: 1000 * 30,
            headersTimeout: 1000 * 60 * 15,
        };

        if (proxyUri) {
            agent = new ProxyAgent({
                ...proxyOptions,
                uri: proxyUri
            });
        } else {
            agent = new Agent(proxyOptions);
        }

        this.baseOptions.timeout = 1000 * 60 * 15;
        Reflect.set(this.baseOptions, 'dispatcher', agent);
    }

    listModels() {
        return this.get<OpenAI.Models>('models');
    }

    getModelDetail(model: string, opts?: typeof this['baseOptions']) {
        return this.get<OpenAI.Model>(`/models/${model}`, opts);
    }

    completions<T extends OpenAI.CompletionCreateParams>(payload: T, opts?: typeof this['baseOptions']) {
        return this.postJson<typeof payload['stream'] extends true ?
            InputServerEventStream : OpenAI.Completion>('/completions', payload,
                { ...opts, responseType: payload.stream ? 'stream' : 'json' }
            );
    }

    chatCompletions<T extends OpenAI.ChatCompletionCreateParams>(payload: T, opts?: typeof this['baseOptions']) {

        return this.postJson<typeof payload['stream'] extends true ?
            InputServerEventStream : OpenAI.Completion
        >('/chat/completions', payload,
            { ...opts, responseType: payload.stream ? 'stream' : 'json' }
        );
    }

    imagesGenerations<T extends OpenAI.ImageGenerateParams>(payload: T, opts?: typeof this['baseOptions']) {
        return this.postJson<OpenAI.ImagesResponse>('/images/generations', payload,
            { ...opts, responseType: 'json' }
        );
    }
    imagesEdits<T extends OpenAI.ImageGenerateParams & { image: File; mask?: File; prompt?: string; }>(payload: T, opts?: typeof this['baseOptions']) {
        const req: any[] = [];
        for (const [k, v] of Object.entries(payload)) {
            req.push([k, v]);
        }

        return this.postMultipart<OpenAI.ImagesResponse>('/images/edits', req,
            { ...opts, responseType: 'json' }
        );
    }
    imagesVariants<T extends OpenAI.ImageGenerateParams>(payload: T & { image: File; prompt?: string; }, opts?: typeof this['baseOptions']) {
        const req: any[] = [];
        for (const [k, v] of Object.entries(payload)) {
            req.push([k, v]);
        }

        return this.postMultipart<OpenAI.ImagesResponse>('/images/variations', req,
            { ...opts, responseType: 'json' }
        );
    }

    override async __processResponse(options: HTTPServiceRequestOptions, r: Response): Promise<any> {
        if (r.status !== 200) {
            if (r.headers.get('content-type')?.includes('application/json')) {
                throw await r.json();
            }
            throw await r.text();
        }
        const s = await super.__processResponse(options, r) as any as Readable;
        if (options.responseType === 'stream') {
            const parseStream = new InputServerEventStream();
            s.pipe(parseStream);
            parseStream.once('end', () => {
                if (!s.readableEnded) {
                    r.body?.cancel();
                }
            });

            return parseStream;
        }

        return s;
    }
}
