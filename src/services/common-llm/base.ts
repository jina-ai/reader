import {
    ApplicationError, AutoCastable, DownstreamServiceFailureError,
    OpenAPIManager, Prop, autoConstructor, isAutoCastableClass
} from 'civkit/civ-rpc';
import { InputServerEventStream } from '../../lib/transform-server-event-stream';
import { PassThrough, Readable, isReadable, once } from 'stream';
import _ from 'lodash';
import { FunctionCallingAwareLLMMessage, FunctionCallingAwareLLMModelOptions, LLMFunctionCall, LLMFunctionCallRequest, LLMFunctionCallResponse, LLMMessage, LLMModelOptions, LLMPeakStream, PromptChunk, parseJSON, stringPromptChunks } from './misc';
import { JSONAccumulation, JSONParserStream } from '../../lib/json-parse-stream';
import { HTTPServiceRequestOptions } from 'civkit/http';
import { AsyncService } from 'civkit/async-service';
import { LoggerInterface } from 'civkit/logger';
import { HarmfulContentError } from '../errors';
import { delay } from 'civkit/timeout';
import { isPrimitiveType } from 'civkit/lang';
export { LLMModelOptions, PromptChunk } from './misc';


const FUNCTION_NAME = 'return';
const FUNCTION_DESCRIPTION = 'Return and continue to execute down-stream programmes with requested JSON data.';
export function replaceNewlinesInJSONString(jsonString: string) {
    const chunks: string[] = [];
    let isInString = false;
    let isEscaped = false;

    for (let i = 0; i < jsonString.length; i++) {
        const char = jsonString[i];

        if (!isInString && char === '"') {
            // Start of a string
            isInString = true;
            isEscaped = false;
            chunks.push(char);
        } else if (isInString && char === '\\' && !isEscaped) {
            // Escape character
            isEscaped = true;
            chunks.push(char);
        } else if (isInString && isEscaped) {
            // Character after an escape character
            isEscaped = false;
            chunks.push(char);
        } else if (isInString && char === '"') {
            // End of a string
            isInString = false;
            chunks.push(char);
        } else if (isInString && (char === '\n' || char === '\r')) {
            // Newline or carriage return character inside a string
            chunks.push(char === '\n' ? '\\n' : '\\r');
        } else {
            // Any other character outside a string
            // or any non-newline or non-carriage return character inside a string
            chunks.push(char);
        }
    }

    return chunks.join('');
}

const JSONSchemaCache = new WeakMap<typeof LLMDto, any>();

export class LLMDto extends AutoCastable {
    static fromFunctionCall(input: LLMFunctionCall): ReturnType<typeof autoConstructor> {
        return this.fromString(input.arguments);
    }

    static fromString(input: string): ReturnType<typeof autoConstructor> {
        const r = parseJSON(input);

        return super.from(r);
    }

    static get JSONSchema() {
        if (JSONSchemaCache.has(this)) {
            return JSONSchemaCache.get(this);
        }

        const openAPIManager = new OpenAPIManager();
        openAPIManager.enrichDescriptions = false;

        const schema = openAPIManager.constructorToOpenAPISchema(this, 'input', false);

        JSONSchemaCache.set(this, schema);

        return schema;
    }


    static toFunctionCallPartialOptions() {
        const funcDesc = {
            name: FUNCTION_NAME,
            description: FUNCTION_DESCRIPTION,
            parameters: this.JSONSchema,
        };

        return {
            functions: [funcDesc],
            function_call: { name: FUNCTION_NAME },
        };
    }

    static toJSONModeSystemPromptFragment() {
        return `Provide your response in the following JSON Schema (https://json-schema.org/specification): \n${JSON.stringify(this.JSONSchema)}`;
    }
}

export function constructFunctionCallPartialOptionsFor(cls: typeof String | typeof Number | typeof Boolean) {
    const funcDesc = {
        name: FUNCTION_NAME,
        description: FUNCTION_DESCRIPTION,
        parameters: {
            type: 'object',
            properties: {
                data: {
                    type: cls.name.toLowerCase(),
                    description: 'The JSON data down-stream programs will receive.'
                },
            },
            required: ['data']
        }
    };

    return {
        functions: [funcDesc],
        function_call: { name: FUNCTION_NAME },
    };
}

export function parsePrimitiveFromFunctionCall(ret: { name: string, arguments: string; }) {
    const r = JSON.parse(replaceNewlinesInJSONString(ret.arguments));

    return r.data;
}

