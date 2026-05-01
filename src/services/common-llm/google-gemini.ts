import { AutoCastable, DownstreamServiceFailureError, Prop, isAutoCastableClass } from 'civkit/civ-rpc';
import { AbstractLLM, DependsOnOptions, DetectFunctions, LLMDto, LLMModelOptions, PromptChunk } from "./base";
import _ from "lodash";
import { isReadable, once, Readable, Transform, TransformCallback } from "stream";
import { injectable } from "tsyringe";
import { TempFileManager } from '../temp-file';
import { readFile } from 'fs/promises';
import { FunctionCallingAwareLLMMessage, FunctionCallingAwareLLMModelOptions, LLMFunctionCallRequest, LLMFunctionCallResponse, LLMMessage, LLMPeakStream } from './misc';
import {
    FunctionCallingMode, HarmBlockThreshold, HarmCategory,
    GenerateContentCandidate as GeminiGenerateContentCandidate, GenerateContentResponse as GeminiGenerateContentResponse,
    GoogleGeminiHTTP, FinishReason
} from '../../3rd-party/google-gemini';
import { InjectProperty } from '../registry';
import { AsyncLocalContext } from '../async-context';
import { EnvConfig } from '../envconfig';
import { GlobalLogger } from '../logger';
import { HTTPServiceRequestOptions } from 'civkit/http';
import { HarmfulContentError } from '../errors';
import { downloadFile } from 'civkit/download';
import { mimeOf } from 'civkit/mime';
import { isPrimitiveType } from 'civkit/lang';

export enum GEMINI_ROLE {
    USER = 'user',
    MODEL = 'model',
    FUNCTION = 'function',
    SYSTEM = 'system',
}

export class GeminiSafetySetting extends AutoCastable {
    @Prop({
        required: true,
        type: HarmCategory,
    })
    category!: HarmCategory;

    @Prop({
        required: true,
        type: HarmBlockThreshold,
    })
    threshold!: HarmBlockThreshold;
}

export class GeminiGenerationConfig extends AutoCastable {
    @Prop()
    candidateCount?: number;

    @Prop({
        arrayOf: String
    })
    stopSequences?: string[];

    @Prop()
    maxOutputTokens?: number;

    @Prop()
    temperature?: number;

    @Prop()
    topP?: number;

    @Prop()
    topK?: number;
    @Prop()
    presencePenalty?: number;
    @Prop()
    frequencyPenalty?: number;
    @Prop()
    responseMimeType?: string;
    @Prop()
    responseSchema?: any;
}



export class GeminiTextChunk extends AutoCastable {
    @Prop({
        desc: 'The content of the message chunk',
        required: true,
    })
    text!: string;
}
export class GeminiInlineBlob extends AutoCastable {
    @Prop({
        required: true,
    })
    mimeType!: string;
    @Prop({
        required: true,
    })
    data!: string;
}
export class GeminiInlineDataChunk extends AutoCastable {
    @Prop({
        required: true,
    })
    inlineData!: GeminiInlineBlob;
}
export class GeminiFunctionCall extends AutoCastable {
    @Prop({
        required: true,
    })
    name!: string;

    @Prop({ required: true })
    args!: object;
}
export class GeminiFunctionCallChunk extends AutoCastable {
    @Prop({
        required: true,
    })
    functionCall!: GeminiFunctionCall;
}
export class GeminiFunctionResponse extends AutoCastable {
    @Prop({
        required: true,
    })
    name!: string;
    @Prop({
        required: true
    })
    response!: object;
}
export class GeminiFunctionResponseChunk extends AutoCastable {
    @Prop({
        required: true,
    })
    functionResponse!: GeminiFunctionResponse;
}
export class GeminiLinkedBlob extends AutoCastable {
    @Prop({
        required: true,
    })
    mimeType!: string;
    @Prop({
        required: true,
    })
    fileUri!: string;
}
export class GeminiLinkedDataChunk extends AutoCastable {
    @Prop({
        required: true,
    })
    fileData!: GeminiLinkedBlob;
}

