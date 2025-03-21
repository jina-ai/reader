import { singleton, container } from 'tsyringe';
import { AsyncService, mimeOf, ParamValidationError, SubmittedDataMalformedError, /* downloadFile */ } from 'civkit';
import { readFile } from 'fs/promises';

import type canvas from '@napi-rs/canvas';
export type { Canvas, Image } from '@napi-rs/canvas';

import { GlobalLogger } from './logger';
import { TempFileManager } from './temp-file';

import { isMainThread } from 'worker_threads';
import type { svg2png } from 'svg2png-wasm' with { 'resolution-mode': 'import' };
import path from 'path';
import { Threaded } from './threaded';

const downloadFile = async (uri: string) => {
    const resp = await fetch(uri);
    if (!(resp.ok && resp.body)) {
        throw new Error(`Unexpected response ${resp.statusText}`);
    }
    const contentLength = parseInt(resp.headers.get('content-length') || '0');
    if (contentLength > 1024 * 1024 * 100) {
        throw new Error('File too large');
    }
    const buff = await resp.arrayBuffer();

    return { buff, contentType: resp.headers.get('content-type') };
};

@singleton()
export class CanvasService extends AsyncService {

    logger = this.globalLogger.child({ service: this.constructor.name });
    svg2png!: typeof svg2png;
    canvas!: typeof canvas;

    constructor(
        protected temp: TempFileManager,
        protected globalLogger: GlobalLogger,
    ) {
        super(...arguments);
    }

    override async init() {
        await this.dependencyReady();
        if (!isMainThread) {
            const { createSvg2png, initialize } = require('svg2png-wasm');
            const wasmBuff = await readFile(path.resolve(path.dirname(require.resolve('svg2png-wasm')), '../svg2png_wasm_bg.wasm'));
            const fontBuff = await readFile(path.resolve(__dirname, '../../licensed/SourceHanSansSC-Regular.otf'));
            await initialize(wasmBuff);
            this.svg2png = createSvg2png({
                fonts: [Uint8Array.from(fontBuff)],
                defaultFontFamily: {
                    serifFamily: 'Source Han Sans SC',
                    sansSerifFamily: 'Source Han Sans SC',
                    cursiveFamily: 'Source Han Sans SC',
                    fantasyFamily: 'Source Han Sans SC',
                    monospaceFamily: 'Source Han Sans SC',
                }
            });
        }
        this.canvas = require('@napi-rs/canvas');

        this.emit('ready');
    }

    @Threaded()
    async renderSvgToPng(svgContent: string,) {
        return this.svg2png(svgContent, { backgroundColor: '#D3D3D3' });
    }

    protected async _loadImage(input: string | Buffer) {
        let buff;
        let contentType;
        do {
            if (typeof input === 'string') {
                if (input.startsWith('data:')) {
                    const firstComma = input.indexOf(',');
                    const header = input.slice(0, firstComma);
                    const data = input.slice(firstComma + 1);
                    const encoding = header.split(';')[1];
                    contentType = header.split(';')[0].split(':')[1];
                    if (encoding?.startsWith('base64')) {
                        buff = Buffer.from(data, 'base64');
                    } else {
                        buff = Buffer.from(decodeURIComponent(data), 'utf-8');
                    }
                    break;
                }
                if (input.startsWith('http')) {
                    const r = await downloadFile(input);
                    buff = Buffer.from(r.buff);
                    contentType = r.contentType;
                    break;
                }
            }
            if (Buffer.isBuffer(input)) {
                buff = input;
                const mime = await mimeOf(buff);
                contentType = `${mime.mediaType}/${mime.subType}`;
                break;
            }
            throw new ParamValidationError('Invalid input');
        } while (false);

        if (!buff) {
            throw new ParamValidationError('Invalid input');
        }

        if (contentType?.includes('svg')) {
            buff = await this.renderSvgToPng(buff.toString('utf-8'));
        }

        const img = await this.canvas.loadImage(buff);
        Reflect.set(img, 'contentType', contentType);

        return img;
    }

    async loadImage(uri: string | Buffer) {
        const t0 = Date.now();
        try {
            const theImage = await this._loadImage(uri);
            const t1 = Date.now();
            this.logger.debug(`Image loaded in ${t1 - t0}ms`);

            return theImage;
        } catch (err: any) {
            if (err?.message?.includes('Unsupported image type') || err?.message?.includes('unsupported')) {
                this.logger.warn(`Failed to load image ${uri.slice(0, 128)}`, { err });
                throw new SubmittedDataMalformedError(`Unknown image format for ${uri.slice(0, 128)}`);
            }
            throw err;
        }
    }

    fitImageToSquareBox(image: canvas.Image | canvas.Canvas, size: number = 1024) {
        // this.logger.debug(`Fitting image(${ image.width }x${ image.height }) to ${ size } box`);
        // const t0 = Date.now();
        if (image.width <= size && image.height <= size) {
            if (image instanceof this.canvas.Canvas) {
                return image;
            }
            const canvasInstance = this.canvas.createCanvas(image.width, image.height);
            const ctx = canvasInstance.getContext('2d');
            ctx.drawImage(image, 0, 0, image.width, image.height, 0, 0, canvasInstance.width, canvasInstance.height);
            // this.logger.debug(`No need to resize, copied to canvas in ${ Date.now() - t0 } ms`);

            return canvasInstance;
        }

        const aspectRatio = image.width / image.height;

        const resizedWidth = Math.round(aspectRatio > 1 ? size : size * aspectRatio);
        const resizedHeight = Math.round(aspectRatio > 1 ? size / aspectRatio : size);

        const canvasInstance = this.canvas.createCanvas(resizedWidth, resizedHeight);
        const ctx = canvasInstance.getContext('2d');
        ctx.drawImage(image, 0, 0, image.width, image.height, 0, 0, resizedWidth, resizedHeight);
        // this.logger.debug(`Resized to ${ resizedWidth }x${ resizedHeight } in ${ Date.now() - t0 } ms`);

        return canvasInstance;
    }

    corpImage(image: canvas.Image | canvas.Canvas, x: number, y: number, w: number, h: number) {
        // this.logger.debug(`Cropping image(${ image.width }x${ image.height }) to ${ w }x${ h } at ${ x },${ y } `);
        // const t0 = Date.now();
        const canvasInstance = this.canvas.createCanvas(w, h);
        const ctx = canvasInstance.getContext('2d');
        ctx.drawImage(image, x, y, w, h, 0, 0, w, h);
        // this.logger.debug(`Crop complete in ${ Date.now() - t0 } ms`);

        return canvasInstance;
    }

    canvasToDataUrl(canvas: canvas.Canvas, mimeType?: 'image/png' | 'image/jpeg') {
        // this.logger.debug(`Exporting canvas(${ canvas.width }x${ canvas.height })`);
        // const t0 = Date.now();
        return canvas.toDataURLAsync((mimeType || 'image/png') as 'image/png');
    }

    async canvasToBuffer(canvas: canvas.Canvas, mimeType?: 'image/png' | 'image/jpeg') {
        // this.logger.debug(`Exporting canvas(${ canvas.width }x${ canvas.height })`);
        // const t0 = Date.now();
        return canvas.toBuffer((mimeType || 'image/png') as 'image/png');
    }

}

const instance = container.resolve(CanvasService);
export default instance;