export class AnyJSON extends LLMDto {
    static override fromString(input: string): ReturnType<typeof autoConstructor> {
        const r = JSON.parse(input);

        return super.from({ data: r });
    }

    @Prop({
        desc: 'The JSON data down-stream programs will receive.'
    })
    data: any;
}


export interface LLMWorkerFunc<T> {
    (prompt: string, modelOpts?: FunctionCallingAwareLLMModelOptions<T> & { stream: true; }, requestOptions?: HTTPServiceRequestOptions): Promise<InputServerEventStream>;
    (prompt: string, modelOpts?: FunctionCallingAwareLLMModelOptions<T> & { stream?: false | void; }, requestOptions?: HTTPServiceRequestOptions): Promise<string>;
}

export type DetectFunctions<T extends FunctionCallingAwareLLMModelOptions<unknown>, U = string> =
    T['functions'] extends Array<infer _T> ?
    T['function_call'] extends 'none' ?
    U : T['function_call'] extends 'auto' | void | null | undefined ?
    U | LLMFunctionCallRequest : T['function_call'] extends object ?
    LLMFunctionCallRequest : LLMFunctionCallRequest | U : U;
type DetectStream<T extends FunctionCallingAwareLLMModelOptions<unknown>> = T['stream'] extends true ? Readable : DetectFunctions<T>;
type DetectN<T extends FunctionCallingAwareLLMModelOptions<unknown>> = T['n'] extends void | null | undefined | unknown | 0 | 1 ? DetectStream<T> : Array<DetectStream<T>>;

export type DependsOnOptions<T extends FunctionCallingAwareLLMModelOptions<unknown>> = DetectN<T>;

export abstract class AbstractLLM<T, C = unknown> extends AsyncService {
    static aliases?: string[];
    static description?: string;
    static streamingSupported?: boolean;
    static systemSupported?: boolean;
    static chatOptimized?: boolean;
    static windowSize?: number;
    static modelOptionsType?: typeof AutoCastable;
    static nSupported?: boolean;
    static functionCallingSupported?: boolean;
    static functionCalling?: 'native' | 'software' | 'none' | string;
    static attachmentsSupported?: boolean;
    static interleavedPromptSupported?: boolean;
    static partialCompleteSupported?: boolean;

    abstract clients: C[];
    abstract logger: LoggerInterface;

    abstract _run<U extends LLMModelOptions<T>>(
        client: this['clients'][number],
        prompt: string,
        modelOpts?: U,
        requestOptions?: HTTPServiceRequestOptions
    ): Promise<DependsOnOptions<U>>;

    protected clientBlockade: Map<C, Date> = new Map();

    async getFunctionCallMessage<T = unknown>(thing: T): Promise<LLMMessage> {
        if (this.functionCalling === 'software') {
            if (thing instanceof LLMFunctionCallRequest) {
                return {
                    role: 'assistant',
                    content: `${thing.text || ''}${thing.text ? '\n' : ''}${JSON.stringify({
                        intention: 'USE_TOOLS',
                        tools: thing.functionCalls
                    })}`,
                } as LLMMessage;
            }

            if (thing instanceof LLMFunctionCallResponse) {
                return {
                    role: 'user',
                    name: thing.name ? `tool: ${thing.name}` : 'tool',
                    content: thing.functionCallId ? `[Call ${thing.functionCallId}] Response: ${JSON.stringify(thing.content)}` : JSON.stringify(thing.content),
                };
            }
        }

        throw new Error('Not Implemented');
    }

