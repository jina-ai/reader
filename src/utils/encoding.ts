import { createReadStream } from 'fs';
import { Readable } from 'stream';

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