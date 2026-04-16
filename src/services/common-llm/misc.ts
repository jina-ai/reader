import { randomBytes, randomUUID } from 'crypto';
import path from 'path';
import fsp from 'fs/promises';
import { countGPTToken } from '../../utils/openai';
import _ from 'lodash';
import { Writable } from 'stream';
import { JSONAccumulation, JSONParserStream, JSONParserStreamOptions } from '../../lib/json-parse-stream';
import { FancyFile } from 'civkit/fancy-file';
import { AutoCastable, Prop } from 'civkit/civ-rpc';

export type PromptChunk = string | URL | Buffer | File | object;

export interface LLMMessage {
    role: 'user' | 'system' | 'assistant' | string,
    content: string | PromptChunk[] | null,
    name?: string;
    [k: string]: any;
}

export type FunctionCallingAwareLLMMessage = LLMMessage | LLMFunctionCallRequest | LLMFunctionCallResponse;
export interface FunctionCallingAwareLLMModelOptions<T> {
    system?: string;
    messages?: Array<FunctionCallingAwareLLMMessage>;
    stop?: string[];
    stream?: boolean;
    max_tokens?: number;
    temperature?: number;
    top_p?: number;
    top_k?: number;
    n?: number;
    seed?: number;

    functions?: { name: string, description: string, parameters: any; }[];
    function_call?: { name: string; } | string;

    attachments?: (FancyFile | File | string)[];

    modelSpecific?: Partial<T>;
}

