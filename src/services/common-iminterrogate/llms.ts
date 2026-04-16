import _ from "lodash";
import { injectable } from "tsyringe";

import { AbstractImageInterrogationModel, ImageInterrogationOptions } from './base';
import { EnvConfig } from '../envconfig';
import { GlobalLogger } from '../logger';
import type { AbstractLLM, PromptChunk } from '../common-llm/base';


export function imageInterrogationWithVisualLLM(llm: AbstractLLM<unknown, unknown>): any {
    const cls = llm.constructor as typeof AbstractLLM;
    if (!llm.interleavedPromptSupported) {
        throw new Error(`LLM ${llm.name} does not support image interrogation`);
    }
    @injectable()
    class LLMDerivedImageInterrogator extends AbstractImageInterrogationModel<typeof AbstractLLM['modelOptionsType']> {
        static override description = cls.description;
        static override aliases = cls.aliases;
        static override modelOptionsType = cls.modelOptionsType;

        override clients: Array<InstanceType<typeof cls>> = [];

        logger = this.globalLogger.child({ service: this.constructor.name });

        constructor(
            protected envConfig: EnvConfig,
            protected globalLogger: GlobalLogger,
        ) {
            super(...arguments);
            this.clients.push(llm);
            this.dependsOn(llm);
        }

        override async init() {
            await this.dependencyReady();
            this.emit('ready');
        }

        override async withClient<U extends (client: InstanceType<typeof cls>) => any>(func: U, _options: {
            maxTry?: number;
            delayFactor?: number;
            reverseProviderPreference?: boolean;
            filterClients?: (client: any) => boolean;
        } = {}): Promise<ReturnType<U>> {
            await this.serviceReady();
            const client = this.clients[0];
            if (!this.clients.length) {
                throw new Error('Model client not ready');
            }

            if (typeof client !== 'object' || !client) {
                throw new Error('Invalid client');
            }
            const r = await func(client);

            return r;
        }

        override async _run<U extends ImageInterrogationOptions<typeof cls['modelOptionsType']>>(client: this['clients'][number], modelOpts: U): Promise<string> {

            this.logger.debug(`Calling ${cls.name} Image Caption...`);

            const promptChunks: PromptChunk[] = [await this.toBlob(modelOpts.image)];
            if (modelOpts.prompt) {
                promptChunks.push(modelOpts.prompt);
            }

            const r = await client.exec(promptChunks, {
                stream: false,
                n: modelOpts.n,
                seed: modelOpts.seed,
                max_tokens: modelOpts.max_tokens,
                system: modelOpts.system,
                modelSpecific: modelOpts.modelSpecific
            });

            return r as string;
        }

    }

    Object.defineProperty(LLMDerivedImageInterrogator, 'name', { value: `${cls.name}DerivedImageInterrogator`, writable: false });

    return LLMDerivedImageInterrogator as any;
}