export class GeminiContent extends AutoCastable {
    @Prop({
        required: true,
        arrayOf: [GeminiTextChunk, GeminiInlineDataChunk, GeminiFunctionCallChunk, GeminiFunctionResponseChunk, GeminiLinkedDataChunk]
    })
    parts!: (GeminiTextChunk | GeminiInlineDataChunk | GeminiFunctionCallChunk | GeminiFunctionResponseChunk | GeminiLinkedDataChunk)[];

    @Prop({
        required: true,
        type: String,
    })
    role!: string | GEMINI_ROLE;
}

export class GeminiFunctionDescriber extends AutoCastable {
    @Prop({
        desc: 'The name of the function to be called. Must be a-z, A-Z, 0-9, or contain underscores and dashes, with a maximum length of 64.',
        validate: (x: string) => /[a-zA-Z0-9_\-]{1,64}/.test(x),
        required: true
    })
    name!: string;

    @Prop({
        desc: 'The description of what the function does.',
    })
    description?: string;

    @Prop({
        desc: 'The parameters the functions accepts, described as a JSON Schema object. See the guide for examples, and the JSON Schema reference for documentation about the format.',
    })
    parameters?: object;
}

export class GeminiFunctionsTool extends AutoCastable {
    @Prop({
        desc: 'The functions that the tool provides.',
        required: true,
        arrayOf: GeminiFunctionDescriber
    })
    functionDeclarations!: GeminiFunctionDescriber[];
}

export class GeminiFunctionCallingConfig extends AutoCastable {
    @Prop({
        type: FunctionCallingMode
    })
    mode?: FunctionCallingMode;
    @Prop({
        arrayOf: String
    })
    allowedFunctionNames?: string[];
}

export class GeminiModelOptions extends AutoCastable {

    @Prop({
        arrayOf: GeminiContent,
        required: true,
    })
    contents!: GeminiContent[];

    @Prop({
        arrayOf: [GeminiFunctionsTool, Object]
    })
    tools?: Array<GeminiFunctionsTool | object>;

    @Prop({
        dictOf: Object
    })
    toolConfig?: { [k: string]: any; };

    @Prop()
    systemInstruction?: GeminiContent;

    @Prop({
        arrayOf: GeminiSafetySetting
    })
    safetySettings?: GeminiSafetySetting[];

    @Prop()
    generationConfig?: GeminiGenerationConfig;
}

export class GeminiResponseStream extends Transform {

    lastEvent?: GeminiGenerateContentCandidate;

    get role(): string | undefined {
        return this.accumulatedObject?.content.role;
    }

    history?: LLMMessage;

    get finishReason() {
        return this.accumulatedObject?.finishReason;
    }

    accumulatedObject: GeminiGenerateContentCandidate = {} as any;
    private _kickedOff = false;

    constructor(protected choiceIndex: number = 0, public prepend: string = '') {
        super({
            objectMode: true,
            highWaterMark: 4 * 1024,
        });
    }

    applyDelta(ptr: object = this.accumulatedObject, delta?: any) {
        if (typeof delta !== 'object' || delta === null) {
            return;
        }

        _.mergeWith(ptr, delta, (objValue: any, srcValue: any, key: string, _object: any, _source: any, stack: Set<unknown>) => {
            if (key === 'text' && stack.size === 3) {
                return `${objValue || ''}${srcValue || ''}`;
            }

            return undefined;
        });
    }

    override _flush(callback: TransformCallback) {
        if (this.prepend) {
            this.accumulatedObject.content?.parts?.unshift({ text: this.prepend });
        }

        const fnCalls = this.accumulatedObject.content?.parts.filter((x) => x.functionCall);
        if (fnCalls?.length) {
            const prepend = this.prepend || '';
            this.push(LLMFunctionCallRequest.from({
                text: prepend + this.accumulatedObject.content.parts.filter((x) => x.text).map((x) => x.text || '').join('') || '',
                functionCalls: fnCalls.map((x) => ({
                    name: x.functionCall!.name,
                    arguments: _.cloneDeepWith(x.functionCall!.args, (v) => {
                        if (typeof v === 'string') {
                            try {
                                return JSON.parse(`"${v.replaceAll('\n', '\\n').replaceAll(/(?<!\\)"/g, '\\"')}"`);
                            } catch (_err) {
                                return v.replaceAll('\\n', '\n').replaceAll('\\"', '"').replaceAll(`\\'`, `'`);
                            }
                        }
                    }),
                }))
            }));
        }

        this.emit('history', this.accumulatedObject.content);
        this.emit('reason', this.finishReason);
        this.emit('final', this.accumulatedObject);

        this.push(null);
        callback(null);
    }

