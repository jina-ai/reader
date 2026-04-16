import { Blob } from 'buffer';
import { AsyncService } from 'civkit/async-service';
import { ApplicationError, AutoCastable } from 'civkit/civ-rpc';
import { HTTPService, HTTPServiceRequestOptions } from 'civkit/http';
import { LoggerInterface } from 'civkit/logger';
import { mimeOf } from 'civkit/mime';
import { delay } from 'civkit/timeout';

type ImageData = Blob | Buffer | string;
export interface ImageInterrogationOptions<T> {
    image: ImageData;
    prompt?: string;
    system?: string;
    max_tokens?: number;
    steps?: number;

    n?: number;

    modelSpecific?: Partial<T>;
    mask?: ImageData;
    seed?: number;
}

export abstract class AbstractImageInterrogationModel<T = any, C = unknown, R = string> extends AsyncService {
    static aliases?: string[];
    static description?: string;

    static modelOptionsType?: typeof AutoCastable;

    abstract clients: C[];
    abstract logger: LoggerInterface;

    protected clientBlockade: Map<C, Date> = new Map();

    get aliases() {
        return (this.constructor as typeof AbstractImageInterrogationModel).aliases || [];
    }
    get name() {
        return this.aliases[0];
    }
    get description() {
        return (this.constructor as typeof AbstractImageInterrogationModel).description;
    }

    abstract _run<U extends ImageInterrogationOptions<T>>(
        client: this['clients'][number],
        modelOpts: U,
        requestOptions?: HTTPServiceRequestOptions
    ): Promise<R>;

    async withClient<U extends (client: this['clients'][number]) => any>(func: U, options: {
        maxTry?: number;
        delayFactor?: number;
        reverseProviderPreference?: boolean;
        filterClients?: (client: any) => boolean;
    } = {}): Promise<ReturnType<U>> {
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
                    this.logger.debug(`Calling ImageInterrogation model ${this.constructor.name} with ${(client as any).name || client.constructor.name}`);
                    const t0 = Date.now();

                    const r = await func(client);

                    this.logger.debug(`Call succeeded. ImageInterrogation model ${this.constructor.name} with ${(client as any).name || client.constructor.name} in ${Date.now() - t0}ms.`);

                    return r;
                } catch (err: any) {
                    if (err?.cause instanceof ApplicationError) {
                        this.logger.error(`Failed to run ImageInterrogation model ${this.constructor.name} with ${(client as any).name || client.constructor.name}. Non recoverable error: Code ${err.code}.`, { error: err });
                        throw err.cause;
                    }
                    // const code = err.status || (err as any).code;
                    // if ((((client as any).Error && err instanceof (client as any).Error) || err instanceof HarmfulContentError) && (typeof code === 'number')) {
                    //     if (code !== 20 && code !== 429 && code !== 401 && !(code >= 500 && code < 600)) {
                    //         this.logger.error(`Failed to run ImageInterrogation model ${this.constructor.name} with ${(client as any).name || client.constructor.name}. Non recoverable error: Code ${code}.`, { error: marshalErrorLike(err) });

                    //         throw new DownstreamServiceFailureError({
                    //             message: `Failed to run ImageInterrogation model ${this.constructor.name} with ${(client as any).name || client.constructor.name}. Non recoverable error: Code ${code}.`,
                    //             err
                    //         });
                    //     }
                    // }
                    this.clientAvailabilityRoutine(client, err);
                    if (++i >= maxTry) {
                        this.logger.error(`Failed to run ImageInterrogation model ${this.constructor.name} with ${(client as any).name || client.constructor.name}. No tries left.`, { error: err });
                        throw err;
                    }
                    const delayMs = Math.floor((options?.delayFactor ?? 1) * (1 + Math.random() * 0.4 - 0.2) * 100);
                    this.logger.warn(`Failed to run ImageInterrogation model ${this.constructor.name} with ${(client as any).name || client.constructor.name}, retrying after ${delayMs}ms...`, { error: err });
                    await delay(delayMs);
                }
            }
        }

        throw new Error('unreachable');
    }

    interrogate<U extends ImageInterrogationOptions<T>>(
        modelOpts: U,
        execOpts?: {
            maxTry?: number;
            requestOptions?: HTTPServiceRequestOptions,
            delayFactor?: number;
            reverseProviderPreference?: boolean;
            filterClients?: <T extends HTTPService>(client: T) => boolean;
        }
    ): Promise<string> {
        const requestOptions = execOpts?.requestOptions;

        this.logger.info(`Executing ${this.constructor.name} Image Interrogation...`);

        return this.withClient((client) => this._run(client, modelOpts, requestOptions), execOpts) as any;
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

    protected async toUrl(input: ImageData) {

        if (Buffer.isBuffer(input)) {
            const mimeInfo = await mimeOf(input);
            return `data:${mimeInfo.mediaType}/${mimeInfo.subType};base64,${input.toString('base64')}`;
        }

        if (input instanceof Blob) {
            return `data:${input.type};base64,${Buffer.from(await input.arrayBuffer()).toString('base64')}`;
        }

        return input;
    }

    protected async toBuffer(input: ImageData) {
        if (Buffer.isBuffer(input)) {
            return input;
        }

        if (input instanceof Blob) {
            return Buffer.from(await input.arrayBuffer());
        }

        if (input.startsWith('data:')) {
            const [_mime, base64] = input.split(';base64,');
            if (!base64) {
                throw new Error('Invalid data url');
            }
            return Buffer.from(base64, 'base64');
        }

        const r = await fetch(input);

        return Buffer.from(await r.arrayBuffer());
    }

    protected async toBlob(input: ImageData) {
        if (Buffer.isBuffer(input)) {
            const mimeInfo = await mimeOf(input);

            return new Blob([input as any], { type: `${mimeInfo.mediaType}/${mimeInfo.subType}` });
        }

        if (input instanceof Blob) {
            return input;
        }

        if (input.startsWith('data:')) {
            const [mime, base64] = input.split(';base64,');
            if (!base64) {
                throw new Error('Invalid data url');
            }
            return new Blob([Buffer.from(base64, 'base64')], { type: mime });
        }

        const r = await fetch(input);

        return await r.blob();
    }
}
