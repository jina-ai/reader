import { createReadStream } from 'fs';
import { Readable } from 'stream';
import { TextDecoderStream } from 'stream/web';

export async function decodeFileStream(
    fileStream: Readable,
    encoding: string = 'utf-8',
): Promise<string> {
    const decodeStream = new TextDecoderStream(encoding, { fatal: false, ignoreBOM: false });
    Readable.toWeb(fileStream).pipeThrough(decodeStream);
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
    Readable.toWeb(createReadStream(filePath)).pipeThrough(decodeStream);
    const chunks = [];

    for await (const chunk of decodeStream.readable) {
        chunks.push(chunk);
    }

    return chunks.join('');
}