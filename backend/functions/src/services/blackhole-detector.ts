import { singleton } from 'tsyringe';
import { AsyncService } from 'civkit/async-service';
import { GlobalLogger } from './logger';


@singleton()
export class BlackHoleDetector extends AsyncService {

    logger = this.globalLogger.child({ service: this.constructor.name });

    workedTs: number[] = [];
    lastDoneRequestTs?: number;

    maxDelay = 1000 * 30;
    concurrentRequests = 0;

    constructor(protected globalLogger: GlobalLogger) {
        super(...arguments);

        setInterval(() => {
            this.routine();
        }, 1000 * 15).unref();
    }

    override async init() {
        await this.dependencyReady();
        this.logger.debug('BlackHoleDetector started');
        this.emit('ready');
    }

    routine() {
        this.workedTs.splice(0, this.workedTs.length - 20);
        const now = Date.now();
        const lastWorked = this.workedTs[this.workedTs.length - 1];
        if (this.concurrentRequests > 0 &&
            lastWorked && ((now- lastWorked) > this.maxDelay) &&
            this.lastDoneRequestTs && ((now - this.lastDoneRequestTs) > this.maxDelay)
        ) {
            this.logger.error(`BlackHole detected, last worked: ${lastWorked}`);
            this.emit('error', new Error(`BlackHole detected, last worked: ${lastWorked}`));
        }
    }

    incomingRequest() {
        this.concurrentRequests++;
    }
    doneWithRequest() {
        this.concurrentRequests--;
        this.lastDoneRequestTs = Date.now();
    }

    itWorked() {
        this.workedTs.push(Date.now());
    }

}
