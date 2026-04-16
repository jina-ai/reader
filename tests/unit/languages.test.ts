/**
 * Unit tests for the bcp47ToIso639_3 language-tag utility.
 * No server or network required.
 */
import 'reflect-metadata';
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { bcp47ToIso639_3 } from '../../build/utils/languages.js';

describe('bcp47ToIso639_3 – well-known tags', () => {
    it('maps "en" to "eng"', () => {
        assert.strictEqual(bcp47ToIso639_3('en'), 'eng');
    });

    it('maps "en-US" to "eng"', () => {
        assert.strictEqual(bcp47ToIso639_3('en-US'), 'eng');
    });

    it('maps "en-GB" to "eng"', () => {
        assert.strictEqual(bcp47ToIso639_3('en-GB'), 'eng');
    });

    it('maps "zh" to "cmn"', () => {
        assert.strictEqual(bcp47ToIso639_3('zh'), 'cmn');
    });

    it('maps "zh-CN" to "cmn"', () => {
        assert.strictEqual(bcp47ToIso639_3('zh-CN'), 'cmn');
    });

    it('maps "zh-TW" to "cmn"', () => {
        assert.strictEqual(bcp47ToIso639_3('zh-TW'), 'cmn');
    });

    it('maps "ja" to "jpn"', () => {
        assert.strictEqual(bcp47ToIso639_3('ja'), 'jpn');
    });

    it('maps "ko" to "kor"', () => {
        assert.strictEqual(bcp47ToIso639_3('ko'), 'kor');
    });

    it('maps "ar" to "ara"', () => {
        assert.strictEqual(bcp47ToIso639_3('ar'), 'ara');
    });

    it('maps "fr" to "fra"', () => {
        assert.strictEqual(bcp47ToIso639_3('fr'), 'fra');
    });

    it('maps "de" to "deu"', () => {
        assert.strictEqual(bcp47ToIso639_3('de'), 'deu');
    });

    it('maps "es" to "spa"', () => {
        assert.strictEqual(bcp47ToIso639_3('es'), 'spa');
    });

    it('maps "ru" to "rus"', () => {
        assert.strictEqual(bcp47ToIso639_3('ru'), 'rus');
    });

    it('maps "pt" to "por"', () => {
        assert.strictEqual(bcp47ToIso639_3('pt'), 'por');
    });

    it('maps "hi" to "hin"', () => {
        assert.strictEqual(bcp47ToIso639_3('hi'), 'hin');
    });
});

describe('bcp47ToIso639_3 – regional variants', () => {
    it('maps "fr-CA" to "fra"', () => {
        assert.strictEqual(bcp47ToIso639_3('fr-CA'), 'fra');
    });

    it('maps "pt-BR" to "por"', () => {
        assert.strictEqual(bcp47ToIso639_3('pt-BR'), 'por');
    });

    it('maps "es-MX" to "spa"', () => {
        assert.strictEqual(bcp47ToIso639_3('es-MX'), 'spa');
    });

    it('maps "zh-yue" to "yue"', () => {
        assert.strictEqual(bcp47ToIso639_3('zh-yue'), 'yue');
    });
});

describe('bcp47ToIso639_3 – case insensitivity', () => {
    it('accepts lowercase "en-us"', () => {
        assert.strictEqual(bcp47ToIso639_3('en-us'), 'eng');
    });

    it('accepts lowercase "zh-cn"', () => {
        assert.strictEqual(bcp47ToIso639_3('zh-cn'), 'cmn');
    });

    it('accepts lowercase "fr-ca"', () => {
        assert.strictEqual(bcp47ToIso639_3('fr-ca'), 'fra');
    });
});

describe('bcp47ToIso639_3 – unknown / absent tags', () => {
    it('returns "und" for an unknown tag', () => {
        assert.strictEqual(bcp47ToIso639_3('xx-UNKNOWN'), 'und');
    });

    it('returns "und" for an empty string', () => {
        assert.strictEqual(bcp47ToIso639_3(''), 'und');
    });

    it('returns "und" when called with no argument', () => {
        assert.strictEqual(bcp47ToIso639_3(), 'und');
    });

    it('returns "und" for a numeric-looking string', () => {
        assert.strictEqual(bcp47ToIso639_3('123'), 'und');
    });
});
