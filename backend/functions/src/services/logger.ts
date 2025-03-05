import { AbstractPinoLogger } from 'civkit/pino-logger';
import { singleton, container } from 'tsyringe';
import { threadId } from 'node:worker_threads';
import { getTraceCtx } from 'civkit/async-context';


const levelToSeverityMap: { [k: string]: string | undefined; } = {
    trace: 'DEFAULT',
    debug: 'DEBUG',
    info: 'INFO',
    warn: 'WARNING',
    error: 'ERROR',
    fatal: 'CRITICAL',
};

@singleton()
export class GlobalLogger extends AbstractPinoLogger {
    loggerOptions = {
        level: 'debug',
        base: {
            tid: threadId,
        }
    };

    override init(): void {
        if (process.env['NODE_ENV']?.startsWith('prod')) {
            super.init(process.stdout);
        } else {
            const PinoPretty = require('pino-pretty').PinoPretty;
            super.init(PinoPretty({
                singleLine: true,
                colorize: true,
                messageFormat(log: any, messageKey: any) {
                    return `${log['tid'] ? `[${log['tid']}]` : ''}[${log['service'] || 'ROOT'}] ${log[messageKey]}`;
                },
            }));
        }


        this.emit('ready');
    }

    override log(...args: any[]) {
        const [levelObj, ...rest] = args;
        const severity = levelToSeverityMap[levelObj?.level];
        const traceCtx = getTraceCtx();
        const patched: any= { ...levelObj, severity };
        if (traceCtx?.googleTraceId && process.env['GCLOUD_PROJECT']) {
            patched['logging.googleapis.com/trace'] = `projects/${process.env['GCLOUD_PROJECT']}/traces/${traceCtx.googleTraceId}`;
        }
        return super.log(patched, ...rest);
    }
}

const instance = container.resolve(GlobalLogger);
export default instance;
