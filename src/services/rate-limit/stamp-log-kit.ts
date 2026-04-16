import { RateLimitTriggeredError } from '../errors';


export class StampLogRateLimitKit {

    logBuff: Buffer;

    fastPtr: number = 0;
    slowPtr: number = 0;
    readonly periodMs: number;
    refundedPoints?: number[];

    constructor(
        public readonly limit: number,
        periodSeconds: number,
    ) {
        if (limit < 0) {
            throw new Error('Limit must be a non-negative number');
        }
        this.logBuff = Buffer.alloc(limit << 2);
        this.periodMs = periodSeconds * 1000;
    }

    protected maintainSlowPtr(now = performance.now()) {
        while (this.slowPtr != this.fastPtr) {
            const slowPtr = this.slowPtr << 2;
            const n = this.logBuff.readFloatLE(slowPtr);
            if (n + this.periodMs <= now) {
                this.slowPtr = (this.slowPtr + 1) % this.limit;
                continue;
            }
            break;
        }
        return this.slowPtr;
    }

    forward(now = performance.now()) {
        const slowPtr = this.maintainSlowPtr(now) << 2;
        const fastPtr = this.fastPtr << 2;

        const t = this.logBuff.readFloatLE(slowPtr);

        let o;
        while (o = this.refundedPoints?.pop()) {
            if (o >= t) {
                // Re-use refunded point
                return o;
            }
        }

        if (t && ((now - t) <= this.periodMs)) {
            throw new RateLimitTriggeredError({
                message: `Rate limit exceeded (${this.limit} times in last ${Math.floor(this.periodMs / 1000)} seconds)`,
                retryAfter: Math.ceil((t + this.periodMs - now) / 1000),
                retryAfterDate: new Date(Date.now() + (t + this.periodMs - now)),
            });
        }

        this.logBuff.writeFloatLE(now, fastPtr);
        this.fastPtr = (this.fastPtr + 1) % this.limit;

        return now;
    }

    refund(pt: number) {
        this.refundedPoints ??= [];
        this.refundedPoints.push(pt);
        this.refundedPoints.sort((a, b) => b - a); // Descending

        return pt;
    }

}