    async run<U extends FunctionCallingAwareLLMModelOptions<T>>(
        client: this['clients'][number],
        prompt: string | PromptChunk[],
        modelOpts?: U,
        requestOptions?: HTTPServiceRequestOptions
    ): Promise<DependsOnOptions<U>> {
        const runArgs: Parameters<this['_run']> = [client, '', { ...modelOpts }, requestOptions] as any;

        if (this.interleavedPromptSupported || typeof prompt === 'string' || !prompt) {
            runArgs[1] = prompt as string;
        } else {
            runArgs[2] = {
                ...runArgs[2],
                messages: [
                    ...(runArgs[2]?.messages || []),
                    { role: 'user', content: prompt }
                ]
            };
        }

        if (runArgs[2]?.messages?.length) {
            runArgs[2].messages = await Promise.all(
                runArgs[2].messages.map((x) => {
                    if (x.role) {
                        return x;
                    }

                    return this.getFunctionCallMessage(x);
                })
            );
        }


        if (this.functionCalling === 'software' && runArgs[2]?.functions?.length) {
            if (!this.systemSupported || !this.streamingSupported) {
                throw new Error('System prompt and streaming must be supported to use software function calling.');
            }
            const descriptors = runArgs[2].functions;
            const enforce = (runArgs[2].function_call as any)?.name;
            const systemPromptMixin = `Being a smart assistant, there are several tools made available to you (described in JSON list below):
${JSON.stringify(descriptors)}
Rules:
To invoke one or more tools, you need to respond (and only respond) with a clean JSON object with the following structure:
${JSON.stringify({
                intention: 'USE_TOOLS',
                tools: [
                    {
                        name: 'exampleTool1',
                        arguments: {
                            exampleArgName1: 'exampleValue1', exampleArgName2: 'ExampleValue2'
                        },
                        id: 'TOOL_1_CALL_1'
                    },
                    {
                        name: 'exampleTool2',
                        arguments: {
                            argumentName: 'value format is defined by each tool description'
                        },
                        id: 'TOOL_2_CALL_1'
                    },
                ]
            })}
This means your response must start with '{' and end with '}'.

You MUST first declare your intention to be exactly USE_TOOLS, then list the tool(s) you want to use.
Provide the name of the tool and the arguments you would like to pass.
The arguments must be a JSON object with its internal structure as defined by the description of each tool (JSON Schema).
Always give an id for each tool call, this is to distinguish between multiple calls when the system responds.
Only then the system will pick up this special format and respond to you in the following message(s), after witch you can continue with responding normal content to the user.
You should always respond to the user in normal format after invoking the tool(s).

${enforce ? `At this time, you MUST invoke the tool named "${enforce}". This is forcefully required by the system.` : 'It would also be perfectly fine if you choose to not invoke any tool. In that case you should directly respond normal content to the user.'}`;

            runArgs[2].system = `${runArgs[2].system || ''}${runArgs[2].system ? '\n' : ''}${systemPromptMixin}`;
            runArgs[2].stream = true;

            return this._run.apply(this, runArgs).then(async (r) => {
                if (!Readable.isReadable(r as any)) {
                    if (typeof r !== 'string') {
                        return r;
                    }

                    const jsonElems = JSONParserStream.parse(r as string, {
                        expectControlCharacterInString: true,
                        expectCasingInLiteral: true,
                        expectAbruptTerminationOfInput: true,
                        expectContaminated: 'object',
                        swallowErrors: true
                    });

                    try {
                        const parsed = JSONAccumulation.parse(jsonElems);

                        if (parsed?.intention === 'USE_TOOLS') {
                            return LLMFunctionCallRequest.from({
                                functionCalls: parsed.tools
                            });
                        }
                    } catch (_err) {
                        void 0;
                    }

                    return r;
                }
                const upstream = r as any as Readable;
                const patchedStream = new PassThrough({
                    objectMode: true,
                    highWaterMark: 4 * 1024
                });
                let n1: number | undefined;
                let n2: number | undefined;

                const textChunks: string[] = [];

                upstream.on('data', (chunk: any) => {
                    if (typeof chunk === 'string') {
                        textChunks.push(chunk);
                    } else {
                        patchedStream.write(chunk);
                    }
                });

                const jsonParserStream = new JSONParserStream({
                    expectControlCharacterInString: true,
                    expectCasingInLiteral: true,
                    expectAbruptTerminationOfInput: true,
                    expectContaminated: 'object',
                    swallowErrors: true
                });
                upstream.pipe(jsonParserStream, { end: true });

                const jsonAccumulationStream = new JSONAccumulation();
                jsonAccumulationStream.on('error', () => 'Do Not Throw');
                jsonParserStream.pipe(jsonAccumulationStream, { end: true });
                jsonParserStream.once('error', (err) => {
                    jsonAccumulationStream.destroy(err);
                });
                jsonAccumulationStream.resume();
                jsonAccumulationStream.once('final', (final) => {
                    if (!final || typeof final !== 'object') {
                        return;
                    }
                    if (final.intention !== 'USE_TOOLS') {
                        patchedStream.write(final);
                        return;
                    }
                    const toolCalls = final.tools;
                    if (!Array.isArray(toolCalls)) {
                        return;
                    }
                    for (const toolCall of toolCalls) {
                        patchedStream.emit('call', toolCall, toolCall.id);
                    }
                    patchedStream.write(toolCalls);
                });

                jsonParserStream.once('n1', (_n1) => {
                    n1 = _n1;
                    patchedStream.write(textChunks.join('').slice(0, n1));
                });
                jsonParserStream.once('n2', (_n2) => {
                    n2 = _n2;
                });

                jsonParserStream.once('end', () => {
                    if (n2) {
                        const suffix = textChunks.join('').slice(n2);
                        if (suffix) {
                            patchedStream.end(suffix);
                        } else {
                            patchedStream.end();
                        }
                    }
                });

                return patchedStream;
            }) as any;
        }

        return this._run.apply(this, runArgs) as any;
    }