    override _transform(input: { event: string; data: GeminiGenerateContentResponse; } | null, _encoding: string, callback: TransformCallback) {
        if (!this._kickedOff) {
            this._kickedOff = true;
            if (this.prepend) {
                this.push(this.prepend);
                this.emit('text', this.prepend);
            }
        }
        if (input === null) {
            return callback(null);
        }

        const chunk = this.choiceIndex ? input.data.candidates?.find((x) => x.index === this.choiceIndex) : input.data.candidates?.[0];
        if (!chunk) {
            return callback();
        }

        this.lastEvent = chunk;
        this.emit('event', chunk);

        if (chunk.content?.parts?.[0]?.text) {
            this.emit('text', chunk.content.parts[0].text);
            this.push(chunk.content.parts[0].text);
        }

        this.applyDelta(
            this.accumulatedObject, chunk
        );

        callback(null);

        return;
    }
}

export interface GeminiResponseStream extends Transform {
    on(event: 'event', handler: (event: { [k: string]: any; }) => void): this;
    on(event: 'text', handler: (textChunk: string) => void): this;
    on(event: 'reason', handler: (reason: string) => void): this;
    on(event: 'history', handler: (history: unknown) => void): this;

    once(event: 'event', handler: (event: { [k: string]: any; }) => void): this;
    once(event: 'text', handler: (textChunk: string) => void): this;
    once(event: 'reason', handler: (reason: string) => void): this;
    once(event: 'history', handler: (history: unknown) => void): this;

    on(event: 'close', listener: () => void): this;
    on(event: 'data', listener: (chunk: any) => void): this;
    on(event: 'drain', listener: () => void): this;
    on(event: 'end', listener: () => void): this;
    on(event: 'error', listener: (err: Error) => void): this;
    on(event: 'finish', listener: () => void): this;
    on(event: 'pause', listener: () => void): this;
    on(event: 'pipe', listener: (src: Readable) => void): this;
    on(event: 'readable', listener: () => void): this;
    on(event: 'resume', listener: () => void): this;
    on(event: 'unpipe', listener: (src: Readable) => void): this;
    on(event: string | symbol, listener: (...args: any[]) => void): this;
    once(event: 'close', listener: () => void): this;
    once(event: 'data', listener: (chunk: any) => void): this;
    once(event: 'drain', listener: () => void): this;
    once(event: 'end', listener: () => void): this;
    once(event: 'error', listener: (err: Error) => void): this;
    once(event: 'finish', listener: () => void): this;
    once(event: 'pause', listener: () => void): this;
    once(event: 'pipe', listener: (src: Readable) => void): this;
    once(event: 'readable', listener: () => void): this;
    once(event: 'resume', listener: () => void): this;
    once(event: 'unpipe', listener: (src: Readable) => void): this;
    once(event: string | symbol, listener: (...args: any[]) => void): this;
}



@injectable()
export class GeminiPro extends AbstractLLM<GeminiModelOptions> {
    static override description = 'Google Gemini Pro Model';
    static override aliases = ['gemini-1.0-pro', 'gemini-1.0-pro-001', 'gemini-1.0-pro-latest', 'gemini-pro',];
    static override streamingSupported = true;
    static override systemSupported = true;
    static override chatOptimized = true;
    static override partialCompleteSupported = false;
    static override nSupported = true;
    static override modelOptionsType = GeminiModelOptions;
    static override windowSize = 30_720;
    static override functionCalling = 'native';
    static jsonModeSchemaSupported = false;
    static jsonModeDisabilityToCallFunctions = true;

    static modelName = 'gemini-1.0-pro-latest';

    override clients: Array<GoogleGeminiHTTP> = [];

    @InjectProperty()
    envConfig!: EnvConfig;
    @InjectProperty()
    globalLogger!: GlobalLogger;
    @InjectProperty()
    tempFileManager!: TempFileManager;
    @InjectProperty()
    threadLocal!: AsyncLocalContext;

    logger = this.globalLogger.child({ service: this.constructor.name });


