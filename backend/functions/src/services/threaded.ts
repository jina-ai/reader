import 'reflect-metadata';

import { singleton, container } from 'tsyringe';
import { AbstractThreadedServiceRegistry } from 'civkit/threaded';
import _ from 'lodash';

import { GlobalLogger } from './logger';
import { AsyncLocalContext } from './async-context';
import { PseudoTransfer } from './pseudo-transfer';
import { cpus } from 'os';
import { isMainThread } from 'worker_threads';

@singleton()
export class ThreadedServiceRegistry extends AbstractThreadedServiceRegistry {
    container = container;

    logger = this.globalLogger.child({ service: this.constructor.name });

    constructor(
        protected globalLogger: GlobalLogger,
        public asyncContext: AsyncLocalContext,
        public pseudoTransfer: PseudoTransfer,
    ) {
        super(...arguments);
    }

    setMaxWorkersByCpu() {
        const cpuStat = cpus();

        const evenCpuCycles = cpuStat.filter((_cpu, i) => i % 2 === 0).reduce((acc, cpu) => acc + cpu.times.user + cpu.times.sys, 0);
        const oddCpuCycles = cpuStat.filter((_cpu, i) => i % 2 === 1).reduce((acc, cpu) => acc + cpu.times.user + cpu.times.sys, 0);

        const isLikelyHyperThreaded = (oddCpuCycles / evenCpuCycles) < 0.5;

        this.maxWorkers = isLikelyHyperThreaded ? cpuStat.length / 2 : cpuStat.length;
    }

    override async init() {
        await this.dependencyReady();
        await super.init();

        if (isMainThread) {
            this.setMaxWorkersByCpu();
            await Promise.all(
                _.range(0, 2).map(
                    (_n) =>
                        new Promise<void>(
                            (resolve, reject) => {
                                this.createWorker()
                                    .once('message', resolve)
                                    .once('error', reject);
                            }
                        )
                )
            );
        }

        this.emit('ready');
    }

}


const instance = container.resolve(ThreadedServiceRegistry);
export default instance;
export const { Method, Param, Ctx, RPCReflect, Threaded } = instance.decorators();
