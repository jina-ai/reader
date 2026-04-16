import { TrieNode } from 'civkit/trie';
import _ from 'lodash';
import { Transform } from 'stream';


enum PARSE_STATE {
    EXPECT_VALUE = 'ExpectValue',

    EXPECT_OBJECT = 'ExpectObject',
    EXPECT_OBJECT_KEY = 'ExpectObjectKey',
    EXPECT_ARRAY = 'ExpectArray',

    EXPECT_NUMBER = 'ExpectNumber',
    EXPECT_STRING = 'ExpectString',
    EXPECT_TRUE = 'ExpectTrue',
    EXPECT_FALSE = 'ExpectFalse',
    EXPECT_NULL = 'ExpectNull',
    EXPECT_ESCAPED_CHAR = 'ExpectEscapedChar',
    EXPECT_ESCAPED_UNICODE_CHAR = 'ExpectEscapedUnicodeChar',
}

const CTRL_CHARS = new Set('\u0000\u0001\u0002\u0003\u0004\u0005\u0006\u0007\u0008\u0009\u000a\u000b\u000c\u000d\u000e\u000f\u0010\u0011\u0012\u0013\u0014\u0015\u0016\u0017\u0018\u0019\u001a\u001b\u001c\u001d\u001e\u001f\u0080\u0081\u0082\u0083\u0084\u0085\u0086\u0087\u0088\u0089\u008a\u008b\u008c\u008d\u008e\u008f\u0090\u0091\u0092\u0093\u0094\u0095\u0096\u0097\u0098\u0099\u009a\u009b\u009c\u009d\u009e\u009f');
const WS_S = new Set('\t\r\n ');
const NUMBER_S = new Set('-+0123456789eE.');
const NUMBER_0_S = new Set('-0123456789');
const NUMBER_D_S = new Set('0123456789');
const HEX_NUMBER_S = new Set('0123456789abcdefABCDEF');
const ESCAPE_M = new Map([
    ['"', '"'],
    ['\\', '\\'],
    ['/', '/'],
    ['b', '\b'],
    ['f', '\f'],
    ['n', '\n'],
    ['r', '\r'],
    ['t', '\t'],
]);

const SYM_NOT_SET = Symbol('NotSet');

export interface JSONParserStreamOptions {

    expectControlCharacterInString?: boolean;
    expectCasingInLiteral?: boolean;

    expectContaminated?: 'object' | 'array' | boolean;

    expectAbruptTerminationOfInput?: boolean;

    swallowErrors?: boolean;

}

export type JSONParserOffsetMetadata = { byteOffset: number, offset: number; };
export type JSONParserEvent = ({
    event: 'nodeStart',
    data: {
        type: 'object' | 'array' | 'objectKey' | 'objectValue' | 'objectEntry' | 'number' | 'true' | 'false' | 'null',
    } | {
        type: 'text',
        variant?: 'objectKey' | 'value',
    } | {
        type: 'arrayEntry',
        index: number;
    };
} | {
    event: 'nodeEnd',
    data: {
        type: 'object' | 'array' | 'objectKey' | 'objectValue' | 'objectEntry' | 'arrayEntry' | 'number' | 'true' | 'false' | 'null',
        value?: any,
    } | {
        type: 'text',
        value: string,
        variant: 'objectKey' | 'value',
    };
} | {
    event: 'text',
    data: {
        value: string,
    };
} | {
    event: 'textChunk',
    data: {
        value: string,
    };
} | {
    event: 'end',
}) & JSONParserOffsetMetadata | {
    event: 'raw',
    data: string;
};

export class JSONParserStream extends Transform {

    static parse(input: string, opts?: JSONParserStreamOptions) {
        const i = new this(opts);
        i._syncBuff = [];
        i.pendingChunks.push(Buffer.from(input, 'utf-8'));
        i.resume();
        i.routine();
        i.finishLingeringStack();

        return i._syncBuff;
    }

    override push(chunk: Partial<JSONParserEvent> | null, enc?: any) {
        if (chunk && chunk.event !== 'raw') {
            Reflect.set(chunk, 'offset', this.n);
            Reflect.set(chunk, 'byteOffset', this.bn);
        }

        if (this._syncBuff && chunk !== null) {
            this._syncBuff.push(chunk as any);
        }

        return super.push(chunk, enc);
    }

    private _syncBuff?: JSONParserEvent[];

    protected everParsedAnything?: boolean;
    public encoding: string = 'utf-8';
    protected __decoder?: InstanceType<typeof TextDecoder>;

    protected pendingChunks: Buffer[] = [];

    protected bn: number = -1;
    protected n: number = -1;
    n1?: number;
    n2?: number;

    protected stateStack: {
        state: PARSE_STATE,
        chunk: string,
        parsed: any,
    }[] = [];

    protected get decoder() {
        this.__decoder ??= new TextDecoder(this.encoding, { fatal: false, ignoreBOM: false });

        return this.__decoder;
    }

