/**
 * Unit tests for PseudoBoolean.from().
 * No server or network required.
 */
import 'reflect-metadata';
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { PseudoBoolean } from '../../build/lib/pseudo-boolean.js';

describe('PseudoBoolean.from – null/undefined', () => {
    it('returns false for undefined', () => {
        assert.strictEqual(PseudoBoolean.from(undefined), false);
    });

    it('returns false for null', () => {
        assert.strictEqual(PseudoBoolean.from(null), false);
    });
});

describe('PseudoBoolean.from – native booleans', () => {
    it('returns true for true', () => {
        assert.strictEqual(PseudoBoolean.from(true), true);
    });

    it('returns false for false', () => {
        assert.strictEqual(PseudoBoolean.from(false), false);
    });
});

describe('PseudoBoolean.from – falsy strings', () => {
    it('returns false for empty string ""', () => {
        assert.strictEqual(PseudoBoolean.from(''), false);
    });

    it('returns false for "false"', () => {
        assert.strictEqual(PseudoBoolean.from('false'), false);
    });

    it('returns false for "FALSE" (case-insensitive)', () => {
        assert.strictEqual(PseudoBoolean.from('FALSE'), false);
    });

    it('returns false for "none"', () => {
        assert.strictEqual(PseudoBoolean.from('none'), false);
    });

    it('returns false for "null"', () => {
        assert.strictEqual(PseudoBoolean.from('null'), false);
    });

    it('returns false for "nan"', () => {
        assert.strictEqual(PseudoBoolean.from('nan'), false);
    });

    it('returns false for "nil"', () => {
        assert.strictEqual(PseudoBoolean.from('nil'), false);
    });

    it('returns false for "0"', () => {
        assert.strictEqual(PseudoBoolean.from('0'), false);
    });

    it('returns false for "no"', () => {
        assert.strictEqual(PseudoBoolean.from('no'), false);
    });

    it('returns false for "undefined"', () => {
        assert.strictEqual(PseudoBoolean.from('undefined'), false);
    });

    it('ignores leading/trailing whitespace when checking falsy strings', () => {
        assert.strictEqual(PseudoBoolean.from('  false  '), false);
        assert.strictEqual(PseudoBoolean.from('  0  '), false);
    });
});

describe('PseudoBoolean.from – truthy strings', () => {
    it('returns true for "true"', () => {
        assert.strictEqual(PseudoBoolean.from('true'), true);
    });

    it('returns true for "TRUE" (case-insensitive)', () => {
        assert.strictEqual(PseudoBoolean.from('TRUE'), true);
    });

    it('returns true for "yes"', () => {
        assert.strictEqual(PseudoBoolean.from('yes'), true);
    });

    it('returns true for "1"', () => {
        assert.strictEqual(PseudoBoolean.from('1'), true);
    });

    it('returns true for "ok"', () => {
        assert.strictEqual(PseudoBoolean.from('ok'), true);
    });

    it('returns true for any other non-empty string', () => {
        assert.strictEqual(PseudoBoolean.from('random text'), true);
        assert.strictEqual(PseudoBoolean.from('enabled'), true);
    });
});

describe('PseudoBoolean.from – unsupported types', () => {
    it('throws TypeError for a number input', () => {
        assert.throws(() => PseudoBoolean.from(42), TypeError);
    });

    it('throws TypeError for an object input', () => {
        assert.throws(() => PseudoBoolean.from({}), TypeError);
    });

    it('throws TypeError for an array input', () => {
        assert.throws(() => PseudoBoolean.from([]), TypeError);
    });
});
