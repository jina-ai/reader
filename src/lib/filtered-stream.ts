import { Transform, TransformCallback } from "stream";
import _ from 'lodash';


class FilteredTextResponseStream extends Transform {

    constructor(public path: string, public predicate?: (data: any) => boolean) {
        super({ writableObjectMode: true, encoding: 'utf-8' });
    }

    override _transform(chunk: any, _encoding: string, callback: TransformCallback) {
        if (this.predicate) {
            if (!this.predicate(chunk)) {
                callback();
                return;
            }
        }
        const interest = _.get(chunk, this.path);

        if (typeof interest === 'string') {
            if (interest) {
                this.push(interest);
            }
        }

        callback();
    }
}

export function getFilteredTextStream(path: string = 'data.choices[0].delta.content', predicate?: (data: any) => boolean) {
    return new FilteredTextResponseStream(path, predicate);
}

class FilteredResponseStream extends Transform {

    constructor(public path: string, public predicate?: (data: any) => boolean) {
        super({ objectMode: true });
    }

    override _transform(chunk: any, _encoding: string, callback: TransformCallback) {
        if (this.predicate) {
            if (!this.predicate(chunk)) {
                callback();
                return;
            }
        }
        const interest = _.get(chunk, this.path);

        if (interest) {
            this.push(interest);
        }

        callback();
    }
}

export function getFilteredStream(path: string = 'data.choices[0].delta.content', predicate?: (data: any) => boolean) {
    return new FilteredResponseStream(path, predicate);
}
