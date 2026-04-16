import { ApplicationError, AssertionFailureError, isAutoCastableClass } from 'civkit/civ-rpc';

import { container, injectable, singleton } from 'tsyringe';
import { readdirSync } from 'fs';
import _ from 'lodash';

import { GlobalLogger } from '../logger';
import { AbstractLLM, DependsOnOptions, DetectFunctions, LLMDto, PromptChunk } from './base';
import { Readable, isReadable } from 'stream';
import { PromptProfile, PromptProfileRuntimeMetadata } from './prompt-profile';
import { FunctionCallingAwareLLMMessage, FunctionCallingAwareLLMModelOptions, LLMFunctionCallRequest, LLMPeakStream } from './misc';
import { AsyncService } from 'civkit/async-service';
import { HarmfulContentError } from '../errors';
import { delay } from 'civkit/timeout';
import { HTTPServiceRequestOptions } from 'civkit/http';
import { isScalarLike } from '../../utils/misc';
import { EnvConfig } from '../envconfig';
import { OpenRouterHTTP } from '../../3rd-party/open-router';
import { OpenRouterLLM, OpenRouterRequestOptions } from './open-router';

function loadModulesDynamically(path: string) {
    const moduleDir = readdirSync(path,
        { withFileTypes: true, encoding: 'utf-8' });

    const modules = moduleDir.filter((x) => x.isFile() && x.name.endsWith('.js')).map((x) => x.name);

    const apiClasses: (typeof AbstractLLM<unknown>)[] = [];

    for (const m of modules) {
        if (m === 'index.js') {
            continue;
        }
        try {
            // if (process.env.hasOwnProperty(`LLM_DISABLE_${m.toUpperCase()}`)) {
            //     continue;
            // }

            // FIXME: Does not work with esm
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const mod = require(`${path}/${m}`);

            for (const [_k, v] of Object.entries<Function>(mod)) {
                if (v?.prototype instanceof AsyncService && (v as any).windowSize) {
                    apiClasses.push(v as any);
                }
            }
        } catch (err) {
            // ignore
            console.warn(`Failed to load module ${m}`, err);
        }
    }

    return apiClasses;
}

@singleton()
export class LLMManager extends AsyncService {
    modelClasses: (typeof AbstractLLM<unknown>)[];

    modelMap: Record<string, AbstractLLM<unknown> | undefined> = {};
    logger = this.globalLogger.child({ service: this.constructor.name });

    constructor(
        protected globalLogger: GlobalLogger,
        protected envConfig: EnvConfig,
    ) {
        super(...arguments);

        this.modelClasses = loadModulesDynamically(__dirname);

        const instances: AsyncService[] = [];
        for (const x of this.modelClasses) {
            const instance: AbstractLLM<unknown> = container.resolve(x as any);
            const names = _.uniq([x.name, x.name.toLowerCase(), ...(x.aliases || [])]);

            for (const n of names) {
                this.modelMap[n] = instance;
            }

            instances.push(instance);
        }

        this.dependsOn(...instances);
    }

    override async init() {
        await this.dependencyReady();

        this.emit('ready');
    }

    async importOpenRouterModel(...openRouterModels: string[]) {
        if (!openRouterModels.length) {
            return;
        }
        if (!this.envConfig.OPENROUTER_API_KEY) {
            this.logger.warn('OpenRouter API key not found, skipping OpenRouter model import');

            return;
        }
        const openRouterClient = new OpenRouterHTTP(this.envConfig.OPENROUTER_API_KEY);
        const models = (await openRouterClient.listModels()).data.data;
        const modelsToImport = models.filter((x) => {
            if (!openRouterModels.includes(x.id)) {
                return false;
            }
            if (!x.architecture.output_modalities.includes('text')) {
                return false;
            }

            return true;
        });

        for (const model of modelsToImport) {
            this.logger.debug(`Importing OpenRouter model: ${model.id}`);
            class CustomizedOpenRouterRequestOptions extends OpenRouterRequestOptions {
                static override contextLength = model.context_length;
            }

            @injectable()
            class CustomizedOpenRouterLLM extends OpenRouterLLM {
                static override description = model.description;
                static override aliases = [
                    model.id
                ];
                static override modelOptionsType = CustomizedOpenRouterRequestOptions;
                static override windowSize = CustomizedOpenRouterRequestOptions.contextLength;
                static override modelName = model.id;
                static override functionCalling = model.supported_parameters.includes('tools') ? 'native' : 'none';
                static override functionCallingSupported = model.supported_parameters.includes('tools');
                static override interleavedPromptSupported = model.architecture.input_modalities.includes('image');
            }

            Object.defineProperty(CustomizedOpenRouterLLM, 'name', { value: model.name });
            this.modelClasses.push(CustomizedOpenRouterLLM as any);
            const llmInstance = container.resolve(CustomizedOpenRouterLLM);
            this.modelMap[model.id] = llmInstance;
            this.dependsOn(llmInstance);
            await llmInstance.serviceReady();
            this.logger.debug(`Imported OpenRouter model: ${model.id}`);
        }
    }