    protected *step() {
        let buff: Buffer | undefined;
        while (buff = this.pendingChunks.shift()) {
            const chunk = Array.from(buff);
            try {
                let byteScalar: number | undefined;
                while (true) {
                    byteScalar = chunk.shift();
                    if (byteScalar === undefined) {
                        break;
                    }
                    const byte = Uint8Array.from([byteScalar]);
                    const char = this.decoder.decode(byte, { stream: true });
                    this.bn += 1;
                    if (char) {
                        this.n += 1;
                        yield char;
                    }
                }
            } finally {
                if (chunk.length) {
                    this.pendingChunks.unshift(Buffer.from(chunk));
                }
            }
        }
    }

    protected get curStack() {
        return this.stateStack[this.stateStack.length - 1];
    }

    protected get cX() {
        return this.curStack.chunk;
    }
    protected set cX(v: string) {
        this.curStack.chunk = v;
    }

    protected get pX() {
        return this.curStack.parsed;
    }
    protected set pX(v: any) {
        this.curStack.parsed = v;
    }

    protected iX: string = '';
    protected rX: any = SYM_NOT_SET;
    protected rsX?: PARSE_STATE;

    protected fwF: boolean = false;
    protected forward() {
        this.fwF = true;
    }

    protected pusF: boolean = false;
    protected isX?: PARSE_STATE;
    protected pushStack(state: PARSE_STATE) {
        this.pusF = true;
        this.isX = state;
        if (!this.everParsedAnything) {
            this.everParsedAnything = true;
            this.n1 = this.n;
            this.emit('n1', this.n1);
        }
    }

    protected posF: boolean = false;
    protected popStack() {
        this.posF = true;
    }

    error?: Error;

    constructor(public options?: JSONParserStreamOptions) {
        super({
            readableObjectMode: true,
        });

        switch (this.options?.expectContaminated) {
            case 'object': {
                this.stateStack.push({
                    state: PARSE_STATE.EXPECT_OBJECT,
                    chunk: '',
                    parsed: SYM_NOT_SET,
                });
                break;
            }
            case 'array': {
                this.stateStack.push({
                    state: PARSE_STATE.EXPECT_ARRAY,
                    chunk: '',
                    parsed: SYM_NOT_SET,
                });
                break;
            }
            default: {
                this.stateStack.push({
                    state: PARSE_STATE.EXPECT_VALUE,
                    chunk: '',
                    parsed: SYM_NOT_SET,
                });
                break;
            }
        }

        this.__reset();
    }

    override _transform(chunk: any, encoding: BufferEncoding, callback: (error?: Error, data?: any) => void) {
        if (encoding && encoding !== 'binary') {
            this.encoding ??= encoding;
        }
        if (!this.stateStack.length || this.error) {
            if (typeof chunk === 'string') {
                this.push({ event: 'raw', data: chunk });
            } else if (Buffer.isBuffer(chunk)) {
                const text = chunk.toString('utf8');
                this.push({ event: 'raw', data: text });
            }
            callback();
            return;
        }

        if (typeof chunk === 'string') {
            this.pendingChunks.push(Buffer.from(chunk, 'utf-8'));
            this.push({ event: 'raw', data: chunk });
        } else if (Buffer.isBuffer(chunk)) {
            const text = chunk.toString(encoding);
            this.pendingChunks.push(chunk);
            this.push({ event: 'raw', data: text });
        }

        try {
            this.routine();
            callback();
        } catch (err: any) {
            callback(err);
        }
    }

    override _flush(callback: (error?: Error, data?: any) => void) {
        if (!this.stateStack.length) {
            this.push({ event: 'end' });
            this.push(null);

            callback();
            return;
        }

        try {
            this.routine();
            this.finishLingeringStack();
        } catch (err: any) {
            return callback(err);
        }
        this.push({ event: 'end' });
        this.push(null);

        callback();
    }

    protected __reset() {
        this.iX = '';
        this.isX = undefined;
        this.cX = '';
        this.pX = SYM_NOT_SET;
        this.rX = SYM_NOT_SET;
        this.rsX = undefined;
        this.fwF = false;
        this.pusF = false;
        this.posF = false;
    }

    protected routine() {
        if (!this.curStack) {
            return;
        }

        outerLoop:
        for (const c of this.step()) {
            this.iX = c;
            while (true) {
                this[`on${this.curStack.state}`]();

                let flawedImplementation = true;
                if (this.pusF && this.posF) {
                    throw new Error('Unexpected state. Cannot push and pop stack at the same time');
                } else if (this.pusF) {
                    const lastState = this.curStack.state;
                    this.stateStack.push({
                        state: this.isX!,
                        chunk: '',
                        parsed: SYM_NOT_SET,
                    });
                    this.isX = lastState;
                    this.rX = SYM_NOT_SET;
                    this.pusF = false;
                    flawedImplementation = false;
                } else if (this.posF) {
                    this.rX = this.pX;
                    this.rsX = this.curStack.state;
                    this.isX = this.stateStack[this.stateStack.length - 2]?.state;
                    this.stateStack.pop();
                    this.posF = false;

                    flawedImplementation = false;

                    if (!this.stateStack.length) {
                        this.n2 = this.n;
                        this.emit('n2', this.n2);
                        break outerLoop;
                    }
                } else if (this.rX !== SYM_NOT_SET) {
                    this.rX = SYM_NOT_SET;
                    this.rsX = undefined;
                    flawedImplementation = false;
                }

                if (this.fwF) {
                    flawedImplementation = false;
                    this.fwF = false;
                    break;
                }
                if (flawedImplementation) {
                    throw new Error(`Unexpected stall. Flawed implementation detected at pos ${this.n}(${this.iX})`);
                }
            }

        }


        this.pendingChunks.length = 0;
        if (this.curStack?.state === PARSE_STATE.EXPECT_STRING) {
            const chunkOffset = Reflect.get(this.curStack, 'offset') ?? 0;
            Reflect.set(this.curStack, 'offset', this.pX?.length || 0);
            const chunkVal = this.pX.slice(chunkOffset).join('');
            if (chunkVal) {
                this.push({ event: 'textChunk', data: { value: chunkVal } });
            }
        }
    }