    async withClient(func: (client: C) => any, options: {
        maxTry?: number;
        delayFactor?: number;
        reverseProviderPreference?: boolean;
        filterClients?: (client: C) => boolean;
    } = {}): Promise<ReturnType<typeof func>> {
        await this.serviceReady();

        const filteredClients = options?.filterClients ? this.clients.filter(options.filterClients) : this.clients;
        const gentleClients = this.filterClientsByAvailability(filteredClients);
        const clients = gentleClients.length ? gentleClients : filteredClients;
        if (!clients.length) {
            throw new Error('Model client not ready');
        }

        const maxTry = options?.maxTry ?? (clients.length + 1);
        let i = 0;
        while (true) {
            for (const client of options.reverseProviderPreference ? [...clients].reverse() : clients) {
                if (typeof client !== 'object' || !client) {
                    throw new Error('Invalid client');
                }
                try {
                    this.logger.debug(`Calling LLM model ${this.constructor.name} with ${(client as any).name || client.constructor.name}`);
                    const t0 = Date.now();

                    const r = await func(client);

                    if (isReadable(r as any)) {
                        (r as unknown as Readable).once('end', () => {
                            this.logger.debug(`Streaming succeeded. LLM model ${this.constructor.name} with ${(client as any).name || client.constructor.name} in ${Date.now() - t0}ms.`);
                        });
                    } else {
                        this.logger.debug(`Call succeeded. LLM model ${this.constructor.name} with ${(client as any).name || client.constructor.name} in ${Date.now() - t0}ms.`);
                    }

                    return r;
                } catch (err: any) {
                    if (err?.cause instanceof ApplicationError) {
                        const realError = err.cause;
                        this.logger.error(`Failed to run LLM model ${this.constructor.name} with ${(client as any).name || client.constructor.name}. Non recoverable error: Code ${realError.code}.`, { error: realError });
                        throw realError;
                    }
                    const code = err.status || (err as any).code;
                    if ((((client as any).Error && err instanceof (client as any).Error) || err instanceof HarmfulContentError) && (typeof code === 'number')) {
                        if (code !== 20 && code !== 429 && code !== 401 && !(code >= 500 && code < 600)) {
                            this.logger.error(`Failed to run LLM model ${this.constructor.name} with ${(client as any).name || client.constructor.name}. Non recoverable error: Code ${code}.`, { error: err });

                            throw new DownstreamServiceFailureError({
                                message: `Failed to run LLM model ${this.constructor.name} with ${(client as any).name || client.constructor.name}. Non recoverable error: Code ${code}.`,
                                err
                            });
                        }
                    }

                    this.clientAvailabilityRoutine(client, err);
                    if (++i >= maxTry) {
                        this.logger.error(`Failed to run LLM model ${this.constructor.name} with ${(client as any).name || client.constructor.name}. No tries left.`, { error: err });
                        throw err;
                    }
                    const delayMs = Math.floor((options?.delayFactor ?? 1) * (1 + Math.random() * 0.4 - 0.2) * 100);
                    this.logger.warn(`Failed to run LLM model ${this.constructor.name} with ${(client as any).name || client.constructor.name}, retrying after ${delayMs}ms...`, { error: err });
                    await delay(delayMs);
                }
            }
        }

        throw new Error('unreachable');
    }


    exec(prompt: string | PromptChunk[]): Promise<string>;
    exec<U extends FunctionCallingAwareLLMModelOptions<T>>(
        prompt: string | PromptChunk[],
        modelOpts?: U,
        execOpts?: {
            maxTry?: number;
            requestOptions?: HTTPServiceRequestOptions,
            delayFactor?: number;
            reverseProviderPreference?: boolean;
            filterClients?: (client: C) => boolean;
        }
    ): Promise<DependsOnOptions<U>>;
    exec<U extends FunctionCallingAwareLLMModelOptions<T>>(
        prompt: string | PromptChunk[],
        modelOpts?: U,
        execOpts?: {
            maxTry?: number;
            requestOptions?: HTTPServiceRequestOptions,
            delayFactor?: number;
            reverseProviderPreference?: boolean;
            filterClients?: (client: C) => boolean;
        }
    ): Promise<
        DependsOnOptions<U>
    > {
        const requestOptions = execOpts?.requestOptions;

        this.logger.info(`Executing LLM ${this.constructor.name}...`, { modelOpts, requestOptions });

        return this.withClient((client) => this.run(client, prompt, modelOpts, requestOptions), execOpts);
    }

