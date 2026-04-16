import { AutoConstructor } from 'civkit/civ-rpc';

export class PseudoBoolean {
    @AutoConstructor
    static from(input: any) {
        if (input === undefined || input === null) {
            return false;
        }

        if (typeof input === 'boolean') {
            return input;
        }

        if (typeof input === 'string') {
            if (['', 'false', 'none', 'null', 'nan', 'nil', '0', 'no', 'undefined'].includes(input.toLowerCase().trim())) {
                return false;
            }

            if (['true', 'yes', '1', 'ok'].includes(input.toLowerCase().trim())) {
                return true;
            }

            return true;
        }

        throw new TypeError(`Cannot convert ${input} to boolean`);
    }
}