    getModel(name: string) {
        const mdl = this.modelMap[name];

        return mdl;
    }

    assertModel(name: string) {
        const mdl = this.modelMap[name];
        if (!mdl) {
            throw new AssertionFailureError(`Unknown model: ${name}`);
        }

        return mdl;
    }

    hasModel(name: string) {
        return Boolean(this.modelMap[name]);
    }

    async withModel(model: string, func: (mdl: AbstractLLM<unknown>, client: unknown) => any, options: {
        maxTry?: number;
        delayFactor?: number;
        reverseProviderPreference?: boolean;
        filterClients?: (client: AbstractLLM<unknown>['clients'][number]) => boolean;
    } = {}): Promise<ReturnType<typeof func>> {
        const instance = this.getModel(model);

        if (!instance) {
            throw new Error(`Model not found: ${model}`);
        }

        await instance.serviceReady();

        if (!instance.clients.length) {
            throw new Error('Model client not ready');
        }

        const clients = options?.filterClients ? instance.clients.filter(options.filterClients) : instance.clients;
        const maxTry = options?.maxTry ?? (clients.length + 1);
        let i = 0;
        while (true) {
            for (const client of options.reverseProviderPreference ? [...clients].reverse() : clients) {
                if (typeof client !== 'object' || !client) {
                    throw new Error('Invalid client');
                }
                try {
                    this.logger.debug(`Calling LLM model ${instance.constructor.name} with ${(client as any).name || client.constructor.name}`);
                    const t0 = Date.now();

                    const r = await func(instance, client);

                    if (isReadable(r as any)) {
                        (r as unknown as Readable).once('end', () => {
                            this.logger.debug(`Streaming succeeded. LLM model ${instance.constructor.name} with ${(client as any).name || client.constructor.name} in ${Date.now() - t0}ms.`);
                        });
                    } else {
                        this.logger.debug(`Call succeeded. LLM model ${instance.constructor.name} with ${(client as any).name || client.constructor.name} in ${Date.now() - t0}ms.`);
                    }

                    return r;
                } catch (err: any) {
                    if (err?.cause instanceof ApplicationError) {
                        this.logger.error(`Failed to run LLM model ${this.constructor.name} with ${(client as any).name || client.constructor.name}. Non recoverable error: Code ${err.code}.`, { error: err });
                        throw err.cause;
                    }
                    const code = err.status || (err as any).code;
                    if ((((client as any).Error && err instanceof (client as any).Error) || err instanceof HarmfulContentError) && (typeof code === 'number')) {
                        if (code !== 20 && code !== 429 && code !== 401 && !(code >= 500 && code < 600)) {
                            this.logger.error(`Failed to run LLM model ${instance.constructor.name} with ${(client as any).name || client.constructor.name}. Non recoverable error: Code ${code}.`, { error: err });

                            throw err;
                        }

                    }
                    if (++i >= maxTry) {
                        this.logger.error(`Failed to run LLM model ${instance.constructor.name} with ${(client as any).name || client.constructor.name}. No tries left.`, { error: err });
                        throw err;
                    }
                    const delayMs = Math.floor((options?.delayFactor ?? 1) * (1 + Math.random() * 0.4 - 0.2) * 100);
                    this.logger.warn(`Failed to run LLM model ${instance.constructor.name} with ${(client as any).name || client.constructor.name}, retrying after ${delayMs}ms...`, { error: err });
                    await delay(delayMs);
                }
            }
        }

        throw new Error('unreachable');
    }

    run<T, MO extends FunctionCallingAwareLLMModelOptions<T>>(model: string, options: {
        prompt: string | PromptChunk[],
        options?: MO,
        requestOptions?: HTTPServiceRequestOptions,
        filterClients?: (client: unknown) => boolean;
        maxTry?: number;
        delayFactor?: number;
        reverseProviderPreference?: boolean;
    }): Promise<DependsOnOptions<MO>> {

        const mdl = this.getModel(model);

        if (!mdl) {
            throw new Error(`Model not found: ${model}`);
        }

        return mdl.exec(options.prompt, options.options, options);
    }