    constructor() {
        super(...arguments);
        this.dependsOn(this.envConfig, this.globalLogger, this.tempFileManager, this.threadLocal);
    }

    override async init() {
        await this.dependencyReady();
        this.clients = [
            new GoogleGeminiHTTP(this.envConfig.GOOGLE_AI_STUDIO_API_KEY),
        ];
        this.emit('ready');
    }

    override async _run<U extends LLMModelOptions<GeminiModelOptions>>(
        client: this['clients'][number],
        prompt: string | PromptChunk[],
        modelOpts?: U,
        requestOptions?: HTTPServiceRequestOptions
    ): Promise<DependsOnOptions<U>> {
        const modelName = (this.constructor as typeof GeminiPro).modelName;
        const draftOptions: GeminiModelOptions = {
            contents: [],
            tools: modelOpts?.functions?.length ? [{
                functionDeclarations: modelOpts.functions
            }] : undefined,
            toolConfig: modelOpts?.function_call ? {
                functionCallingConfig: {
                    mode: typeof modelOpts.function_call === 'string' ?
                        modelOpts.function_call.toUpperCase() as FunctionCallingMode : modelOpts.function_call ? FunctionCallingMode.ANY : FunctionCallingMode.AUTO,
                    allowedFunctionNames: (modelOpts.function_call as any)?.name ? [(modelOpts.function_call as any).name] : undefined,
                }
            } : undefined,
            safetySettings: [
                { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
                { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
                { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
                { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
            ],
            generationConfig: {
                candidateCount: modelOpts?.n,
                stopSequences: modelOpts?.stop,
                maxOutputTokens: modelOpts?.max_tokens,
                temperature: modelOpts?.temperature,
                topP: modelOpts?.top_p,
                topK: modelOpts?.top_k,
            }
        };
        if (modelOpts?.modelSpecific) {
            _.merge(draftOptions, _.omit(modelOpts?.modelSpecific, 'tools'));
            if (modelOpts?.modelSpecific?.tools) {
                draftOptions.tools = [...(draftOptions.tools || []), ...(modelOpts.modelSpecific.tools)];
            }
        }

        const systemParts = [];
        if (modelOpts?.system) {
            systemParts.push({ text: modelOpts.system });
        }

        const messages: GeminiContent[] = [];
        if (modelOpts?.messages?.length) {
            for (const m of modelOpts.messages) {
                const ctnt = m.content ? await this.encodePromptChunks(m.content) : [];
                if (m.role === 'system') {
                    systemParts.push(...ctnt);
                } else if (m.role === 'user') {
                    messages.push({ role: 'user', parts: [...ctnt, ...(m.parts || [])] });
                } else if (m.role === 'assistant' || m.role === 'model') {
                    messages.push({ role: 'model', parts: [...ctnt, ...(m.parts || [])] });
                    // if (ctnt.find((x: any) => typeof x.text !== 'string')) {
                    //     messages.push({ role: 'user', parts: ctnt.filter((x: any) => x.text) });
                    // } else {
                    //     messages.push({ role: 'model', parts: ctnt });
                    // }
                } else if (m.role === 'tool' || m.role === 'function') {
                    messages.push({ role: 'user', parts: [...ctnt, ...(m.parts || [])] });
                }
            }
        }
        if (systemParts.length) {
            draftOptions.systemInstruction = { parts: systemParts, role: 'system' };
        }
        if (prompt) {
            messages.push({ role: 'user', parts: await this.encodePromptChunks(prompt) });
        }

        const fixedMessages: GeminiContent[] = [];
        let previousMessage: GeminiContent | undefined = undefined;
        for (const m of messages) {
            if (!previousMessage) {
                previousMessage = m;
                fixedMessages.push(m);
                continue;
            }
            if (m.role === previousMessage.role) {
                previousMessage.parts = [
                    ...previousMessage.parts,
                    ...m.parts
                ];
            } else {
                previousMessage = m;
                fixedMessages.push(m);
            }
        }
        // for (const m of fixedMessages) {
        //     if (Array.isArray(m.content)) {
        //         m.content = m.content.filter((x) => {
        //             if (x.type === 'text') {
        //                 return x.text.length > 0 && Boolean(x.text.match(/\S/));
        //             }
        //             return true;
        //         });
        //     } else if (typeof m.content === 'string' && !m.content.match(/\S/)) {
        //         m.content = '(blank)';
        //     }
        // }

        const opts = (this.constructor as typeof GeminiPro).modelOptionsType.from({
            ...draftOptions,
            contents: fixedMessages,
        });
        this.logger.debug(`Calling ${modelName} by ${client.name}...`);

        const lastMessage = opts.contents[opts.contents.length - 1];
        let prepend = '';
        if (lastMessage.role === 'model' && lastMessage.parts?.length) {
            prepend = lastMessage.parts.map((x: any) => x.text || '').join('');
        }

        if (this.threadLocal.ctx?.tokenUsage === undefined) {
            this.threadLocal.ctx.tokenUsage = {};
        }
        if (this.threadLocal.ctx?.tokenUsage[modelName] === undefined) {
            this.threadLocal.ctx.tokenUsage[modelName] = {};
        }

        const usageTrack = this.threadLocal.ctx.tokenUsage[modelName];

        if (modelOpts?.stream) {
            const r = await client.streamComplete(modelName, opts as any, requestOptions);
            this.logger.debug(`Streaming response from ${modelName} by ${client.name}`);
            let lastUsage = {};
            (r.data as Readable).once('end', () => {
                this.logger.debug(`Streaming completed from ${modelName} by ${client.name}`);
                usageTrack.inputTokens ??= 0;
                usageTrack.outputTokens ??= 0;
                usageTrack.inputTokens += _.get(lastUsage, 'promptTokenCount', 0);
                usageTrack.outputTokens += _.get(lastUsage, 'candidatesTokenCount', 0);
            });

            (r.data as Readable).on('data', (data) => {
                if (data.usageMetadata) {
                    lastUsage = data.usageMetadata;
                }
            });

            const streams = _.range(0, modelOpts?.n || 1).map(
                (i) =>
                    (r.data as any as Readable).pipe(
                        new GeminiResponseStream(i, prepend)
                    )
            );

            if (modelOpts?.n && modelOpts.n > 1) {
                return streams as any;
            }

            const onlyStream: GeminiResponseStream = streams[0];
            onlyStream.once('end', () => {
                if (!(r.data as Readable)?.readableEnded) {
                    (r.data as Readable).destroy();
                }
                usageTrack.inputTokens ??= 0;
                usageTrack.outputTokens ??= 0;

                usageTrack.inputTokens += _.get(streams[0], 'accumulatedObject.usage.prompt_tokens', 0);
                usageTrack.outputTokens += _.get(streams[0], 'accumulatedObject.usage.completion_tokens', 0);
            });

            return onlyStream as any;
        }

        const r = await client.complete(modelName, opts as any, requestOptions);

        const rData = r.data;
        this.logger.debug(`Received response from ${modelName} by ${client.name}. ${rData.candidates?.length || 0} candidates.`);

        usageTrack.inputTokens ??= 0;
        usageTrack.outputTokens ??= 0;
        usageTrack.inputTokens += _.get(rData, 'usageMetadata.promptTokenCount', 0);
        usageTrack.outputTokens += _.get(rData, 'usageMetadata.candidatesTokenCount', 0);

        const rets = _(rData).get('candidates', []).map((x) => {
            if (x?.finishReason === FinishReason.SAFETY) {
                const filterDetails = x.safetyRatings;
                if (Array.isArray(filterDetails)) {
                    for (const v of filterDetails) {
                        if (v?.blocked) {
                            throw new HarmfulContentError(`Your input is filtered because it provokes ${v.category}. Please change your input and try again.`);
                        }
                    }
                }
                this.logger.warn(`Received content triggers safety restriction`);
                throw new HarmfulContentError('Output possibly includes harmful contents, please check your input.');
            }

            if (!x.content.parts) {
                if (x?.finishReason === FinishReason.RECITATION) {
                    throw new DownstreamServiceFailureError(`Received content without parts: ${x.finishReason}`);
                }

                this.logger.warn(`Received content candidate without parts: ${x.finishReason}`);

                return '';
            }
            const fnCalls = x.content.parts.filter((x) => x.functionCall);
            if (fnCalls.length) {
                return LLMFunctionCallRequest.from({
                    text: prepend + x.content.parts.filter((x) => x.text).map((x) => x.text || '').join('') || '',
                    functionCalls: fnCalls.map((x) => ({
                        name: x.functionCall!.name,
                        arguments: x.functionCall!.args,
                    }))
                });
            }

            return prepend + x.content.parts.map((x) => x.text || '').join('') || '';
        });

        if (modelOpts?.n && modelOpts.n > 1) {
            return rets as any;
        }

        return rets[0] || '' as any;
    }

    override async encodePromptChunks(promptChunks: string | PromptChunk[] | null): Promise<any> {
        if (!(this.constructor as typeof GeminiPro).interleavedPromptSupported) {
            return [{ text: await super.encodePromptChunks(promptChunks) }];
        }

        if (typeof promptChunks === 'string') {
            return [{ text: promptChunks }];
        }

        if (!promptChunks) {
            return [{ text: '' }];
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
                const r = {
                    inlineData: {
                        mimeType: `${mimeVec.mediaType}/${mimeVec.subType}`,
                        data: buff.toString('base64'),
                    }
                };
                this.tempFileManager.bindPathTo(r, tmpPath);

                return r;
            }

            if (x instanceof Blob) {
                return {
                    inlineData: {
                        mimeType: x.type,
                        data: Buffer.from(await x.arrayBuffer()).toString('base64')
                    }
                };
            }

            if (Buffer.isBuffer(x)) {
                const mimeInfo = await mimeOf(x);
                return {
                    inlineData: {
                        mimeType: `${mimeInfo.mediaType}/${mimeInfo.subType}`,
                        data: x.toString('base64')
                    }
                };
            }

            return x;
        });

        return await Promise.all(ps);
    }

    override async getFunctionCallMessage(thing: unknown) {
        if (thing instanceof LLMFunctionCallRequest) {
            return {
                role: 'model',
                content: thing.text,
                parts: thing.functionCalls.map((x) => ({
                    functionCall: {
                        name: x.name,
                        args: x.arguments
                    }
                })),
            } as LLMMessage;
        }

        if (thing instanceof LLMFunctionCallResponse) {
            return {
                role: 'user',
                content: null,
                parts: [{
                    functionResponse: {
                        name: thing.name,
                        response: {
                            name: thing.name,
                            content: thing.content,
                        },
                    }
                }]
            } as LLMMessage;
        }

        return super.getFunctionCallMessage(thing);
    }

    override async structured<U extends (typeof LLMDto), MO extends FunctionCallingAwareLLMModelOptions<GeminiModelOptions>>(
        expectOutputClass: U,
        input: string | FunctionCallingAwareLLMMessage[],
        modelOpts?: MO,
        execOpts?: {
            maxTry?: number;
            requestOptions?: HTTPServiceRequestOptions,
            delayFactor?: number;
            reverseProviderPreference?: boolean;
            filterClients?: (client: GoogleGeminiHTTP) => boolean;
            asyncValidate?: (parsed: InstanceType<U>, raw: string) => Promise<boolean>;
            peekStream?: LLMPeakStream;
            peekChannel?: string;
            collectRawOutput?: (rawOutput: any) => void;
            collectRawInput?: (
                options: FunctionCallingAwareLLMModelOptions<unknown>,
                prompt?: string | PromptChunk[],
            ) => void;
        }
    ): Promise<DetectFunctions<MO, InstanceType<U>>> {
        const messages: LLMModelOptions<GeminiModelOptions>['messages'] = [
            ...(
                typeof input === 'string' ?
                    [{ role: 'user', content: input }] :
                    await Promise.all(
                        input.map(
                            (x) => {
                                if ((x as LLMMessage).role) {
                                    return x as LLMMessage;
                                }
                                return this.getFunctionCallMessage(x);
                            }
                        )
                    )
            )
        ];
        if (modelOpts?.messages?.length) {
            messages.push(...await Promise.all(
                modelOpts.messages.map(
                    (x) => {
                        if ((x as LLMMessage).role) {
                            return x as LLMMessage;
                        }
                        return this.getFunctionCallMessage(x);
                    }
                )
            ));
        }

        const expectedObjectLike = isAutoCastableClass(expectOutputClass);
        let lastError = '';
        let triesLeft = execOpts?.maxTry || 3;
        const functionUsed = (modelOpts?.functions || modelOpts?.modelSpecific?.tools);
        const jsonModeDisabilityToCallFunctions = (this.constructor as typeof GeminiPro).jsonModeDisabilityToCallFunctions;

        let trick: undefined | 'jsonMode' = undefined;

        if (expectedObjectLike) {
            if (functionUsed) {
                if (!jsonModeDisabilityToCallFunctions) {
                    trick = 'jsonMode';
                }
            }
        }

        while (triesLeft > 0) {
            triesLeft -= 1;
            if (lastError) {
                execOpts?.peekStream?.write({
                    event: 'retry',
                    id: execOpts.peekChannel ? `${execOpts.peekChannel}-${Reflect.get(execOpts.peekStream, 'n') || 0 + 1}` : undefined
                });
            }

            let ret: any;
            let system = modelOpts?.system || '';
            if (trick === undefined) {
                system = `${system ? `${system}\n` : ''}${expectedObjectLike ? expectOutputClass?.toJSONModeSystemPromptFragment?.() : ''}`;
                const opts = {
                    ...modelOpts,
                    system,
                    messages,
                    n: 1
                };

                ret = await this.exec('', opts, execOpts as any);
                execOpts?.collectRawInput?.(opts, '');
            } else if (trick === 'jsonMode') {
                if (
                    !(this.constructor as typeof GeminiPro).jsonModeSchemaSupported &&
                    !system.includes('JSON') &&
                    !((modelOpts?.messages?.find((x) => (x as LLMMessage).role === 'system') as LLMMessage)?.content?.includes('JSON'))
                ) {
                    system = `${system ? `${system}\n` : ''}${expectedObjectLike ? expectOutputClass?.toJSONModeSystemPromptFragment?.() : ''}`;
                }
                const opts = {
                    ...modelOpts,
                    modelSpecific: {
                        generationConfig: {
                            responseMimeType: 'application/json',
                            responseSchema: (this.constructor as typeof GeminiPro).jsonModeSchemaSupported ? expectOutputClass.JSONSchema : undefined,
                        }
                    },
                    messages,
                    n: 1,
                    system,
                };
                if (jsonModeDisabilityToCallFunctions) {
                    opts.function_call = undefined;
                    opts.functions = undefined;
                }
                ret = await this.exec('', opts, execOpts as any) as string;
                execOpts?.collectRawInput?.(opts, '');
            }
            execOpts?.collectRawOutput?.(ret);

            const textChunks: string[] = [];
            if (isReadable(ret as Readable)) {
                let lastNonTextChunk;
                (ret as Readable).on('data', (c: any) => {
                    if (typeof c === 'string') {
                        textChunks.push(c);
                        execOpts?.peekStream?.write({
                            event: 'chunk',
                            data: c,
                            id: execOpts.peekChannel ? `${execOpts.peekChannel}-${Reflect.get(execOpts.peekStream, 'n') || 0 + 1}` : undefined
                        });
                    } else {
                        lastNonTextChunk = c;
                    }
                });
                await once(ret, 'end');
                ret = lastNonTextChunk || textChunks.join('');
            }
            execOpts?.peekStream?.write({
                event: 'response',
                data: ret,
                id: execOpts.peekChannel ? `${execOpts.peekChannel}-${Reflect.get(execOpts.peekStream, 'n') || 0 + 1}` : undefined
            });

            if (ret instanceof LLMFunctionCallRequest) {
                return ret as any;
            } else if (typeof ret === 'string') {
                messages.push({
                    role: 'assistant',
                    content: ret,
                });
            }
            let structure: InstanceType<U>;
            try {
                structure = expectOutputClass.fromString ? expectOutputClass.fromString(ret as string) as InstanceType<U> :
                    isPrimitiveType(expectOutputClass) ?
                        expectOutputClass.call(undefined, ret) as InstanceType<U> :
                        Reflect.construct(expectOutputClass, [ret]) as InstanceType<U>;
            } catch (err: any) {
                lastError = err?.readableMessage || err?.message || 'Invalid response';
                const errorMsg = `[SYSTEM] Error: ${lastError}\nTry again. Note: this is a system message. DO NOT REPLY.`;
                execOpts?.peekStream?.write({
                    event: 'exception',
                    data: errorMsg,
                    id: execOpts.peekChannel ? `${execOpts.peekChannel}-${Reflect.get(execOpts.peekStream, 'n') || 0 + 1}` : undefined
                });
                messages.push({ role: 'user', content: errorMsg });
                if (trick === undefined && expectedObjectLike) {
                    trick = 'jsonMode';
                }

                continue;
            }

            if (execOpts?.asyncValidate) {
                try {
                    execOpts?.peekStream?.write({
                        event: 'check',
                        id: execOpts.peekChannel ? `${execOpts.peekChannel}-${Reflect.get(execOpts.peekStream, 'n') || 0 + 1}` : undefined
                    });
                    const validated = await execOpts.asyncValidate(
                        structure as any,
                        ret || ''
                    );

                    if (!validated) {
                        throw new Error('Invalid response');
                    }
                } catch (err: any) {
                    lastError = err?.readableMessage || err?.message || 'Invalid response';
                    const errorMsg = `[SYSTEM] Error: ${lastError}\nTry again. Note: this is a system message. DO NOT REPLY.`;
                    execOpts?.peekStream?.write({
                        event: 'exception',
                        data: errorMsg,
                        id: execOpts.peekChannel ? `${execOpts.peekChannel}-${Reflect.get(execOpts.peekStream, 'n') || 0 + 1}` : undefined
                    });
                    messages.push({ role: 'user', content: errorMsg });
                    continue;
                }
            }
            execOpts?.peekStream?.write({
                event: 'result',
                data: structure,
                id: execOpts.peekChannel ? `${execOpts.peekChannel}-${Reflect.get(execOpts.peekStream, 'n') || 0 + 1}` : undefined
            });

            return structure as any;
        }

        throw new DownstreamServiceFailureError(`Failed to parse ${expectOutputClass.name} from LLM: ${lastError}`);

    }
}

@injectable()
export class GeminiProVision extends GeminiPro {
    static override description = 'Google Gemini Pro Vision Model';
    static override aliases = ['gemini-pro-vision'];
    static override modelName = 'gemini-pro-vision';
    static override interleavedPromptSupported = true;
}

@injectable()
export class Gemini25Flash extends GeminiPro {
    static override description = 'Google Gemini 2.5 Flash Model';
    static override aliases = ['gemini-2.5-flash'];
    static override modelName = 'gemini-2.5-flash';
    static override interleavedPromptSupported = true;
    static override jsonModeSchemaSupported = true;
    static override windowSize = 1_000_000;
}

@injectable()
export class Gemini31FlashLite extends GeminiPro {
    static override description = 'Google Gemini 3.1 Flash Lite Preview';
    static override aliases = ['gemini-3.1-flash-lite', 'gemini-3.1-flash-lite-preview'];
    static override modelName = 'gemini-3.1-flash-lite-preview';
    static override interleavedPromptSupported = true;
    static override jsonModeSchemaSupported = true;
    static override windowSize = 1_000_000;
}

@injectable()
export class Gemini31Pro extends GeminiPro {
    static override description = 'Google Gemini 3.1 Pro Preview';
    static override aliases = ['gemini-3.1-pro', 'gemini-3.1-pro-preview'];
    static override modelName = 'gemini-3.1-pro-preview';
    static override interleavedPromptSupported = true;
    static override jsonModeSchemaSupported = true;
    static override windowSize = 1_000_000;
}


class TrimmedSchema extends AutoCastable {

    @Prop()
    description?: string;
    @Prop()
    type?: string;
    // @Prop()
    // format?: string;
    @Prop()
    default?: any;
    @Prop()
    properties?: TrimmedSchema;
    @Prop()
    items?: TrimmedSchema;
    @Prop({
        arrayOf: [Number, String]
    })
    values?: (number | string)[];
    @Prop({
        arrayOf: String
    })
    required?: string[];
    @Prop({
        arrayOf: String
    })
    enum?: string[];
    // @Prop()
    // additionalProperties?: boolean;
    @Prop()
    nullable?: boolean;

}

export function trimJSONSchema(schema: object) {
    return TrimmedSchema.from(schema);
}

export function trimFunctionSchemas(schemas: any[]) {
    return schemas.map((x) => ({ ...x, parameters: trimJSONSchema(x.parameters) }));
}