    protected onUnexpectedToken(msg?: string) {
        const err = new SyntaxError(`${msg || `Unexpected token ${JSON.stringify(this.iX)}`} in JSON at position ${this.n}`);
        if (!this.options?.swallowErrors) {
            throw err;
        }
        this.error ??= err;
    }
    protected onUnexpectedEnd() {
        const err = this.everParsedAnything ?
            new SyntaxError(`Unexpected end of input at position ${this.n} before encountering any valid JSON`) :
            new SyntaxError(`Unexpected end of JSON input at position ${this.n}`);
        if (!(this.options?.swallowErrors || this.options?.expectAbruptTerminationOfInput)) {
            throw err;
        }
        if (!this.options?.expectAbruptTerminationOfInput) {
            this.error ??= err;
        }
    }

    protected onExpectValue() {
        const r = this.rX;
        if (r !== SYM_NOT_SET) {
            if (this.stateStack.length > 1) {
                this.pX = r;
                this.popStack();
            }
            return;
        }
        const c = this.iX;


        switch (c) {
            case '"': {
                this.pushStack(PARSE_STATE.EXPECT_STRING);
                return;
            }
            case '{': {
                this.pushStack(PARSE_STATE.EXPECT_OBJECT);
                return;
            }
            case '[': {
                this.pushStack(PARSE_STATE.EXPECT_ARRAY);
                return;
            }
            case 'T':
            case 't': {
                this.pushStack(PARSE_STATE.EXPECT_TRUE);
                return;
            }
            case 'F':
            case 'f': {
                this.pushStack(PARSE_STATE.EXPECT_FALSE);
                return;
            }
            case 'N':
            case 'n': {
                this.pushStack(PARSE_STATE.EXPECT_NULL);
                return;
            }

            default: {

                break;
            }
        }

        if (WS_S.has(c)) {
            this.forward();
            return;
        }
        if (NUMBER_0_S.has(c)) {
            this.pushStack(PARSE_STATE.EXPECT_NUMBER);
            return;
        }

        if (this.stateStack.length === 1 && this.options?.expectContaminated) {
            this.forward();
            return;
        }

        this.onUnexpectedToken();
    }

    protected onExpectString() {
        const r = this.rX;
        if (r !== SYM_NOT_SET) {
            if (typeof r === 'string') {
                this.pX.push(r);
            }
        }

        const c = this.iX;

        if (c === '"') {
            if (this.pX === SYM_NOT_SET) {
                this.pX = [];
                this.push({
                    event: 'nodeStart', data: {
                        type: 'text',
                        variant: this.isX === PARSE_STATE.EXPECT_OBJECT_KEY ? 'objectKey' : 'value'
                    }
                });
                this.forward();
                return;
            }

            this.pX = this.pX.join('');
            this.push({ event: 'text', data: { value: this.pX } });
            this.push({
                event: 'nodeEnd', data: {
                    type: 'text', value: this.pX,
                    variant: this.isX === PARSE_STATE.EXPECT_OBJECT_KEY ? 'objectKey' : 'value'
                }
            });
            this.forward();
            this.popStack();
            return;
        }

        if (!Array.isArray(this.pX)) {
            if (this.stateStack.length === 1 && this.options?.expectContaminated) {
                this.forward();
                return;
            }
            this.onUnexpectedToken();

            return;
        }

        if (c === '\\') {
            this.pushStack(PARSE_STATE.EXPECT_ESCAPED_CHAR);
            return;
        }

        if (!this.options?.expectControlCharacterInString && CTRL_CHARS.has(c)) {
            this.onUnexpectedToken(`Bad control character in string literal`);
        }

        this.pX.push(c);
        this.forward();
    }

    protected onExpectEscapedChar() {
        const r = this.rX;
        if (r !== SYM_NOT_SET) {
            this.pX = r;
            this.popStack();
            return;
        }

        const c = this.iX;

        if (c === '\\') {
            if (typeof this.pX !== 'string') {
                this.cX += c;
                this.pX = '';
                this.forward();
                return;
            }
        }

        if (ESCAPE_M.has(c)) {
            this.cX += c;
            this.pX = ESCAPE_M.get(c);
            this.forward();
            this.popStack();
            return;
        }

        if (c === 'u') {
            this.pushStack(PARSE_STATE.EXPECT_ESCAPED_UNICODE_CHAR);
            return;
        }

        this.onUnexpectedToken(`Bad escape character`);
        this.forward();

        this.popStack();
        return;
    }

