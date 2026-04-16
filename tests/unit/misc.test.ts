/**
 * Unit tests for miscellaneous utility functions.
 * No server or network required.
 */
import 'reflect-metadata';
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { cleanAttribute, tryDecodeURIComponent, isScalarLike } from '../../build/utils/misc.js';

// ── cleanAttribute ────────────────────────────────────────────────────────────

describe('cleanAttribute', () => {
    it('returns an empty string for null', () => {
        assert.strictEqual(cleanAttribute(null), '');
    });

    it('returns an empty string for an empty string', () => {
        assert.strictEqual(cleanAttribute(''), '');
    });

    it('returns the original value when no newlines are present', () => {
        assert.strictEqual(cleanAttribute('hello world'), 'hello world');
    });

    it('collapses multiple consecutive newlines into one', () => {
        const result = cleanAttribute('line1\n\n\nline2');
        assert.strictEqual(result, 'line1\nline2');
    });

    it('collapses newlines with surrounding spaces into a single newline', () => {
        const result = cleanAttribute('line1\n   \n  line2');
        assert.strictEqual(result, 'line1\nline2');
    });

    it('preserves a single newline', () => {
        assert.strictEqual(cleanAttribute('a\nb'), 'a\nb');
    });
});

// ── tryDecodeURIComponent ─────────────────────────────────────────────────────

describe('tryDecodeURIComponent', () => {
    it('decodes a percent-encoded string', () => {
        assert.strictEqual(tryDecodeURIComponent('hello%20world'), 'hello world');
    });

    it('returns the input unchanged when there is nothing to decode', () => {
        assert.strictEqual(tryDecodeURIComponent('hello'), 'hello');
    });

    it('decodes special characters like %2F', () => {
        assert.strictEqual(tryDecodeURIComponent('path%2Fto%2Fresource'), 'path/to/resource');
    });

    it('decodes unicode sequences', () => {
        assert.strictEqual(tryDecodeURIComponent('%E4%B8%AD%E6%96%87'), '中文');
    });

    it('throws ParamValidationError for a truly invalid URI component', () => {
        // An invalid percent encoding inside a string that is also not a parseable URL throws.
        // 'http://[invalid%ZZ' fails URL.canParse because the bracket is unclosed,
        // so the error is rethrown as ParamValidationError.
        assert.throws(() => tryDecodeURIComponent('http://[invalid%ZZ'), /Invalid URIComponent/);
    });

    it('returns the raw input unchanged when the invalid sequence parses as a URL', () => {
        // '%' on its own is accepted by URL.canParse as a relative URL path,
        // so it is returned as-is rather than throwing
        assert.strictEqual(tryDecodeURIComponent('%'), '%');
    });

    it('returns the raw URL-looking input unchanged when it cannot be decoded', () => {
        // A full URL with an invalid percent sequence is returned as-is
        const input = 'https://example.com/%ZZ';
        assert.strictEqual(tryDecodeURIComponent(input), input);
    });
});

// ── isScalarLike ──────────────────────────────────────────────────────────────

describe('isScalarLike – primitive values', () => {
    it('returns true for a string primitive', () => {
        assert.strictEqual(isScalarLike('hello'), true);
    });

    it('returns true for a number primitive', () => {
        assert.strictEqual(isScalarLike(42), true);
    });

    it('returns true for a boolean primitive', () => {
        assert.strictEqual(isScalarLike(true), true);
    });

    it('returns true for a bigint primitive', () => {
        assert.strictEqual(isScalarLike(9007199254740993n), true);
    });
});

describe('isScalarLike – boxed/wrapper objects', () => {
    it('returns true for a String object', () => {
        // eslint-disable-next-line no-new-wrappers
        assert.strictEqual(isScalarLike(new String('hi')), true);
    });

    it('returns true for a Number object', () => {
        // eslint-disable-next-line no-new-wrappers
        assert.strictEqual(isScalarLike(new Number(1)), true);
    });

    it('returns true for a Boolean object', () => {
        // eslint-disable-next-line no-new-wrappers
        assert.strictEqual(isScalarLike(new Boolean(false)), true);
    });
});

describe('isScalarLike – non-scalar values', () => {
    it('returns false for a plain object', () => {
        assert.strictEqual(isScalarLike({}), false);
    });

    it('returns false for an array', () => {
        assert.strictEqual(isScalarLike([]), false);
    });

    it('returns false for a function', () => {
        assert.strictEqual(isScalarLike(() => {}), false);
    });

    it('returns false for null', () => {
        assert.strictEqual(isScalarLike(null), false);
    });

    it('returns false for undefined', () => {
        assert.strictEqual(isScalarLike(undefined), false);
    });

    it('returns false for a Date object', () => {
        assert.strictEqual(isScalarLike(new Date()), false);
    });

    it('returns false for a Map', () => {
        assert.strictEqual(isScalarLike(new Map()), false);
    });
});
