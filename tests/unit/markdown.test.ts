/**
 * Unit tests for the tidyMarkdown utility.
 * These tests exercise the pure function directly with no server or network.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { tidyMarkdown } from '../../build/utils/markdown.js';

describe('tidyMarkdown – link normalisation', () => {
    it('collapses whitespace inside link text', () => {
        const input = '[ hello   world ](https://example.com)';
        const result = tidyMarkdown(input);
        assert.strictEqual(result, '[hello world](https://example.com)');
    });

    it('removes whitespace from link URLs', () => {
        const input = '[text]( https://example.com/path )';
        const result = tidyMarkdown(input);
        assert.strictEqual(result, '[text](https://example.com/path)');
    });

    it('repairs a link broken across two lines', () => {
        const input = '[link\ntext](https://example.com)';
        const result = tidyMarkdown(input);
        assert.match(result, /\[link text\]\(https:\/\/example\.com\)/);
    });

    it('normalises link with embedded image', () => {
        const input = '[ caption\n![alt](https://img.example.com/x.png)\n](https://example.com/page)';
        const result = tidyMarkdown(input);
        assert.match(result, /\[caption !\[alt\]\(https:\/\/img\.example\.com\/x\.png\)\]\(https:\/\/example\.com\/page\)/);
    });
});

describe('tidyMarkdown – blank-line normalisation', () => {
    it('replaces 3+ consecutive blank lines with exactly 2', () => {
        const input = 'line one\n\n\n\nline two';
        const result = tidyMarkdown(input);
        assert.strictEqual(result, 'line one\n\nline two');
    });

    it('leaves exactly 2 blank lines unchanged', () => {
        const input = 'line one\n\nline two';
        const result = tidyMarkdown(input);
        assert.strictEqual(result, 'line one\n\nline two');
    });

    it('does not introduce extra blank lines when none are present', () => {
        const input = 'line one\nline two';
        const result = tidyMarkdown(input);
        assert.strictEqual(result, 'line one\nline two');
    });
});

describe('tidyMarkdown – leading whitespace removal', () => {
    it('strips leading spaces from every line', () => {
        const input = '    # Heading\n    paragraph text';
        const result = tidyMarkdown(input);
        assert.strictEqual(result, '# Heading\nparagraph text');
    });

    it('strips leading tabs from every line', () => {
        const input = '\t\tindented line';
        const result = tidyMarkdown(input);
        assert.strictEqual(result, 'indented line');
    });
});

describe('tidyMarkdown – trimming', () => {
    it('trims leading and trailing whitespace from the whole string', () => {
        const input = '\n\n  hello  \n\n';
        const result = tidyMarkdown(input);
        assert.strictEqual(result, 'hello');
    });

    it('returns an empty string for whitespace-only input', () => {
        const result = tidyMarkdown('   \n\n\t  ');
        assert.strictEqual(result, '');
    });
});

describe('tidyMarkdown – passthrough cases', () => {
    it('leaves plain text with no markdown syntax untouched (apart from trimming)', () => {
        const input = 'Hello world';
        assert.strictEqual(tidyMarkdown(input), 'Hello world');
    });

    it('does not alter already-clean links', () => {
        const input = '[text](https://example.com)';
        assert.strictEqual(tidyMarkdown(input), '[text](https://example.com)');
    });

    it('does not alter inline code', () => {
        const input = 'Use `npm install` to install';
        assert.strictEqual(tidyMarkdown(input), 'Use `npm install` to install');
    });
});