    iterExec(prompt: string | PromptChunk[]): AsyncGenerator<string>;
    iterExec<U extends FunctionCallingAwareLLMModelOptions<T>>(
        prompt: string | PromptChunk[],
        modelOpts?: U,
        execOpts?: {
            maxTry?: number;
            requestOptions?: HTTPServiceRequestOptions,
            delayFactor?: number;
            reverseProviderPreference?: boolean;
            filterClients?: (client: C) => boolean;
            collectRawOutput?: (rawOutput: any) => void;
        }
    ): AsyncGenerator<DetectFunctions<U>>;
    async *iterExec<U extends FunctionCallingAwareLLMModelOptions<T>>(
        prompt: string | PromptChunk[],
        modelOpts?: U,
        execOpts?: {
            maxTry?: number;
            requestOptions?: HTTPServiceRequestOptions,
            delayFactor?: number;
            reverseProviderPreference?: boolean;
            filterClients?: (client: C) => boolean;
            collectRawOutput?: (rawOutput: any) => void;
        }
    ): AsyncGenerator<DetectFunctions<U>> {
        if (!this.streamingSupported) {
            throw new Error(`Not Implemented: streaming not supported`);
        }

        const presumedStream = await this.exec(prompt, { ...modelOpts, stream: true }, execOpts);
        execOpts?.collectRawOutput?.(presumedStream);
        if (!isReadable(presumedStream)) {
            throw new Error(`Flawed implementation: expected Readable, received: ${presumedStream.constructor.name}`);
        }
        const stringChunks: string[] = [];
        const nonStringChunks: LLMFunctionCallRequest[] = [];
        let ended = false;
        let error: any;
        presumedStream.once('error', (err) => error = err);
        presumedStream.once('end', () => ended = true);
        presumedStream.on('data', (chunk: any) => {
            if (typeof chunk === 'string' && chunk) {
                stringChunks.push(chunk);
                return;
            }

            if (chunk) {
                nonStringChunks.push(chunk);
            }
        });

        const everEnd = once(presumedStream, 'end');

        while (true) {
            if (!ended && !error && !stringChunks.length) {
                await Promise.race([once(presumedStream, 'data'), everEnd]).catch(() => 'ignored');
            }
            if (error) {
                throw error;
            }

            if (ended) {
                if (stringChunks.length) {
                    yield stringChunks.join('') as any;
                }
                if (nonStringChunks.length) {
                    for (const chunk of nonStringChunks) {
                        yield chunk as any;
                    }
                }

                break;
            }

            if (stringChunks.length) {
                yield stringChunks.join('') as any;
                stringChunks.length = 0;
                continue;
            }
        }
    }