export function chatMLEncode(prompt?: string, opts?: {
    system?: string;
    messages?: {
        role: string;
        content: string | PromptChunk[] | null;
        [k: string]: any;
    }[];
}) {
    const chunks: string[] = [];
    const imStart = '<|im_start|>';
    const imEnd = '<|im_end|>';
    if (opts?.system) {
        chunks.push(`${imStart}system\n${opts.system}${imEnd}`);
    }
    if (opts?.messages?.length) {
        for (const m of opts.messages) {
            const params = _.omit(m, 'content', 'role');
            const paramParts = _.map(params, (v, k) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`).join(', ');

            const content = typeof m.content === 'string' ? m.content : m.content?.filter((x) => typeof x === 'string').join('');

            chunks.push(`${imStart}${m.role || 'user'}${paramParts ? ` ${paramParts}` : ''}\n${content}${imEnd}`);
        }
    }
    if (prompt) {
        if (prompt.startsWith(imStart)) {
            chunks.push(prompt);
        } else {
            chunks.push(`${imStart}user\n${prompt}${imEnd}\n${imStart}assistant\n`);
        }
    }

    return chunks.join('\n');
}


const DATAURL_REGEXP = /^data:([a-z]+\/[a-z0-9-+.]+)?;base64,(.*)$/i;

function parseDataUrl(s: string) {
    return DATAURL_REGEXP.exec(s);
}

export async function parseFileFromString(input: string, overrideName?: string) {
    const dataurl = parseDataUrl(input);
    if (dataurl) {
        return new File([Buffer.from(dataurl[2], 'base64')], overrideName || randomUUID(), { type: dataurl[1] });
    }

    if (input.startsWith('http://') || input.startsWith('https://')) {
        const parsedUrl = new URL(input);
        const name = overrideName || path.basename(parsedUrl.pathname) || randomUUID();
        return await fetch(input).then((r) => r.blob()).then((r) => new File([r], name, { type: r.type }));
    }

    if (Buffer.isBuffer(input)) {
        return new File([input], overrideName || randomUUID());
    }

    return new File([await fsp.readFile(input) as any], overrideName || path.basename(input));
}

export function interleavedPrompt(strs: TemplateStringsArray | string[], ...args: (PromptChunk | PromptChunk[])[]) {

    const chunks = _.zip(strs, args).flat() as PromptChunk[];

    const expandedChunks: PromptChunk[] = [];
    for (const x of chunks) {
        if (Array.isArray(x)) {
            expandedChunks.push(...x);
            continue;
        }
        expandedChunks.push(x);
    }

    // Merge text chunks
    const finalChunks: PromptChunk[] = [];

    const strStack: PromptChunk[] = [];

    for (const x of expandedChunks) {

        if (typeof x === 'string') {
            if (x) {
                strStack.push(x);
            }
            continue;
        } else if (typeof x === 'boolean' || (x as any) === 0) {
            strStack.push(`${x}`);
            continue;
        } else if (!x) {
            continue;
        }

        if (strStack.length) {
            finalChunks.push(strStack.join(''));
            strStack.length = 0;
        }

        finalChunks.push(x);
    }

    if (strStack.length) {
        finalChunks.push(strStack.join(''));
        strStack.length = 0;
    }

    return finalChunks;
}

export function stringPromptChunks(promptChunks: string | PromptChunk[] | null | undefined): string {
    if (!Array.isArray(promptChunks)) {
        return promptChunks || '';
    }

    const chunks: PromptChunk[] = [];

    for (const x of promptChunks) {
        if (typeof x === 'string') {
            chunks.push(x);
        } else if (x instanceof URL || x instanceof Blob || Buffer.isBuffer(x)) {
            chunks.push(`[Image]`);
        } else {
            chunks.push(`${JSON.stringify(x)}`);
        }
    }

    return chunks.join('\n');
}

export function trimMessages(prompt: string | PromptChunk[], opts: LLMModelOptions<any>, targetSize: number = 3096) {
    const stringPrompt = stringPromptChunks(prompt);
    const initialEncoded = chatMLEncode(stringPrompt, opts);
    let tokenCount = countGPTToken(initialEncoded);

    const tailMessages = [...(opts.messages || [])];
    const headMessages: any[] = [];

    while (tokenCount > targetSize) {
        const firstMessage = tailMessages.shift();
        if (!firstMessage) {
            break;
        }
        if (firstMessage.role === 'system') {
            headMessages.push(firstMessage);
            continue;
        }
        tokenCount -= countGPTToken(stringPromptChunks(firstMessage?.content));
        tokenCount -= 4;
        const rest = _.omit(firstMessage, 'role', 'content');
        if (!_.isEmpty(rest)) {
            const restChunks: string[] = [];
            for (const [k, v] of Object.entries(rest)) {
                restChunks.push(`${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`);
            }
            tokenCount -= countGPTToken(restChunks.join(', '));
        }
    }

    return [...headMessages, ...tailMessages];
}

export interface LLMPeakEvent {
    event: 'chunk' | 'response' | 'check' | 'exception' | 'retry' | 'result' | 'error';
    data?: string | object | any[];
    channel?: string;
}

export class LLMPeakStream extends Writable {
    constructor() {
        super({ objectMode: true, highWaterMark: 4 * 1024 });
    }
}

export class LLMFunctionCall extends AutoCastable {

    @Prop({
        desc: 'Call id',
        required: true,
        defaultFactory() {
            return randomBytes(6).toString('base64url');
        }
    })
    id!: string;

    @Prop({
        desc: 'name of the function',
        required: true
    })
    name!: string;

    @Prop({
        desc: 'The function call arguments.',
        default: ''
    })
    arguments!: string | any;

}

export class LLMFunctionCallRequest extends AutoCastable {

    @Prop({
        default: 'LLMFunctionCallRequest'
    })
    $$typeof!: 'LLMFunctionCallRequest';

    @Prop({
        desc: 'Optional text preceding the alternative response.',
    })
    text?: string;

    @Prop({
        desc: 'The function call response model generated.',
        required: true,
        arrayOf: LLMFunctionCall,
    })
    functionCalls!: LLMFunctionCall[];

}

export class LLMFunctionCallResponse extends AutoCastable {

    @Prop({
        default: 'LLMFunctionCallResponse'
    })
    $$typeof!: 'LLMFunctionCallResponse';

    @Prop({
        desc: 'Function call id',
        required: true,
        defaultFactory() {
            return randomBytes(6).toString('base64url');
        }
    })
    functionCallId!: string;

    @Prop({
        desc: 'Function name',
    })
    name?: string;

    @Prop({
        desc: 'The function call response.',
        required: true
    })
    content: any;

    @Prop({
        desc: 'The response was an error.',
    })
    isError?: boolean;

    requestCall?: LLMFunctionCall;

}

export function parseJSON(i: string, opts: JSONParserStreamOptions & { withOffsetMetadata?: boolean; } = {
    expectAbruptTerminationOfInput: true,
    expectContaminated: 'object',
    expectControlCharacterInString: true,
    expectCasingInLiteral: true,
}) {
    let parsedArg: any = i;
    try {
        const s = JSONParserStream.parse(i, opts);
        parsedArg = JSONAccumulation.parse(s, undefined, opts.withOffsetMetadata);
    } catch (_err) {
        void 0;
    }

    return parsedArg;
}

export interface LLMModelOptions<T> extends FunctionCallingAwareLLMModelOptions<T> {
    messages?: Array<LLMMessage>;
};
