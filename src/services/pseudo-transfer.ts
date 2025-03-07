import { marshalErrorLike } from 'civkit';
import { AbstractPseudoTransfer, SYM_PSEUDO_TRANSFERABLE } from 'civkit/pseudo-transfer';
import { container, singleton } from 'tsyringe';


@singleton()
export class PseudoTransfer extends AbstractPseudoTransfer {

    override async init() {
        await this.dependencyReady();
        this.emit('ready');
    }

}

const instance = container.resolve(PseudoTransfer);

Object.defineProperty(Error.prototype, SYM_PSEUDO_TRANSFERABLE, {
    value: function () {
        const prototype = this;
        return {
            copyOwnProperty: 'all',
            marshall: (input: Error) => marshalErrorLike(input),
            unMarshall: (input: object) => {
                Object.setPrototypeOf(input, prototype);
                return input;
            },
        };
    },
    enumerable: false,
});
instance.expectPseudoTransferableType(Error);
for (const x of [...Object.values(require('./errors')), ...Object.values(require('civkit/civ-rpc'))]) {
    if (typeof x === 'function' && x.prototype instanceof Error) {
        instance.expectPseudoTransferableType(x as any);
    }
}


Object.defineProperty(URL.prototype, SYM_PSEUDO_TRANSFERABLE, {
    value: function () {
        return {
            copyOwnProperty: 'none',
            marshall: (input: URL) => ({ href: input.href }),
            unMarshall: (input: { href: string; }) => new URL(input.href),
        };
    },
    enumerable: false,
});
instance.expectPseudoTransferableType(URL);

Object.defineProperty(Buffer.prototype, SYM_PSEUDO_TRANSFERABLE, {
    value: function () {
        return {
            copyOwnProperty: 'none',
            unMarshall: (input: Uint8Array | Buffer) => Buffer.isBuffer(input) ? input : Buffer.from(input),
            marshall: (input: Uint8Array | Buffer) => input,
        };
    },
    enumerable: false,
});
instance.expectPseudoTransferableType(Buffer);


export default instance;
