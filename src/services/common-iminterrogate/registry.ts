import { HTTPService, HTTPServiceRequestOptions } from 'civkit/http';

import { container, singleton } from 'tsyringe';
import { readdirSync } from 'fs';
import _ from 'lodash';

import { GlobalLogger } from '../logger';
import { AbstractImageInterrogationModel, ImageInterrogationOptions } from './base';
import { AsyncService } from 'civkit/async-service';
import { AssertionFailureError } from 'civkit/civ-rpc';
import { LLMManager } from '../common-llm/registry';
import { imageInterrogationWithVisualLLM } from './llms';

function loadModulesDynamically(path: string) {
    const moduleDir = readdirSync(path,
        { withFileTypes: true, encoding: 'utf-8' });

    const modules = moduleDir.filter((x) => x.isFile() && x.name.endsWith('.js') || x.isDirectory()).map((x) => x.name);

    const imClasses: (typeof AbstractImageInterrogationModel<unknown>)[] = [];

    for (const m of modules) {
        try {
            if (m === 'index.js') {
                continue;
            }
            // if (process.env.hasOwnProperty(`IMGEN_DISABLE_${m.toUpperCase()}`)) {
            //     continue;
            // }

            // FIXME: Does not work with esm
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const mod = require(`${path}/${m}`);

            for (const [_k, v] of Object.entries<Function>(mod)) {
                if (v.prototype instanceof AbstractImageInterrogationModel) {
                    imClasses.push(v as any);
                }
            }
        } catch (err) {
            // ignore
            console.warn(`Failed to load module ${m}`, err);
        }
    }

    return imClasses;
}


@singleton()
export class ImageInterrogationManager extends AsyncService {
    modelClasses: (typeof AbstractImageInterrogationModel<unknown>)[];

    modelMap: Record<string, AbstractImageInterrogationModel<unknown>> = {};
    logger = this.globalLogger.child({ service: this.constructor.name });

    constructor(
        protected globalLogger: GlobalLogger,
        protected llmManager: LLMManager,
    ) {
        super(...arguments);

        this.modelClasses = loadModulesDynamically(__dirname);

        const instances: AsyncService[] = [];
        for (const x of this.modelClasses) {
            const instance: AbstractImageInterrogationModel<unknown> = container.resolve(x as any);
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

    getModel(name: string) {
        let mdl = this.modelMap[name];
        if (!mdl && this.llmManager.getModel(name)?.interleavedPromptSupported) {
            mdl = container.resolve(imageInterrogationWithVisualLLM(this.llmManager.getModel(name)!));
            this.modelMap[name] = mdl;
        }

        if (!mdl) {
            return;
        }

        return mdl;
    }

    assertModel(name: string) {
        const mdl = this.getModel(name);
        if (!mdl) {
            throw new AssertionFailureError(`Unknown model: ${name}`);
        }

        return mdl;
    }

    hasModel(name: string) {
        return Boolean(this.getModel(name));
    }

    interrogate<U extends ImageInterrogationOptions<T>, T>(
        model: string,
        modelOpts: U,
        execOpts?: {
            maxTry?: number;
            requestOptions?: HTTPServiceRequestOptions,
            delayFactor?: number;
            reverseProviderPreference?: boolean;
            filterClients?: <T extends HTTPService>(client: T) => boolean;
        }
    ): Promise<string> {
        return this.assertModel(model).interrogate(modelOpts, execOpts);
    }


    brief() {
        return Object.fromEntries(this.modelClasses.map((x) => [x.aliases![0], x.description!]));
    }

}

const instance = container.resolve(ImageInterrogationManager);

export default instance;