    protected onExpectEscapedUnicodeChar() {
        const c = this.iX;

        if (typeof this.pX !== 'string' && c === 'u') {
            // first char of \uxxxx u
            this.cX = c;
            this.pX = '';
            this.forward();

            return;
        }

        if (HEX_NUMBER_S.has(c) && this.cX.length < 1 + 4) {
            this.cX += c;
            this.forward();
        }

        if (this.cX.length === 1 + 4) {
            this.pX = String.fromCharCode(parseInt(this.cX.slice(1), 16));
            this.forward();
            this.popStack();
            return;
        }

        this.onUnexpectedToken(`Bad unicode escape`);

        this.pX = this.cX;
        this.popStack();
        return;

    }

    protected onExpectNumber() {
        const c = this.iX;

        if (this.cX === '') {
            if (!NUMBER_0_S.has(c)) {
                this.onUnexpectedToken();
            }
            this.push({ event: 'nodeStart', data: { type: 'number' } });
        }
        if (this.cX === '-' && (!NUMBER_D_S.has(c))) {
            this.onUnexpectedToken('No number after minus sign');
        }
        const lastChar = this.cX[this.cX.length - 1] || '';
        if (lastChar === '.' && !NUMBER_D_S.has(c)) {
            this.onUnexpectedToken('Unterminated fractional number');
        }
        if (lastChar.toLowerCase() === 'e' && !NUMBER_D_S.has(c)) {
            this.onUnexpectedToken('Exponent part is missing a number');
        }
        if ((this.cX === '0' || this.cX === '-0') && NUMBER_D_S.has(c)) {
            this.onUnexpectedToken('Unexpected number');
        }

        switch (c) {
            case '.': {
                if (this.cX.includes('.') || this.cX.includes('e') || this.cX.includes('E')) {
                    this.onUnexpectedToken();
                }
                break;
            }
            case '+': {
                if (!'eE'.includes(lastChar)) {
                    this.onUnexpectedToken();
                }
                break;
            }
            case '-': {
                if (this.cX && !'eE'.includes(this.cX[this.cX.length - 1])) {
                    this.onUnexpectedToken();
                }
                break;
            }
            default: {
                break;
            }
        }

        if (NUMBER_S.has(c)) {
            this.cX += c;
            this.forward();
            return;
        }

        if (this.cX === '') {
            this.onUnexpectedToken();
        }

        this.pX = parseFloat(this.cX);

        this.push({ event: 'text', data: { value: this.cX } });
        this.push({ event: 'nodeEnd', data: { type: 'number', value: this.pX } });
        this.popStack();

        return;
    }

    protected onExpectTrue() {
        const c = this.iX;

        if (typeof this.pX !== 'string') {
            this.cX = '';
            this.pX = '';
            this.push({ event: 'nodeStart', data: { type: 'true' } });
        }

        if ((this.options?.expectCasingInLiteral ? 'trueTRUE' : 'true').includes(c)) {
            this.cX += c;
        } else {
            this.onUnexpectedToken();
            this.push({ event: 'text', data: { value: this.cX } });
            this.pX = this.cX;
            this.push({ event: 'nodeEnd', data: { type: 'true', value: this.pX } });
            this.popStack();
            return;
        }

        const lc = this.cX.toLowerCase();
        if (!['t', 'tr', 'tru', 'true'].includes(lc)) {
            this.onUnexpectedToken();
            this.pX = this.cX;
            this.push({ event: 'text', data: { value: this.cX } });
            this.push({ event: 'nodeEnd', data: { type: 'true' } });
            this.popStack();
            return;
        }

        if (this.cX.length === 4) {
            if (lc === 'true') {
                this.pX = true;
                this.forward();
                this.push({ event: 'text', data: { value: this.cX } });
                this.push({ event: 'nodeEnd', data: { type: 'true', value: this.pX } });
                this.popStack();

                return;
            }
        }

        if (this.cX.length < 4) {
            this.forward();
            return;
        }

        this.onUnexpectedToken();
        this.pX = this.cX;
        this.push({ event: 'text', data: { value: this.cX } });
        this.push({ event: 'nodeEnd', data: { type: 'true', value: this.pX } });
        this.popStack();
    }

    protected onExpectFalse() {
        const c = this.iX;

        if (typeof this.pX !== 'string') {
            this.cX = '';
            this.pX = '';
            this.push({ event: 'nodeStart', data: { type: 'false' } });
        }

        if ((this.options?.expectCasingInLiteral ? 'falseFALSE' : 'false').includes(c)) {
            this.cX += c;
        } else {
            this.onUnexpectedToken();
            this.push({ event: 'text', data: { value: this.cX } });
            this.pX = this.cX;
            this.push({ event: 'nodeEnd', data: { type: 'false', value: this.pX } });
            this.popStack();
            return;
        }

        const lc = this.cX.toLowerCase();
        if (!['f', 'fa', 'fal', 'fals', 'false'].includes(lc)) {
            this.onUnexpectedToken();
            this.pX = this.cX;
            this.push({ event: 'text', data: { value: this.cX } });
            this.push({ event: 'nodeEnd', data: { type: 'false' } });
            this.popStack();
            return;
        }

        if (this.cX.length === 5) {
            if (lc === 'false') {
                this.pX = false;
                this.forward();
                this.push({ event: 'text', data: { value: this.cX } });
                this.push({ event: 'nodeEnd', data: { type: 'false', value: this.pX } });
                this.popStack();

                return;
            }
        }

        if (this.cX.length < 5) {
            this.forward();
            return;
        }

        this.onUnexpectedToken();
        this.pX = this.cX;
        this.push({ event: 'text', data: { value: this.cX } });
        this.push({ event: 'nodeEnd', data: { type: 'false', value: this.pX } });
        this.popStack();
    }

