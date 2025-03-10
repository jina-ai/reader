import { singleton } from 'tsyringe';
import { AsyncService } from 'civkit/async-service';
import { GlobalLogger } from './logger';
import { delay } from 'civkit/timeout';


@singleton()
export class BlackHoleDetector extends AsyncService {

    logger = this.globalLogger.child({ service: this.constructor.name });
    lastWorkedTs?: number;
    lastDoneRequestTs?: number;
    lastIncomingRequestTs?: number;

    maxDelay = 1000 * 30;
    concurrentRequests = 0;

    strikes = 0;

    constructor(protected globalLogger: GlobalLogger) {
        super(...arguments);

        if (process.env.NODE_ENV?.startsWith('prod')) {
            setInterval(() => {
                this.routine();
            }, 1000 * 30).unref();
        }
    }

    override async init() {
        await this.dependencyReady();
        this.logger.debug('BlackHoleDetector started');
        this.emit('ready');
    }

    async routine() {
        // We give routine a 3s grace period for potentially paused CPU to spin up and process some requests
        await delay(3000);
        const now = Date.now();
        const lastWorked = this.lastWorkedTs;
        if (!lastWorked) {
            return;
        }
        const dt = (now - lastWorked);
        if (this.concurrentRequests > 1 &&
            this.lastIncomingRequestTs && lastWorked &&
            this.lastIncomingRequestTs >= lastWorked &&
            (dt > (this.maxDelay * (this.strikes + 1)))
        ) {
            this.logger.warn(`BlackHole detected, last worked: ${Math.ceil(dt / 1000)}s ago, concurrentRequests: ${this.concurrentRequests}`);
            this.strikes += 1;
        }

        if (this.strikes >= 3) {
            this.logger.error(`BlackHole detected for ${this.strikes} strikes, last worked: ${Math.ceil(dt / 1000)}s ago, concurrentRequests: ${this.concurrentRequests}`);
            this.emit('error', new Error(`BlackHole detected for ${this.strikes} strikes, last worked: ${Math.ceil(dt / 1000)}s ago, concurrentRequests: ${this.concurrentRequests}`));
        }
    }

    incomingRequest() {
        this.lastIncomingRequestTs = Date.now();
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

};
