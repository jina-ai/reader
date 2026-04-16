import { HTTPService, HTTPServiceRequestOptions } from 'civkit/http';
import type OpenAI from 'openai';
import { InputServerEventStream } from '../lib/transform-server-event-stream';
import _ from 'lodash';
import { ProxyAgent, Agent } from 'undici';
import { Readable } from 'stream';

export class OpenRouterHTTP extends HTTPService {
    name: string = 'OpenRouter';


    constructor(
        public apiKey: string,
        public userTitle?: string,
        public userUrl?: string,
    ) {
        super('https://openrouter.ai/api/v1');

        this.baseHeaders['Authorization'] = `Bearer ${apiKey}`;
        if (userTitle) {
            this.baseHeaders['X-Title'] = userTitle;
        }
        if (userUrl) {
            this.baseHeaders['HTTP-Referer'] = userUrl;
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
        return this.get<{
            data: {
                id: string;
                canonical_slug: string;
                hugging_face_id: string;
                name: string;
                created: number;
                description: string;
                context_length: number;
                architecture: {
                    modality: string;
                    input_modalities: string[];
                    output_modalities: string[];
                    tokenizer: string;
                    instruct_type: null;
                };
                pricing: {
                    prompt: string;
                    completion: string;
                    request: string;
                    image: string;
                    web_search: string;
                    internal_reasoning: string;
                };
                top_provider: {
                    context_length: number;
                    max_completion_tokens: number;
                    is_moderated: boolean;
                };
                per_request_limits: null;
                supported_parameters: string[];
            }[];
        }>('/models');
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