    protected onExpectNull() {
        const c = this.iX;

        if (typeof this.pX !== 'string') {
            this.cX = '';
            this.pX = '';
            this.push({ event: 'nodeStart', data: { type: 'null' } });
        }

        if ((this.options?.expectCasingInLiteral ? 'nullNULL' : 'null').includes(c)) {
            this.cX += c;
        } else {
            this.onUnexpectedToken();
            this.push({ event: 'text', data: { value: this.cX } });
            this.pX = this.cX;
            this.push({ event: 'nodeEnd', data: { type: 'null', value: this.pX } });
            this.popStack();
            return;
        }

        const lc = this.cX.toLowerCase();
        if (!['n', 'nu', 'nul', 'null'].includes(lc)) {
            this.onUnexpectedToken();
            this.pX = this.cX;
            this.push({ event: 'text', data: { value: this.cX } });
            this.push({ event: 'nodeEnd', data: { type: 'null' } });
            this.popStack();
            return;
        }

        if (this.cX.length === 4) {
            if (lc === 'null') {
                this.pX = null;
                this.forward();
                this.push({ event: 'text', data: { value: this.cX } });
                this.push({ event: 'nodeEnd', data: { type: 'null', value: this.pX } });
                this.popStack();

                return;
            }
        }

        if (this.cX.length < 4) {
            this.forward();
            return;
        }

        this.onUnexpectedToken();
        this.pX = this.cX;
        this.push({ event: 'text', data: { value: this.cX } });
        this.push({ event: 'nodeEnd', data: { type: 'null', value: this.pX } });
        this.popStack();
    }

    protected onExpectObject() {
        const r = this.rX;
        const c = this.iX;

        if (r !== SYM_NOT_SET) {
            switch (this.rsX) {
                case PARSE_STATE.EXPECT_OBJECT_KEY: {
                    this.cX = r;
                    this.push({ event: 'nodeEnd', data: { type: 'objectKey', value: r } });

                    break;
                }

                case PARSE_STATE.EXPECT_VALUE: {
                    this.cX = '';

                    this.push({ event: 'nodeEnd', data: { type: 'objectValue', value: r } });
                    this.push({ event: 'nodeEnd', data: { type: 'objectEntry' } });
                    break;
                }

                default: {
                    break;
                }
            }

            return;
        }

        switch (c) {
            case '{': {
                if (this.pX === SYM_NOT_SET) {
                    this.pX = {};
                    this.cX = c;
                    this.push({ event: 'nodeStart', data: { type: 'object' } });
                    this.forward();
                    this.pushStack(PARSE_STATE.EXPECT_OBJECT_KEY);
                    return;
                }

                this.onUnexpectedToken(`Expected property name or '}'`);
                return;
            }

            case ':': {
                if (this.pX === SYM_NOT_SET) {
                    this.onUnexpectedToken(`Invalid json`);
                    this.forward();
                    return;
                }
                this.cX = c;
                this.push({ event: 'nodeStart', data: { type: 'objectValue' } });
                this.pushStack(PARSE_STATE.EXPECT_VALUE);
                this.forward();
                return;
            }
            case ',': {
                if (this.pX === SYM_NOT_SET) {
                    this.onUnexpectedToken(`Invalid json`);
                    this.forward();
                    return;
                }
                this.cX = c;
                this.pushStack(PARSE_STATE.EXPECT_OBJECT_KEY);
                this.forward();
                return;
            }
            case '}': {
                if (this.pX === SYM_NOT_SET) {
                    this.onUnexpectedToken(`Invalid json`);
                    this.forward();
                    return;
                }
                this.push({ event: 'nodeEnd', data: { type: 'object' } });
                this.forward();
                this.popStack();

                return;
            }

            default: {
                break;
            }
        }

        if (WS_S.has(c)) {
            this.forward();
            return;
        }

        if (this.stateStack.length === 1 && this.options?.expectContaminated) {
            this.forward();
            return;
        }

        switch (this.cX) {
            case '{': {
                this.onUnexpectedToken(`Expected property name or '}'`);
                break;
            }
            case ':': {
                this.onUnexpectedToken();
                break;
            }
            case ',': {
                this.onUnexpectedToken(`Expected double-quoted property name`);
                break;
            }
            default: {
                if (this.rX === SYM_NOT_SET) {
                    this.onUnexpectedToken(`Expected property name or '}'`);
                } else if (this.cX) {
                    this.onUnexpectedToken(`Expected ':' after property name`);
                } else {
                    this.onUnexpectedToken();
                }
            }
        }
    }