    iterRun<T, MO extends FunctionCallingAwareLLMModelOptions<T>>(model: string, options: {
        prompt: string | PromptChunk[],
        options?: MO,
        requestOptions?: HTTPServiceRequestOptions,
        filterClients?: (client: unknown) => boolean;
        maxTry?: number;
        delayFactor?: number;
        reverseProviderPreference?: boolean;
    }) {
        const mdl = this.getModel(model);

        if (!mdl) {
            throw new Error(`Model not found: ${model}`);
        }

        return mdl.iterExec<MO>(options.prompt, options.options, options);
    }

    runStructured<U extends (typeof LLMDto), MO extends FunctionCallingAwareLLMModelOptions<unknown>>(
        model: string,
        expectOutputClass: U,
        input: string | FunctionCallingAwareLLMMessage[],
        options: {
            options?: MO,
            requestOptions?: HTTPServiceRequestOptions,

            maxTry?: number;
            delayFactor?: number;
            reverseProviderPreference?: boolean;
            filterClients?: (client: unknown) => boolean;
            asyncValidate?: (parsed: InstanceType<U>, raw: string) => Promise<boolean>;
            peekStream?: LLMPeakStream;
            peekChannel?: string;
        }) {

        const mdl = this.getModel(model);

        if (!mdl) {
            throw new Error(`Model not found: ${model}`);
        }

        return mdl.structured<U, MO>(expectOutputClass, input, options.options, _.omit(options, 'options'));
    }

    iterStructured<U extends (typeof LLMDto), MO extends FunctionCallingAwareLLMModelOptions<unknown>>(
        model: string,
        expectOutputClass: U,
        input: string | FunctionCallingAwareLLMMessage[],
        options: {
            options?: MO,
            requestOptions?: HTTPServiceRequestOptions,

            maxTry?: number;
            delayFactor?: number;
            reverseProviderPreference?: boolean;
            filterClients?: (client: unknown) => boolean;
            asyncValidate?: (parsed: InstanceType<U>, raw: string) => Promise<boolean>;
            peekStream?: LLMPeakStream;
            peekChannel?: string;
        }) {

        const mdl = this.getModel(model);

        if (!mdl) {
            throw new Error(`Model not found: ${model}`);
        }

        return mdl.iterStructured<U, MO>(expectOutputClass, input, options.options, _.omit(options, 'options'));
    }

    async runProfile<R extends PromptProfile, MO extends FunctionCallingAwareLLMModelOptions<unknown>>(
        profile: R,
        options: {
            options?: MO,
            maxTry?: number;
            requestOptions?: HTTPServiceRequestOptions,
            delayFactor?: number;
            reverseProviderPreference?: boolean;
            filterClients?: (client: unknown) => boolean;
            peekStream?: LLMPeakStream;
            peekChannel?: string;
        } = {}): Promise<DetectFunctions<MO & Awaited<ReturnType<R['renderModelOptions']>>, NonNullable<R['modelOutput']>>> {
        await this.serviceReady();

        const systemPrompt = await profile.renderSystemPrompt();
        const prompt = await profile.renderPrompt();
        const mdlPreference = await profile.selectModel();
        const modelOptions = await profile.renderModelOptions();
        const finalModelOptions = _.merge(_.cloneDeep(modelOptions), options?.options);

        const mdl = this.getModel(mdlPreference);

        if (!mdl) {
            throw new Error(`Model not found: ${mdlPreference}`);
        }

        const msgMixin: any = {};
        let extPrompt = '';
        if ((typeof prompt === 'string') && prompt) {
            if (finalModelOptions?.messages) {
                finalModelOptions.messages = [
                    {
                        role: 'user',
                        content: prompt,
                    },
                    ...finalModelOptions.messages
                ];
            } else {
                extPrompt = prompt;
            }
        } else {
            msgMixin.messages = prompt;
        }

        const modelOutputDto = profile.modelOutputDto;
        if (isAutoCastableClass(modelOutputDto) || isScalarLike(modelOutputDto)
        ) {
            const execModelOptions = {
                system: systemPrompt,
                stream: options.peekStream ? (mdl.streamingSupported) : false,
                ...msgMixin,
                ...finalModelOptions,
            };
            const thisReflect: PromptProfileRuntimeMetadata = {
                modelName: mdlPreference,
                model: mdl,
                prompt,
                modelOptions: execModelOptions,
                iterations: [],
            };
            profile.runtime = thisReflect;
            const r = await mdl.structured(modelOutputDto, prompt, execModelOptions, {
                ..._.omit(options, 'options'),
                asyncValidate: profile.acceptModelOutput.bind(profile),
                collectRawInput: (opts) => {
                    thisReflect.iterations.push({ input: opts });
                },
                collectRawOutput: (rawOutput) => {
                    const lastIter = thisReflect.iterations[thisReflect.iterations.length - 1];
                    if (lastIter) {
                        lastIter.output = rawOutput;
                    }
                }
            });

            return r;
        }

        const execModelOptions = {
            ...msgMixin,
            ...finalModelOptions,
        };
        const thisReflect: PromptProfileRuntimeMetadata = {
            modelName: mdlPreference,
            model: mdl,
            prompt,
            modelOptions: execModelOptions,
            iterations: [{ input: execModelOptions }],
        };
        profile.runtime = thisReflect;
        const r = await mdl.exec(extPrompt, execModelOptions, _.omit(options, 'options'));
        thisReflect.iterations[0].output = r;

        if (r instanceof LLMFunctionCallRequest) {
            return r as any;
        }

        await profile.acceptModelOutput(r, r as any);

        return r as any;
    }