    async structured<U extends (typeof LLMDto), MO extends FunctionCallingAwareLLMModelOptions<T>>(
        expectOutputClass: U,
        input: string | FunctionCallingAwareLLMMessage[],
        modelOpts?: MO,
        execOpts?: {
            maxTry?: number;
            requestOptions?: HTTPServiceRequestOptions,
            delayFactor?: number;
            reverseProviderPreference?: boolean;
            filterClients?: (client: C) => boolean;
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
        const messages: LLMModelOptions<T>['messages'] = [
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

        const optsMixin = expectOutputClass.toFunctionCallPartialOptions?.() ||
            constructFunctionCallPartialOptionsFor(expectOutputClass as any);
        if (modelOpts?.functions?.length) {
            Reflect.deleteProperty(optsMixin, 'function_call');
            optsMixin.functions.push(...modelOpts.functions);
        }

        let lastError = '';
        let triesLeft = execOpts?.maxTry || 3;
        let useFunctionCall = false;
        let usedFunctionCall = false;
        let fnCall: undefined | LLMFunctionCall = undefined;
        while (triesLeft > 0) {
            triesLeft -= 1;
            if (lastError) {
                execOpts?.peekStream?.write({
                    event: 'retry',
                    id: execOpts.peekChannel ? `${execOpts.peekChannel}-${Reflect.get(execOpts.peekStream, 'n') || 0 + 1}` : undefined
                });
            }

            let ret: any;
            if (this.functionCallingSupported && useFunctionCall) {
                usedFunctionCall = true;
                // Managed by Messages object
                const opts = {
                    ...modelOpts,
                    messages,
                    ...optsMixin,
                    n: 1,
                };
                ret = await this.exec<LLMModelOptions<T>>('', opts, execOpts);
                execOpts?.collectRawInput?.(opts, '');
            } else {
                usedFunctionCall = false;
                // Managed by Messages object
                const opts = {
                    ...modelOpts,
                    messages,
                    n: 1,
                };
                ret = await this.exec<LLMModelOptions<T>>('', opts, execOpts);
                execOpts?.collectRawInput?.(opts, '');
            }
            execOpts?.collectRawOutput?.(ret);

            const textChunks: string[] = [];
            if (isReadable(ret)) {
                let lastNonTextChunk;
                ret.on('data', (c: any) => {
                    if (typeof c === 'string') {
                        textChunks.push(c);
                        execOpts?.peekStream?.write({
                            event: 'chunk',
                            data: c,
                            id: execOpts.peekChannel ? `${execOpts.peekChannel}-${Reflect.get(execOpts.peekStream, 'n') || 0 + 1}` : undefined
                        });
                    } else if (c && typeof c === 'object') {
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
                if (ret.functionCalls.some((x) => x?.name && x.name !== optsMixin.function_call?.name)) {

                    return ret as any;
                }
                fnCall = ret.functionCalls.find((x) => x.name === optsMixin.function_call?.name);
                if (fnCall) {
                    messages.push(
                        await this.getFunctionCallMessage(ret)
                    );
                }
            } else if (typeof ret === 'string') {
                messages.push({
                    role: 'assistant',
                    content: ret,
                });
                fnCall = undefined;
            } else {
                fnCall = undefined;
            }

            let structure: InstanceType<U>;
            try {
                if (usedFunctionCall) {
                    fnCall = (ret as LLMFunctionCallRequest).functionCalls[0];
                    structure = expectOutputClass.fromFunctionCall ?
                        expectOutputClass.fromFunctionCall(fnCall) as InstanceType<U> :
                        isPrimitiveType(expectOutputClass) ?
                            expectOutputClass.call(undefined, parsePrimitiveFromFunctionCall(fnCall)) as InstanceType<U> :
                            Reflect.construct(expectOutputClass, [parsePrimitiveFromFunctionCall(fnCall)]) as InstanceType<U>;
                } else {
                    structure = expectOutputClass.fromString ? expectOutputClass.fromString(ret as string) as InstanceType<U> :
                        isPrimitiveType(expectOutputClass) ?
                            expectOutputClass.call(undefined, ret) as InstanceType<U> :
                            Reflect.construct(expectOutputClass, [ret]) as InstanceType<U>;
                }
            } catch (err: any) {
                lastError = err?.readableMessage || err?.message || 'Invalid response';
                const errorMsg = `[SYSTEM] Error: ${lastError}\nTry again. Note: this is a system message. DO NOT REPLY.`;
                execOpts?.peekStream?.write({
                    event: 'exception',
                    data: errorMsg,
                    id: execOpts.peekChannel ? `${execOpts.peekChannel}-${Reflect.get(execOpts.peekStream, 'n') || 0 + 1}` : undefined
                });
                if (usedFunctionCall) {
                    messages.push(
                        await this.getFunctionCallMessage(
                            LLMFunctionCallResponse.from({
                                name: FUNCTION_NAME,
                                content: errorMsg,
                                isError: true,
                                functionCallId: fnCall?.id
                            })
                        )
                    );
                } else {
                    messages.push({ role: 'user', content: errorMsg });
                }
                // Structure issue, use function call to improve the structure
                useFunctionCall = true;

                continue;
            }

            if (execOpts?.asyncValidate) {
                try {
                    execOpts?.peekStream?.write({
                        event: 'check',
                        id: execOpts.peekChannel ? `${execOpts.peekChannel}-${Reflect.get(execOpts.peekStream, 'n') || 0 + 1}` : undefined,
                    });
                    const validated = await execOpts.asyncValidate(
                        structure as any,
                        typeof ret === 'string' ? ret : ret.arguments
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
                        id: execOpts.peekChannel ? `${execOpts.peekChannel}-${Reflect.get(execOpts.peekStream, 'n') || 0 + 1}` : undefined,
                    });
                    if (usedFunctionCall) {
                        messages.push(
                            await this.getFunctionCallMessage(
                                LLMFunctionCallResponse.from({
                                    name: FUNCTION_NAME,
                                    content: errorMsg,
                                    isError: true,
                                    functionCallId: fnCall?.id
                                })
                            )
                        );
                    } else {
                        messages.push({ role: 'user', content: errorMsg });
                    }
                    continue;
                }
            }

            execOpts?.peekStream?.write({
                event: 'result',
                data: structure,
                id: execOpts.peekChannel ? `${execOpts.peekChannel}-${Reflect.get(execOpts.peekStream, 'n') || 0 + 1}` : undefined,
            });

            return structure as any;
        }

        execOpts?.peekStream?.write({
            event: 'error',
            data: lastError.toString(),
            id: execOpts.peekChannel ? `${execOpts.peekChannel}-${Reflect.get(execOpts.peekStream, 'n') || 0 + 1}` : undefined,
        });

        throw new DownstreamServiceFailureError(`Failed to parse ${expectOutputClass.name} from LLM: ${lastError}`);
    }

    async *iterStructured<U extends (typeof LLMDto), MO extends FunctionCallingAwareLLMModelOptions<T>>(
        expectOutputClass: U,
        input: string | FunctionCallingAwareLLMMessage[],
        modelOpts?: MO,
        execOpts?: {
            maxTry?: number;
            requestOptions?: HTTPServiceRequestOptions,
            delayFactor?: number;
            reverseProviderPreference?: boolean;
            filterClients?: (client: C) => boolean;
            asyncValidate?: (parsed: InstanceType<U>, raw: string) => Promise<boolean>;
            peekStream?: LLMPeakStream;
            peekChannel?: string;
            collectRawOutput?: (rawOutput: any) => void;
            collectRawInput?: (
                options: FunctionCallingAwareLLMModelOptions<unknown>,
                prompt?: string | PromptChunk[],
            ) => void;
            yieldDespiteConstructionFailure?: boolean;
        }
    ): AsyncGenerator<DetectFunctions<InstanceType<U> | Partial<InstanceType<U>>>> {
        if (!this.streamingSupported) {
            throw new Error(`Not Implemented: streaming not supported`);
        }
        const peekStream = new PassThrough({
            objectMode: true,
            highWaterMark: 4 * 1024
        });
        if (execOpts?.peekStream) {
            peekStream.pipe(execOpts.peekStream, { end: false });
        }
        let error: any;
        let final: any = undefined;
        if (!isAutoCastableClass(expectOutputClass)) {
            const chunks: string[] = [];
            peekStream.on('data', (sseMessage) => {
                switch (sseMessage.event) {
                    case 'retry': {
                        chunks.length = 0;
                        break;
                    }

                    case 'chunk': {
                        chunks.push(sseMessage.data);
                        break;
                    }

                    case 'result': {
                        break;
                    }

                    default: {
                        break;
                    }
                }
            });
            const finalP = this.structured(expectOutputClass, input, modelOpts, { ...execOpts, peekStream })
                .then((r) => final = r)
                .catch((err) => error = err);

            try {
                while (true) {
                    if (!final && !error) {
                        await Promise.race([once(peekStream, 'data').catch(() => 'ignore'), finalP]);
                    }
                    if (error) {
                        throw error;
                    }
                    if (final) {
                        yield final;
                        break;
                    }

                    try {
                        const r = isPrimitiveType(expectOutputClass) ?
                            expectOutputClass.call(undefined, chunks.join('')) :
                            Reflect.construct(expectOutputClass, [chunks.join('')]);
                        yield r as any;
                    } catch (_err) {
                        if (execOpts?.yieldDespiteConstructionFailure) {
                            yield chunks.join('') as any;
                        }
                    }
                }
            } finally {
                peekStream.end();
            }

            return;
        }

        let jsonParserStream = new JSONParserStream({
            expectControlCharacterInString: true,
            expectCasingInLiteral: true,
            expectContaminated: 'object',
            expectAbruptTerminationOfInput: true,
        });
        let jsonAccumulationStream = new JSONAccumulation();
        jsonParserStream.pipe(jsonAccumulationStream);
        jsonAccumulationStream.resume();
        let softError;
        jsonAccumulationStream.on('error', (err) => {
            softError = err;
        });
        jsonParserStream.on('error', (err) => {
            softError = err;
        });
        peekStream.on('data', (sseMessage) => {
            switch (sseMessage.event) {
                case 'retry': {
                    jsonParserStream = new JSONParserStream({
                        expectControlCharacterInString: true,
                        expectCasingInLiteral: true,
                        expectContaminated: 'object',
                        expectAbruptTerminationOfInput: true,
                    });
                    jsonAccumulationStream = new JSONAccumulation();
                    jsonParserStream.pipe(jsonAccumulationStream);
                    jsonAccumulationStream.resume();
                    jsonAccumulationStream.on('error', (err) => {
                        softError = err;
                    });
                    jsonParserStream.on('error', (err) => {
                        softError = err;
                    });
                    softError = undefined;
                    break;
                }

                case 'chunk': {
                    jsonParserStream.write(sseMessage.data);
                    break;
                }

                case 'result': {
                    break;
                }

                default: {
                    break;
                }
            }
        });
        const finalP = this.structured(expectOutputClass, input, modelOpts, { ...execOpts, peekStream })
            .then((r) => final = r)
            .catch((err) => error = err);

        try {
            while (true) {
                if (!final && !error) {
                    await Promise.race([once(jsonAccumulationStream, 'data').catch(() => 'ignore'), finalP]);
                }
                if (error) {
                    throw error;
                }
                if (final) {
                    yield final;
                    break;
                }

                if (!softError) {
                    try {
                        yield expectOutputClass.from(jsonAccumulationStream.accumulated) as any;
                    } catch (err) {
                        if (execOpts?.yieldDespiteConstructionFailure) {
                            yield jsonAccumulationStream.accumulated;
                        }
                    }
                }
            }
        } finally {
            jsonParserStream.end();
            peekStream.end();
        }

        return;
    }

    async encodePromptChunks(promptChunks: string | PromptChunk[] | null | undefined): Promise<any> {
        return stringPromptChunks(promptChunks);
    }

    protected clientAvailabilityRoutine(client: C, err: Error) {
        if (typeof err !== 'object' || !client) {
            return;
        }

        const safeErr = err as any;

        const retryAfter = safeErr?.retryAfter || safeErr?.retry_after || safeErr?.response?.headers?.get('retry-after');

        if (!retryAfter) {
            return;
        }

        const retryAfterSec = Number.parseInt(retryAfter);

        if (retryAfterSec) {
            this.logger.warn(`Client ${client.constructor.name}(${this.clients.indexOf(client)}) informed blockade for ${retryAfterSec} seconds.`);
            this.clientBlockade.set(client, new Date(Date.now() + retryAfterSec * 1000));

            return;
        }

        const retryAfterDate = new Date(retryAfter);

        if (isNaN(retryAfterDate as any)) {
            return;
        }

        this.logger.warn(`Client ${client.constructor.name}(${this.clients.indexOf(client)}) informed blockade until ${retryAfterDate}.`);
        this.clientBlockade.set(client, retryAfterDate);
    }

    protected filterClientsByAvailability(clients: C[]) {
        const now = new Date();

        const filtered = clients.filter((client) => {
            const blockade = this.clientBlockade.get(client);

            if (!blockade) {
                return true;
            }

            if (blockade < now) {
                return true;
            }

            return false;
        });

        return filtered.length ? filtered : clients;
    }

    get windowSize() {
        return (this.constructor as typeof AbstractLLM).windowSize as number;
    }
    get description() {
        return (this.constructor as typeof AbstractLLM).description;
    }
    get streamingSupported() {
        return (this.constructor as typeof AbstractLLM).streamingSupported || false;
    }
    get chatOptimized() {
        return (this.constructor as typeof AbstractLLM).chatOptimized || false;
    }
    get nSupported() {
        return (this.constructor as typeof AbstractLLM).nSupported || false;
    }
    get functionCalling() {
        return (this.constructor as typeof AbstractLLM).functionCalling;
    }
    get functionCallingSupported() {
        return (this.constructor as typeof AbstractLLM).functionCallingSupported ||
            this.functionCalling === 'native' ||
            this.functionCalling === 'software';
    }
    get attachmentsSupported() {
        return (this.constructor as typeof AbstractLLM).attachmentsSupported || false;
    }
    get interleavedPromptSupported() {
        return (this.constructor as typeof AbstractLLM).interleavedPromptSupported || false;
    }
    get systemSupported() {
        return (this.constructor as typeof AbstractLLM).systemSupported || false;
    }
    get partialCompleteSupported() {
        return (this.constructor as typeof AbstractLLM).partialCompleteSupported || false;
    }
    get aliases() {
        return (this.constructor as typeof AbstractLLM).aliases || [];
    }
    get name() {
        return this.aliases[0];
    }
}