    protected onExpectObjectKey() {
        const r = this.rX;
        if (r !== SYM_NOT_SET) {
            this.pX = r;
            this.popStack();
            return;
        }

        const c = this.iX;
        if (c === '"') {
            this.push({ event: 'nodeStart', data: { type: 'objectEntry' } });
            this.push({ event: 'nodeStart', data: { type: 'objectKey' } });
            this.pushStack(PARSE_STATE.EXPECT_STRING);
            return;
        }

        if (c === '}') {
            this.popStack();
            return;
        }

        if (WS_S.has(c)) {
            this.forward();
            return;
        }

        this.onUnexpectedToken(`Expected property name or '}'`);
        this.popStack();

        return;
    }

    protected onExpectArray() {
        const r = this.rX;
        const c = this.iX;
        if (r !== SYM_NOT_SET) {
            this.push({ event: 'nodeEnd', data: { type: 'arrayEntry', value: r } });

            return;
        }

        if (WS_S.has(c)) {
            this.forward();
            return;
        }

        if (this.pX === SYM_NOT_SET && c !== '[') {
            if (this.stateStack.length === 1 && this.options?.expectContaminated) {
                this.forward();
                return;
            }

            this.onUnexpectedToken();
            return;
        }

        switch (c) {
            case '[': {
                if (this.pX === SYM_NOT_SET) {
                    this.cX = '[';
                    this.pX = 0;
                    this.push({ event: 'nodeStart', data: { type: 'array' } });
                    this.forward();
                    return;
                }
                break;
            }
            case ',': {
                if (this.pX === SYM_NOT_SET) {
                    this.onUnexpectedToken(`Invalid json`);
                    this.forward();
                    return;
                }
                this.cX = ',';
                this.forward();
                this.push({ event: 'nodeStart', data: { type: 'arrayEntry', index: this.pX++ } });
                this.pushStack(PARSE_STATE.EXPECT_VALUE);

                return;
            }
            case ']': {
                if (this.pX === SYM_NOT_SET) {
                    this.onUnexpectedToken(`Invalid json`);
                    this.forward();
                    return;
                }
                this.push({ event: 'nodeEnd', data: { type: 'array' } });
                this.pX = [];
                this.forward();
                this.popStack();
                return;
            }

            default: {
                break;
            }
        }

        if (this.pX !== 0) {
            this.onUnexpectedToken(`Expected ',' or ']' after array element`);
            this.popStack();

            return;
        }

        this.push({ event: 'nodeStart', data: { type: 'arrayEntry', index: this.pX++ } });
        this.pushStack(PARSE_STATE.EXPECT_VALUE);
        return;
    }

    protected finishLingeringStack() {
        if (!this.stateStack.length) {
            return;
        }
        this.onUnexpectedEnd();

        let rtn: any = undefined;
        let lastState: PARSE_STATE | undefined = undefined;
        const reversedStack = this.stateStack.reverse();
        for (const [i, curStack] of reversedStack.entries()) {
            const prevStack = reversedStack[i + 1];
            switch (curStack.state) {
                case PARSE_STATE.EXPECT_OBJECT_KEY: {
                    rtn = rtn;
                    break;
                }
                case PARSE_STATE.EXPECT_VALUE: {
                    rtn = rtn;
                    break;
                }
                case PARSE_STATE.EXPECT_OBJECT: {
                    switch (lastState) {
                        case PARSE_STATE.EXPECT_OBJECT_KEY: {
                            this.push({ event: 'nodeEnd', data: { type: 'objectKey', value: rtn } });
                            this.push({ event: 'nodeStart', data: { type: 'objectValue' } });
                            this.push({ event: 'nodeEnd', data: { type: 'objectValue', value: undefined } });
                            this.push({ event: 'nodeEnd', data: { type: 'objectEntry' } });
                            break;
                        }

                        case PARSE_STATE.EXPECT_VALUE: {
                            this.push({ event: 'nodeEnd', data: { type: 'objectValue', value: rtn || undefined } });
                            this.push({ event: 'nodeEnd', data: { type: 'objectEntry' } });
                            break;
                        }

                        default: {
                            break;
                        }
                    }
                    rtn = {};

                    this.push({ event: 'nodeEnd', data: { type: 'object' } });
                    break;
                }
                case PARSE_STATE.EXPECT_ARRAY: {
                    if (lastState && rtn) {
                        this.push({ event: 'nodeEnd', data: { type: 'arrayEntry', value: rtn } });
                    }

                    rtn = [];
                    this.push({ event: 'nodeEnd', data: { type: 'array' } });
                    break;
                }

                case PARSE_STATE.EXPECT_STRING: {
                    const v = Array.isArray(curStack.parsed) ? curStack.parsed : [];
                    if (typeof rtn === 'string' && rtn) {
                        v.push(rtn);
                    }
                    rtn = v.join('');
                    this.push({ event: 'text', data: { value: rtn } });
                    this.push({
                        event: 'nodeEnd', data: {
                            type: 'text',
                            value: rtn,
                            variant:
                                prevStack?.state === PARSE_STATE.EXPECT_OBJECT_KEY ? 'objectKey' : 'value'
                        }
                    });

                    break;
                }

                case PARSE_STATE.EXPECT_NUMBER: {
                    const v = parseFloat(curStack.chunk);
                    rtn = v;
                    this.push({ event: 'text', data: { value: curStack.chunk } });
                    this.push({ event: 'nodeEnd', data: { type: 'number', value: rtn } });
                    break;
                }

                case PARSE_STATE.EXPECT_TRUE: {
                    rtn = true;
                    this.push({ event: 'text', data: { value: curStack.chunk } });
                    this.push({ event: 'nodeEnd', data: { type: 'true', value: rtn } });
                    break;
                }
                case PARSE_STATE.EXPECT_FALSE: {
                    rtn = false;
                    this.push({ event: 'text', data: { value: curStack.chunk } });
                    this.push({ event: 'nodeEnd', data: { type: 'false', value: rtn } });
                    break;
                }
                case PARSE_STATE.EXPECT_NULL: {
                    rtn = null;
                    this.push({ event: 'text', data: { value: curStack.chunk } });
                    this.push({ event: 'nodeEnd', data: { type: 'null', value: rtn } });
                    break;
                }
                case PARSE_STATE.EXPECT_ESCAPED_CHAR: {
                    rtn = '';
                    break;
                }
                case PARSE_STATE.EXPECT_ESCAPED_UNICODE_CHAR: {
                    rtn = '';
                    break;
                }
                default: {
                    break;
                }
            }
            lastState = curStack.state;
        }

        this.stateStack.length = 0;
    }
}

