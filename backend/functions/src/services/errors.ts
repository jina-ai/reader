import { ApplicationError, Prop, RPC_TRANSFER_PROTOCOL_META_SYMBOL, StatusCode } from 'civkit/civ-rpc';
import _ from 'lodash';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';

dayjs.extend(utc);

@StatusCode(50301)
export class ServiceDisabledError extends ApplicationError { }

@StatusCode(50302)
export class ServiceCrashedError extends ApplicationError { }

@StatusCode(50303)
export class ServiceNodeResourceDrainError extends ApplicationError { }

@StatusCode(40104)
export class EmailUnverifiedError extends ApplicationError { }

@StatusCode(40201)
export class InsufficientCreditsError extends ApplicationError { }

@StatusCode(40202)
export class FreeFeatureLimitError extends ApplicationError { }

@StatusCode(40203)
export class InsufficientBalanceError extends ApplicationError { }

@StatusCode(40903)
export class LockConflictError extends ApplicationError { }

@StatusCode(40904)
export class BudgetExceededError extends ApplicationError { }

@StatusCode(45101)
export class HarmfulContentError extends ApplicationError { }

@StatusCode(45102)
export class SecurityCompromiseError extends ApplicationError { }

@StatusCode(41201)
export class BatchSizeTooLargeError extends ApplicationError { }


@StatusCode(42903)
export class RateLimitTriggeredError extends ApplicationError {

    @Prop({
        desc: 'Retry after seconds',
    })
    retryAfter?: number;

    @Prop({
        desc: 'Retry after date',
    })
    retryAfterDate?: Date;

    protected override get [RPC_TRANSFER_PROTOCOL_META_SYMBOL]() {
        const retryAfter = this.retryAfter || this.retryAfterDate;
        if (!retryAfter) {
            return super[RPC_TRANSFER_PROTOCOL_META_SYMBOL];
        }

        return _.merge(_.cloneDeep(super[RPC_TRANSFER_PROTOCOL_META_SYMBOL]), {
            headers: {
                'Retry-After': `${retryAfter instanceof Date ? dayjs(retryAfter).utc().format('ddd, DD MMM YYYY HH:mm:ss [GMT]') : retryAfter}`,
            }
        });
    }
}
