import { DownstreamServiceFailureError, isAutoCastableClass } from 'civkit/civ-rpc';
import _ from "lodash";
import { injectable } from "tsyringe";

import {
    CHAT_GPT_ROLE,
    ChatGPT0613,
    ChatGPTModelOptions,
} from './gpt-35';
import { OpenAIHTTP } from '../../3rd-party/openai';
import { DetectFunctions, LLMDto } from './base';
import { FunctionCallingAwareLLMMessage, FunctionCallingAwareLLMModelOptions, LLMFunctionCallRequest, LLMMessage, LLMModelOptions, LLMPeakStream, PromptChunk } from './misc';
import { isReadable, once, Readable } from 'stream';
import { HTTPServiceRequestOptions } from 'civkit/http';
import { isPrimitiveType } from 'civkit/lang';

export class ChatGPTModelOptions1106 extends ChatGPTModelOptions {
    static override windowSize = 16384;
}

@injectable()
export class ChatGPT1106 extends ChatGPT0613 {
    static override description = 'OpenAI GPT 3.5 Turbo Model with tools';
    static override aliases = [
        'gpt-3.5-turbo-1106', 'chatgpt-1106', 'gpt3.5-1106', 'gpt35-1106',
    ];
    static override streamingSupported = true;
    static override chatOptimized = true;
    static override systemSupported = true;
    static override modelOptionsType = ChatGPTModelOptions1106;
    static override windowSize = ChatGPTModelOptions1106.windowSize;
    static override nSupported = true;
    static override functionCalling = 'native' as const;

    static override modelName = 'gpt-3.5-turbo-1106';
    static override visionEnabled: boolean = false;


    override async structured<U extends (typeof LLMDto), MO extends FunctionCallingAwareLLMModelOptions<ChatGPTModelOptions>>(
        expectOutputClass: U,
        input: string | FunctionCallingAwareLLMMessage[],
        modelOpts?: MO,
        execOpts?: {
            maxTry?: number;
            requestOptions?: HTTPServiceRequestOptions,
            delayFactor?: number;
            reverseProviderPreference?: boolean;
            filterClients?: (client: OpenAIHTTP) => boolean;
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
        const messages: LLMModelOptions<ChatGPTModelOptions>['messages'] = [
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
        let trick: undefined | 'jsonMode' = expectedObjectLike ? 'jsonMode' : undefined;

        while (triesLeft > 0) {
            triesLeft -= 1;
            if (lastError) {
                execOpts?.peekStream?.write({
                    event: 'retry',
                    id: execOpts.peekChannel ? `${execOpts.peekChannel}-${Reflect.get(execOpts.peekStream, 'n') || 0 + 1}` : undefined
                });
            }

            let ret: any;
            if (trick === undefined) {
                const opts = {
                    ...modelOpts,
                    messages,
                    n: 1
                };
                ret = await this.exec('', opts, execOpts as any);
                execOpts?.collectRawInput?.(opts, '');
            } else if (trick === 'jsonMode') {
                let system = modelOpts?.system || '';
                if (
                    !system.includes('JSON') &&
                    !((modelOpts?.messages?.find((x) => (x as LLMMessage).role === 'system') as LLMMessage)?.content?.includes('JSON'))
                ) {
                    system = `${system ? `${system}\n` : ''}${expectedObjectLike ? expectOutputClass?.toJSONModeSystemPromptFragment() : `Provide your response in the following JSON Schema: ${JSON.stringify({
                        type: 'object',
                        properties: {
                            data: {
                                type: expectOutputClass.name.toLowerCase(),
                                description: `The expected output`
                            }
                        }
                    })}`}`;
                }
                const opts = {
                    ...modelOpts,
                    modelSpecific: {
                        response_format: { type: 'json_object' }
                    },
                    messages,
                    n: 1,
                    system,
                };
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
                messages.push({ role: CHAT_GPT_ROLE.USER, content: errorMsg });

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
export class ChatGPT0125 extends ChatGPT1106 {
    static override description = 'GPT-3.5 Turbo model with higher accuracy at responding in requested formats and a fix for a bug which caused a text encoding issue for non-English language function calls';
    static override aliases = [
        'gpt-3.5-turbo-0125', 'chatgpt-0125', 'gpt3.5-0125', 'gpt35-0125',
    ];

    static override modelName = 'gpt-3.5-turbo-0125';
}