export class JSONAccumulation extends Transform {
    static parse(input: JSONParserEvent[], focus: string | string[] = '', withOffsetMetadata = false) {
        const i = new this(focus, withOffsetMetadata);
        i.resume();
        for (const x of input) {
            i.evRoutine(x);
        }

        return i.accumulated;
    }

    static parseWithOffsetMetadata(input: JSONParserEvent[], focus: string | string[] = '') {
        const i = new this(focus, true);
        i.resume();
        for (const x of input) {
            i.evRoutine(x);
        }

        return i;
    }

    public focus: string[];
    protected ptrPath: string[] = [];

    protected inFocus: boolean = false;

    public accumulated: any = undefined;

    private lastCallback?: Function;
    private immediateHandle?: ReturnType<typeof setImmediate>;

    protected wn = 0;
    protected ln?: number;

    offsetMetaTrie?: TrieNode<string, {
        startOffset: number;
        endOffset: number;
        startByteOffset: number;
        endByteOffset: number;
    }>;
    offsetMetadata?: OffsetQueryCompanion;

    constructor(focus: string | string[] = '', public readonly withOffsetMetadata = false) {
        super({
            objectMode: true,
        });

        if (typeof focus === 'string') {
            this.focus = _.toPath(focus);
        } else {
            this.focus = focus;
        }

        if (this.focus.length === 0) {
            this.inFocus = true;
        }

        if (withOffsetMetadata) {
            this.offsetMetaTrie = new TrieNode('', {} as any);
            this.offsetMetadata = new OffsetQueryCompanion(this.offsetMetaTrie);
        }

    }

    get ptr() {
        const relativePath = this.ptrPath.slice(this.focus.length);

        if (relativePath.length === 0) {
            return this.accumulated;
        }

        return _.get(this.accumulated, relativePath);
    }

    protected declareStartOffset(offsetMeta: JSONParserOffsetMetadata) {
        if (!(this.offsetMetaTrie && this.inFocus)) {
            return;
        }
        const node = this.offsetMetaTrie.insert(...this.ptrPath);
        node.payload ??= {} as any;
        node.payload!.startOffset = offsetMeta.offset;
        node.payload!.startByteOffset = offsetMeta.byteOffset;
        let ptr: typeof node | null = node.parent;
        while (ptr) {
            node.payload ??= {} as any;
            node.payload!.startOffset ??= offsetMeta.offset;
            node.payload!.startByteOffset ??= offsetMeta.byteOffset;
            ptr = ptr.parent;
        }
    }
    protected declareEndOffset(offsetMeta: JSONParserOffsetMetadata, soft = false) {
        if (!(this.offsetMetaTrie && this.inFocus)) {
            return;
        }

        let [curPtr, leftInStack] = this.offsetMetaTrie.seek(...this.ptrPath);
        if (leftInStack.length === 0) {
            curPtr.payload ??= {} as any;
            curPtr.payload!.startOffset ??= offsetMeta.offset;
            curPtr.payload!.startByteOffset ??= offsetMeta.byteOffset;
            if (soft) {
                curPtr.payload!.endOffset ??= offsetMeta.offset + 1;
                curPtr.payload!.endByteOffset ??= offsetMeta.byteOffset + 1;
            } else {
                curPtr.payload!.endOffset = offsetMeta.offset + 1;
                curPtr.payload!.endByteOffset = offsetMeta.byteOffset + 1;
            }
        }
    }

