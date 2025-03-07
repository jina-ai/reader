declare module 'langdetect' {
    interface DetectionResult {
        lang: string;
        prob: number;
    }

    export function detect(text: string): DetectionResult[];
    export function detectOne(text: string): string | null;
}

declare module 'jsdom' {
    import EventEmitter from 'events';
    export class JSDOM {
        constructor(html: string, options?: any);
        window: typeof window;
    }
    export class VirtualConsole extends EventEmitter {
        constructor();
        sendTo(console: any, options?: any);
    }
}

declare module 'simple-zstd' {
    import { Duplex } from 'stream';
    export function ZSTDCompress(lvl: Number): Duplex;
    export function ZSTDDecompress(): Duplex;
    export function ZSTDDecompressMaybe(): Duplex;
}