    async *iterProfile<R extends PromptProfile, MO extends FunctionCallingAwareLLMModelOptions<unknown>>(
        profile: R,
        options: {
            options?: MO,
            maxTry?: number;
            requestOptions?: HTTPServiceRequestOptions,
            delayFactor?: number;
            reverseProviderPreference?: boolean;
            filterClients?: (client: unknown) => boolean;
            peekStream?: LLMPeakStream;
            peekChannel?: string;
        } = {}): AsyncGenerator<DetectFunctions<MO & Awaited<ReturnType<R['renderModelOptions']>>, NonNullable<R['modelOutput']>>, unknown, unknown> {
        await this.serviceReady();

        const systemPrompt = await profile.renderSystemPrompt();
        const prompt = await profile.renderPrompt();
        const mdlPreference = await profile.selectModel();
        const modelOptions = await profile.renderModelOptions();
        const finalModelOptions = _.merge(_.cloneDeep(modelOptions), options?.options);

        const mdl = this.getModel(mdlPreference);

        if (!mdl) {
            throw new Error(`Model not found: ${mdlPreference}`);
        }

        const msgMixin: any = {};
        let extPrompt = '';
        if ((typeof prompt === 'string') && prompt) {
            if (finalModelOptions?.messages) {
                finalModelOptions.messages = [
                    {
                        role: 'user',
                        content: prompt,
                    },
                    ...finalModelOptions.messages
                ];
            } else {
                extPrompt = prompt;
            }
        } else {
            msgMixin.messages = prompt;
        }

        const modelOutputDto = profile.modelOutputDto;
        if (isAutoCastableClass(modelOutputDto) || isScalarLike(modelOutputDto)
        ) {
            const execModelOptions = {
                system: systemPrompt,
                stream: options.peekStream ? (mdl.streamingSupported) : false,
                ...msgMixin,
                ...finalModelOptions,
            };
            const thisReflect: PromptProfileRuntimeMetadata = {
                modelName: mdlPreference,
                model: mdl,
                prompt,
                modelOptions: execModelOptions,
                iterations: [],
            };
            profile.runtime = thisReflect;
            yield* mdl.iterStructured(modelOutputDto, prompt, execModelOptions, {
                ..._.omit(options, 'options'),
                asyncValidate: profile.acceptModelOutput.bind(profile),
                collectRawInput: (opts) => {
                    thisReflect.iterations.push({ input: opts });
                },
                collectRawOutput: (rawOutput) => {
                    const lastIter = thisReflect.iterations[thisReflect.iterations.length - 1];
                    if (lastIter) {
                        lastIter.output = rawOutput;
                    }
                }
            }) as any;

            return;
        }

        const execModelOptions = {
            ...msgMixin,
            ...finalModelOptions,
        };
        const thisReflect: PromptProfileRuntimeMetadata = {
            modelName: mdlPreference,
            model: mdl,
            prompt,
            modelOptions: execModelOptions,
            iterations: [{ input: execModelOptions }],
        };
        profile.runtime = thisReflect;
        const r = mdl.iterExec(extPrompt, execModelOptions, {
            ..._.omit(options, 'options'),
            collectRawOutput(rawOutput) {
                thisReflect.iterations[0].output = rawOutput;
            }
        });

        const textChunks: string[] = [];
        let lastYield: string | LLMFunctionCallRequest = '';
        for await (const x of r) {
            lastYield = x;
            if (typeof x === 'string' && x) {
                textChunks.push(x);
                yield textChunks.join('') as any;
            } else if (x) {
                yield x as any;
            }
            if (x instanceof LLMFunctionCallRequest) {
                return;
            }
        }

        await profile.acceptModelOutput(lastYield, lastYield as any);

        return;
    }

    brief() {
        return Object.fromEntries(this.modelClasses.map((x) => [x.aliases![0], x.description!]));
    }
}

const instance = container.resolve(LLMManager);

export default instance;
