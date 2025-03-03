import { AbstractFinalizerService } from 'civkit/finalizer';
import { container, singleton } from 'tsyringe';
import { isMainThread } from 'worker_threads';
import { GlobalLogger } from './logger';

@singleton()
export class FinalizerService extends AbstractFinalizerService {

    container = container;
    logger = this.globalLogger.child({ service: this.constructor.name });

    constructor(protected globalLogger: GlobalLogger) {
        super(...arguments);
    }

}

const instance = container.resolve(FinalizerService);
export const { Finalizer } = instance.decorators();
export default instance;

if (isMainThread) {
    instance.serviceReady();
}
