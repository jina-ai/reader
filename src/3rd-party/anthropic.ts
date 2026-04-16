import { HTTPService, HTTPServiceRequestOptions } from 'civkit/http';
import { InputServerEventStream } from '../lib/transform-server-event-stream';
import _ from 'lodash';

export interface ClaudeSamplingParameters {
    prompt: string;
    model: string;
    stop_sequences: string[];
    max_tokens_to_sample: number;

    stream?: boolean;
    temperature?: number;
    top_k?: number;
    top_p?: number;
    tags?: {
        [key: string]: string;
    };
};

export interface ClaudeMessagingParameters {
    model: string;
    messages: {
        role: string;
        content: string | Array<
            { type: 'text', text: string; } |
            {
                type: 'image', source: {
                    type: 'base64';
                    media_type: string;
                    data: string;
                };
            } |
            { type: 'tool_use'; id: string; name: string; input: any; } |
            {
                type: 'tool_result';
                tool_use_id: string;
                is_error?: boolean;
                content?: Array<{ type: 'text', text: string; } |
                {
                    type: 'image', source: {
                        type: 'base64';
                        media_type: string;
                        data: string;
                    };
                }>;
            }
        >;
    }[];
    stop_sequences: string[];
    max_tokens: number;

    stream?: boolean;
    temperature?: number;
    top_k?: number;
    top_p?: number;
    metadata?: {
        [key: string]: string;
    };
};

export interface ClaudeCompletionResponse {
    completion: string;
    stop: string | null;
    stop_reason: "stop_sequence" | "max_tokens";
    log_id: string;
};

export interface ClaudeMessagingResponse {
    id: string;
    type: 'message';
    role: 'assistant';
    content: Array<{
        type: 'text';
        text: string;
    } | { type: 'tool_use', id: string, name: string, input: any; }>;
    model: string;
    stop_reason: string | 'end_turn' | 'max_tokens' | 'stop_sequence' | null;
    stop_sequence: string | null;
    usage: {
        input_tokens: number;
        output_tokens: number;
    };
};

export const CLAUDE_MODELS = [
    'claude-instant-1',
    'claude-2',

    'claude-v1',
    'claude-v1-100k',
    'claude-instant-v1',
    'claude-instant-v1-100k',

    'claude-v1.3',
    'claude-v1.3-100k',
    'claude-v1.2',
    'claude-v1.0',
    'claude-instant-v1.1',
    'claude-instant-v1.1-100k',
    'claude-instant-v1.0',
] as const;
export type CLAUDE_MODELS = typeof CLAUDE_MODELS[number];

export class AnthropicHTTP extends HTTPService {
    name = 'Anthropic';

    supportedCompletionModels = [
        ...CLAUDE_MODELS
    ] as string[];

    constructor(public apiKey: string) {
        super('https://api.anthropic.com');

        this.baseHeaders['X-API-Key'] = `${apiKey}`;
        this.baseHeaders['Anthropic-Version'] = `2023-06-01`;

        this.baseOptions.timeout = 1000 * 60 * 30 * 0.5;
    }

    complete<T extends ClaudeSamplingParameters>(payload: T, opts?: typeof this['baseOptions']) {
        return this.postJson<typeof payload['stream'] extends true ?
            InputServerEventStream : ClaudeCompletionResponse>('/v1/complete', payload,
                { ...opts, responseType: payload.stream ? 'stream' : 'json' }
            );
    }

    chatCompletions<T extends Partial<ClaudeSamplingParameters> & {
        prompt: string;
        system?: string;
    }>(payload: T, opts?: typeof this['baseOptions']) {

        const finalPayload: T = {
            stop_sequences: ['\n\nHuman:'],
            max_tokens_to_sample: 1000,
            ...(payload as any),
        };

        if (!finalPayload.prompt.startsWith('\n\nHuman:')) {
            finalPayload.prompt = `\n\nHuman: ${finalPayload.prompt}\n\nAssistant:`;
        }

        if (finalPayload.system) {
            finalPayload.prompt = `\n\nHuman: ${finalPayload.system}${finalPayload.prompt}`;
            delete finalPayload.system;
        }

        return this.complete(finalPayload as ClaudeSamplingParameters, opts);
    }

    messageComplete<T extends Partial<ClaudeMessagingParameters>>(payload: T, opts?: typeof this['baseOptions']) {

        return this.postJson<typeof payload['stream'] extends true ?
            InputServerEventStream : ClaudeMessagingResponse>('/v1/messages', payload,
                { ...opts, responseType: payload.stream ? 'stream' : 'json' }
            );
    }

    override async __processResponse(options: HTTPServiceRequestOptions, r: Response): Promise<any> {
        if (r.status !== 200) {
            throw await r.json();
        }
        const s = await super.__processResponse(options, r);
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