    pushPtr(vec: string) {
        this.ptrPath.push(vec);
        if (
            !this.inFocus &&
            this.ptrPath.length === this.focus.length && _.isEqual(this.ptrPath, this.focus)
        ) {
            this.inFocus = true;
            this.emit('focus');
        }
    }
    popPtr() {
        this.ptrPath.pop();
        if (
            this.inFocus &&
            (
                this.ptrPath.length < this.focus.length ||
                (
                    this.focus.length &&
                    this.focus.length === this.ptrPath.length &&
                    !_.isEqual(this.ptrPath, this.focus)
                )
            )
        ) {
            this.inFocus = false;
            this.emit('blur');
        }
    }
    writePtr(vec: any) {
        if (!this.inFocus) {
            return;
        }

        this.wn++;
        const relativePath = this.ptrPath.slice(this.focus.length);
        if (relativePath.length === 0) {
            this.accumulated = vec;

            if (this.offsetMetaTrie && (typeof this.accumulated === 'object' && this.accumulated !== null)) {
                Reflect.defineMetadata('json:offset', this.offsetMetadata, this.accumulated);
            }

            return;
        }
        _.set(this.accumulated, relativePath, vec);

    }
    writeXPtr(vec: string) {
        if (!this.inFocus) {
            return;
        }
        const cur = this.ptr;
        if (typeof cur !== 'string') {
            if (cur === undefined) {
                return this.writePtr(vec);
            }

            return;
        }
        this.writePtr(cur + vec);
    }

    evRoutine(ev: JSONParserEvent) {
        switch (ev.event) {
            case 'nodeStart': {
                switch (ev.data?.type) {
                    case 'object': {
                        this.writePtr({});
                        this.declareStartOffset(ev);
                        break;
                    }
                    case 'array': {
                        this.writePtr([]);
                        this.declareStartOffset(ev);
                        break;
                    }
                    case 'arrayEntry': {
                        this.pushPtr(`${ev.data.index}`);
                        break;
                    }
                    case 'text': {
                        if (ev.data.variant === 'objectKey') {
                            break;
                        }
                        this.writePtr('');
                        this.declareStartOffset({ offset: ev.offset + 1, byteOffset: ev.byteOffset + 1 });
                        break;
                    }

                    default: {
                        break;
                    }
                }

                break;
            }
            case 'textChunk': {
                this.writeXPtr(ev.data?.value);
                this.declareEndOffset(ev);
                break;
            }
            case 'nodeEnd': {
                switch (ev.data?.type) {
                    case 'objectKey': {
                        this.pushPtr(ev.data.value);
                        break;
                    }
                    case 'objectValue': {
                        if (typeof ev.data.value !== 'object' || ev.data.value === null) {
                            this.writePtr(ev.data.value);
                        }
                        this.declareEndOffset(ev, true);
                        this.popPtr();
                        break;
                    }
                    case 'arrayEntry': {
                        if (typeof ev.data.value !== 'object' || ev.data.value === null) {
                            this.writePtr(ev.data.value);
                        }
                        this.declareEndOffset(ev, true);
                        this.popPtr();
                        break;
                    }
                    case 'text': {
                        if (ev.data.variant === 'objectKey') {
                            break;
                        }
                        this.writePtr(ev.data.value);
                        this.declareEndOffset({ offset: ev.offset - 1, byteOffset: ev.byteOffset - 1 });
                        break;
                    }
                    case 'number': {
                        this.writePtr(ev.data.value);
                        this.declareEndOffset(ev);
                        break;
                    }
                    case 'true': {
                        this.writePtr(ev.data.value);
                        this.declareEndOffset(ev);
                        break;
                    }
                    case 'false': {
                        this.writePtr(ev.data.value);
                        this.declareEndOffset(ev);
                        break;
                    }
                    case 'null': {
                        this.writePtr(ev.data.value);
                        this.declareEndOffset(ev);
                        break;
                    }

                    case 'object':
                    case 'array': {
                        this.declareEndOffset(ev);
                    }

                    default: {
                        break;
                    }
                }
                break;
            }
            case 'raw': {
                this.emit('raw', ev.data);
                break;
            }

            default: {
                break;
            }
        }
    }

    setupImmediateRoutine() {
        if (this.immediateHandle) {
            return;
        }

        this.immediateHandle = setImmediate(() => {
            this.immediateHandle = undefined;

            if (this.inFocus && this.accumulated !== undefined && !this.readableEnded && this.wn !== this.ln) {
                this.emit('snapshot', this.accumulated);
                this.push(this.accumulated);
                this.ln = this.wn;
            }

            if (this.lastCallback) {
                this.lastCallback.call(undefined);
                this.lastCallback = undefined;
            }
        });
    }

    override _transform(chunk: any, _encoding: BufferEncoding, callback: (error?: Error, data?: any) => void) {
        this.evRoutine(chunk);

        if (this.lastCallback) {
            this.lastCallback.call(undefined);
        }

        this.lastCallback = callback;

        this.setupImmediateRoutine();
    }

    override _flush(callback: (error?: Error, data?: any) => void) {
        if (this.accumulated !== undefined) {
            this.emit('snapshot', this.accumulated);
            this.push(this.accumulated);
            this.emit('final', this.accumulated);
        }
        this.push(null);
        callback();
    }
}

export class OffsetQueryCompanion {
    constructor(public trie: TrieNode<string, {
        startOffset: number;
        endOffset: number;
        startByteOffset: number;
        endByteOffset: number;
    }>) {

    }

    queryPath(...path: string[]) {
        const [node, remains] = this.trie.seek(...path);

        if (remains.length === 0) {
            return node.payload;
        }

        return undefined;
    }

    query(path: string) {
        return this.queryPath(..._.toPath(path));
    }
}
