import { singleton } from 'tsyringe';
import { AsyncService } from 'civkit/async-service';
import { GlobalLogger } from './logger';


@singleton()
export class BlackHoleDetector extends AsyncService {

    logger = this.globalLogger.child({ service: this.constructor.name });
    lastWorkedTs?: number;
    lastDoneRequestTs?: number;

    maxDelay = 1000 * 30;
    concurrentRequests = 0;

    strikes = 0;

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
        const now = Date.now();
        const lastWorked = this.lastWorkedTs;
        if (!lastWorked) {
            return;
        }
        if (this.concurrentRequests > 0 &&
            lastWorked && ((now - lastWorked) > (this.maxDelay * this.strikes + 1))
        ) {
            this.logger.warn(`BlackHole detected, last worked: ${lastWorked}`);
            this.strikes += 1;
        }

        if (this.strikes >= 3) {
            this.logger.error(`BlackHole detected for ${this.strikes} strikes, last worked: ${lastWorked}`);
            this.emit('error', new Error(`BlackHole detected, last worked: ${lastWorked}`));
        }
    }

    incomingRequest() {
        this.lastWorkedTs ??= Date.now();
        this.concurrentRequests++;
    }
    doneWithRequest() {
        this.concurrentRequests--;
        this.lastDoneRequestTs = Date.now();
    }

    itWorked() {
        this.lastWorkedTs = Date.now();
        this.strikes = 0;
    }

}
