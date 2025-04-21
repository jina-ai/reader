import { ApplicationError, StatusCode } from 'civkit/civ-rpc';
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

@StatusCode(50304)
export class ServiceBadAttemptError extends ApplicationError { }

@StatusCode(50305)
export class ServiceBadApproachError extends ServiceBadAttemptError { }

@StatusCode(40104)
export class EmailUnverifiedError extends ApplicationError { }

@StatusCode(40201)
export class InsufficientCreditsError extends ApplicationError { }

@StatusCode(40202)
export class TierFeatureConstraintError extends ApplicationError { }

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
