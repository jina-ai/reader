import { AbstractFinalizerService } from 'civkit/finalizer';
import { container, singleton } from 'tsyringe';
import { isMainThread } from 'worker_threads';
import { GlobalLogger } from './logger';

const realProcessExit = process.exit;
process.exit = ((code?: number) => {
    if (isMainThread) {
        return;
    }
    return realProcessExit(code);
}) as typeof process.exit;

@singleton()
export class FinalizerService extends AbstractFinalizerService {

    container = container;
    logger = this.globalLogger.child({ service: this.constructor.name });

    override quitProcess(code?: string | number | null | undefined): never {
        return realProcessExit(code);
    }

    constructor(protected globalLogger: GlobalLogger) {
        super(...arguments);
    }

    override onUnhandledRejection(err: unknown, _triggeringPromise: Promise<unknown>): void {
        this.logger.warn(`Unhandled promise rejection in pid ${process.pid}`, { err });
    }
}

const instance = container.resolve(FinalizerService);
export const { Finalizer } = instance.decorators();
export default instance;

if (isMainThread) {
    instance.serviceReady();
}
