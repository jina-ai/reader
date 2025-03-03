import { TPM, parseJSONText } from 'civkit';
import { Transform, TransformCallback, TransformOptions } from 'stream';

export class InputServerEventStream extends Transform {
    cache: string[] = [];

    constructor(options?: TransformOptions) {
        super({
            ...options,
            readableObjectMode: true
        });
    }

    decodeRoutine() {
        if (!this.cache.length) {
            return;
        }

        const vecs = this.cache.join('').split(/\r?\n\r?\n/);
        this.cache.length = 0;
        const lastVec = vecs.pop();
        if (lastVec) {
            this.cache.push(lastVec);
        }

        for (const x of vecs) {
            const lines: string[] = x.split(/\r?\n/);

            const event: {
                event?: string;
                data?: string;
                id?: string;
                retry?: number;
            } = {};

            for (const l of lines) {
                const columnPos = l.indexOf(':');
                if (columnPos <= 0) {
                    continue;
                }
                const key = l.substring(0, columnPos);
                const rawValue = l.substring(columnPos + 1);
                const value = rawValue.startsWith(' ') ? rawValue.slice(1) : rawValue;
                if (key === 'data') {
                    if (event.data) {
                        event.data += value || '\n';
                    } else if (event.data === '') {
                        event.data += '\n';
                        event.data += value || '\n';
                    } else {
                        event.data = value;
                    }
                } else if (key === 'retry') {
                    event.retry = parseInt(value, 10);
                } else {
                    Reflect.set(event, key, value);
                }
            }

            if (event.data) {
                const parsed = parseJSONText(event.data);
                if (parsed && typeof parsed === 'object') {
                    event.data = parsed;
                }
            }

            if (Object.keys(event).length) {
                this.push(event);
            }
        }
    }

    override _transform(chunk: any, encoding: BufferEncoding, callback: TransformCallback): void {
        if (chunk === null) {
            this.push(null);
        }

        this.cache.push(chunk.toString());
        this.decodeRoutine();

        callback();
    }

    override _final(callback: (error?: Error | null | undefined) => void): void {
        this.decodeRoutine();
        callback();
    }
}

@TPM({
    contentType: 'text/event-stream',
})
export class OutputServerEventStream extends Transform {
    n: number = 0;

    constructor(options?: TransformOptions) {
        super({
            ...options, writableObjectMode: true, encoding: 'utf-8'
        });
    }

    encodeRoutine(chunk: {
        event?: string;
        data?: any;
        id?: string;
        retry?: number;
    } | string) {
        if (typeof chunk === 'object') {
            const lines: string[] = [];

            if (chunk.event) {
                lines.push(`event: ${chunk.event}`);
            }
            if (chunk.data) {
                if (typeof chunk.data === 'string') {
                    for (const x of chunk.data.split(/\r?\n/)) {
                        lines.push(`data: ${x}`);
                    }
                } else {
                    lines.push(`data: ${JSON.stringify(chunk.data)}`);
                }
            }
            if (chunk.id) {
                lines.push(`id: ${chunk.id}`);
            }
            if (chunk.retry) {
                lines.push(`retry: ${chunk.retry}`);
            }
            if (!lines.length) {
                lines.push(`data: ${JSON.stringify(chunk)}`);
            }
            this.push(lines.join('\n'));
            this.push('\n\n');
            this.n++;

            return;
        } else if (typeof chunk === 'string') {
            const lines: string[] = [];
            for (const x of chunk.split(/\r?\n/)) {
                lines.push(`data: ${x}`);
            }

            this.push(lines.join('\n'));
            this.push('\n\n');
            this.n++;
        }
    }

    override _transform(chunk: any, encoding: BufferEncoding, callback: TransformCallback): void {
        if (chunk === null) {
            this.push(null);
        }

        this.encodeRoutine(chunk);

        callback();
    }
}

export interface OutputServerEventStream extends Transform {
    write(chunk: string | {
        event?: string;
        data?: any;
        id?: string;
        retry?: number;
    }, callback?: (error: Error | null | undefined) => void): boolean;
    write(chunk: any, callback?: (error: Error | null | undefined) => void): boolean;
    write(chunk: any, encoding: BufferEncoding, callback?: (error: Error | null | undefined) => void): boolean;
}
