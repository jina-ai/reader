import { createReadStream } from 'fs';
import { Readable } from 'stream';
import type { Blob } from 'buffer';
import { TextDecoderStream } from 'stream/web';
import type { ReadableStream } from 'stream/web';

export const WEB_SUPPORTED_ENCODINGS = new Set([,
    "unicode-1-1-utf-8", "utf-8", "utf8", "866", "cp866", "csibm866", "ibm866", "csisolatin2", "iso-8859-2", "iso-ir-101", "iso8859-2", "iso88592", "iso_8859-2", "iso_8859-2:1987", "l2", "latin2", "csisolatin3", "iso-8859-3", "iso-ir-109", "iso8859-3", "iso88593", "iso_8859-3", "iso_8859-3:1988", "l3", "latin3", "csisolatin4", "iso-8859-4", "iso-ir-110", "iso8859-4", "iso88594", "iso_8859-4", "iso_8859-4:1988", "l4", "latin4", "csisolatincyrillic", "cyrillic", "iso-8859-5", "iso-ir-144", "iso88595", "iso_8859-5", "iso_8859-5:1988", "arabic", "asmo-708", "csiso88596e", "csiso88596i", "csisolatinarabic", "ecma-114", "iso-8859-6", "iso-8859-6-e", "iso-8859-6-i", "iso-ir-127", "iso8859-6", "iso88596", "iso_8859-6", , "iso_8859-6:1987", "csisolatingreek", "ecma-118", "elot_928", "greek", "greek8", "iso-8859-7", "iso-ir-126", "iso8859-7", "iso88597", "iso_8859-7", "iso_8859-7:1987", "sun_eu_greek", "csiso88598e", "csisolatinhebrew", "hebrew", "iso-8859-8", "iso-8859-8-e", "iso-ir-138", "iso8859-8", "iso88598", "iso_8859-8", "iso_8859-8:1988", "visual", "csiso88598i", "iso-8859-8-i", "logical", "csisolatin6", "iso-8859-10", "iso-ir-157", "iso8859-10", "iso885910", "l6", "latin6", "iso-8859-13", "iso8859-13", "iso885913", "iso-8859-14", "iso8859-14", "iso885914", "csisolatin9", "iso-8859-15", "iso8859-15", "iso885915", "l9", "latin9", "iso-8859-16", "cskoi8r", "koi", "koi8", "koi8-r", "koi8_r", "koi8-u", "csmacintosh", "mac", "macintosh", "x-mac-roman", "dos-874", "iso-8859-11", "iso8859-11", "iso885911", "tis-620", "windows-874", "cp1250", "windows-1250", "x-cp1250", "cp1251", "windows-1251", "x-cp1251", "ansi_x3.4-1968", "ascii", "cp1252", "cp819", "csisolatin1", "ibm819", "iso-8859-1", "iso-ir-100", "iso8859-1", "iso88591", "iso_8859-1", "iso_8859-1:1987", "l1", "latin1", "us-ascii", "windows-1252", "x-cp1252", "cp1253", "windows-1253", "x-cp1253", "cp1254", "csisolatin5", "iso-8859-9", "iso-ir-148", "iso8859-9", "iso88599", "iso_8859-9", "iso_8859-9:1989", "l5", "latin5", "windows-1254", "x-cp1254", "cp1255", "windows-1255", "x-cp1255", "cp1256", "windows-1256", "x-cp1256", "cp1257", "windows-1257", "x-cp1257", "cp1258", "windows-1258", "x-cp1258", "x-mac-cyrillic", "x-mac-ukrainian", "chinese", "csgb2312", "csiso58gb231280", "gb2312", "gb_2312", "gb_2312-80", "gbk", "iso-ir-58", "x-gbk", "gb18030", "hz-gb-2312", "big5", "big5-hkscs", "cn-big5", "csbig5", "x-x-big5", "cseucpkdfmtjapanese", "euc-jp", "x-euc-jp", "csiso2022jp", "iso-2022-jp", "csshiftjis", "ms_kanji", "shift-jis", "shift_jis", "sjis", "windows-31j", "x-sjis", "cseuckr", "csksc56011987", "euc-kr", "iso-ir-149", "korean", "ks_c_5601-1987", "ks_c_5601-1989", "ksc5601", "ksc_5601", "windows-949", "csiso2022kr", "iso-2022-kr", "utf-16be", "utf-16", "utf-16le", "x-user-defined", "iso-2022-cn", "iso-2022-cn-ext"
]);

export async function decodeFileStream(
    fileStream: Readable,
    encoding: string = 'utf-8',
): Promise<string> {
    const decodeStream = new TextDecoderStream(encoding, { fatal: false, ignoreBOM: false });
    (Readable.toWeb(fileStream) as ReadableStream).pipeThrough(decodeStream);
    const chunks = [];

    for await (const chunk of decodeStream.readable) {
        chunks.push(chunk);
    }

    return chunks.join('');
}


export async function readFile(
    filePath: string,
    encoding: string = 'utf-8',
): Promise<string> {
    const decodeStream = new TextDecoderStream(encoding, { fatal: false, ignoreBOM: false });
    (Readable.toWeb(createReadStream(filePath)) as ReadableStream).pipeThrough(decodeStream);
    const chunks = [];

    for await (const chunk of decodeStream.readable) {
        chunks.push(chunk);
    }

    return chunks.join('');
}

export async function readBlob(
    blob: Blob,
    encoding: string = 'utf-8',
): Promise<string> {
    const decodeStream = new TextDecoderStream(encoding, { fatal: false, ignoreBOM: false });
    blob.stream().pipeThrough(decodeStream);
    const chunks = [];

    for await (const chunk of decodeStream.readable) {
        chunks.push(chunk);
    }

    return chunks.join('');
}