import { singleton } from 'tsyringe';
import { AsyncService } from 'civkit/async-service';
import type { Blob } from 'buffer';
import { GlobalLogger } from './logger';

import { readBlob, readFile as readFileText, WEB_SUPPORTED_ENCODINGS } from '../utils/encoding';
import type { PageSnapshot } from './puppeteer';
import { AssertionFailureError, DataStreamBrokenError } from 'civkit/civ-rpc';
import { PDFExtractor } from './pdf-extract';
import { TempFileManager } from './temp-file';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { pathToFileURL } from 'url';
import { SOffice } from './soffice';
import { Threaded } from './threaded';
import { AsyncLocalContext } from './async-context';
import { CanvasService } from './canvas';
import { AltTextService } from './alt-text';
import { stat } from 'fs/promises';
import { JSDomControl } from './jsdom';

@singleton()
export class BinaryExtractorService extends AsyncService {
    logger = this.globalLogger.child({ service: this.constructor.name });

    constructor(
        protected globalLogger: GlobalLogger,
        protected tempFileManager: TempFileManager,
        protected asyncLocalContext: AsyncLocalContext,
        protected pdfExtractor: PDFExtractor,
        protected sOfficeControl: SOffice,
        protected canvasService: CanvasService,
        protected altTextService: AltTextService,
        protected jsdomControl: JSDomControl,
    ) {
        super(...arguments);
    }

    override async init() {
        await this.dependencyReady();

        this.emit('ready');
    }

    async createSnapshotFromBlob(url: URL, blob: Blob, overrideContentType?: string, overrideFileName?: string) {
        if (overrideContentType === 'application/octet-stream') {
            overrideContentType = undefined;
        }

        const contentType: string = (overrideContentType || blob.type).toLowerCase();
        const fileName = overrideFileName || `${url.origin || ''}${url.pathname || '-'}`;
        const urlCopy = new URL(url.href);
        urlCopy.hash = '';

        const snapshot: PageSnapshot = {
            title: '',
            href: urlCopy.href,
            html: '',
            text: '',
            traits: ['blob'],
        };

        // Text-based files
        try {
            let encoding: string | undefined = contentType.includes('charset=') ? contentType.split('charset=')[1]?.trim().toLowerCase().replaceAll(/["';]/gi, '') : 'utf-8';
            if (!WEB_SUPPORTED_ENCODINGS.has(encoding)) {
                encoding = 'utf-8';
            }
            if (!contentType || contentType.startsWith('text/html') || contentType.startsWith('application/xhtml+xml')) {
                if (blob.size > 1024 * 1024 * 32) {
                    throw new AssertionFailureError(`Failed to access ${url}: file too large`);
                }
                snapshot.html = await readBlob(blob, encoding);
                let innerCharset;
                const peek = snapshot.html.slice(0, 1024);
                innerCharset ??= peek.match(/<meta[^>]+text\/html;\s*?charset=([^>"]+)/i)?.[1]?.toLowerCase();
                innerCharset ??= peek.match(/<meta[^>]+charset="([^>"]+)\"/i)?.[1]?.toLowerCase();
                if (innerCharset && innerCharset !== encoding && WEB_SUPPORTED_ENCODINGS.has(innerCharset)) {
                    snapshot.html = await readBlob(blob, innerCharset);
                }

                return snapshot;
            }
            if ((contentType.startsWith('text/') && !contentType.startsWith('text/xml')) || contentType.startsWith('application/json')) {
                if (blob.size > 1024 * 1024 * 32) {
                    throw new AssertionFailureError(`Failed to access ${url}: file too large`);
                }
                snapshot.text = await readBlob(blob, encoding);
                snapshot.html = `<html><head><meta name="color-scheme" content="light dark"></head><body><pre style="word-wrap: break-word; white-space: pre-wrap;">${snapshot.text}</pre></body></html>`;

                return snapshot;
            }
        } catch (err: any) {
            this.logger.warn(`Failed to read from file: ${url}`, { err, url });
            throw new DataStreamBrokenError(`Failed to access ${url}: ${err?.message}`);
        }

        if (blob.size === 0) {
            throw new AssertionFailureError(`Unexpected empty file: ${url}`);
        }

        // Binary files
        const filePath = this.tempFileManager.alloc();
        this.tempFileManager.bindPathTo(this.asyncLocalContext.ctx, filePath);
        await writeFile(filePath, blob.stream() as any, { flush: true });
        const dirPath = this.tempFileManager.alloc();
        this.tempFileManager.bindPathTo(this.asyncLocalContext.ctx, dirPath);
        await mkdir(dirPath);

        const snapshotFromBinary = await this.localFileToSnapshot({
            filePath,
            contentType,
            fileName,
            outPath: dirPath,
            url,
        });

        Object.assign(snapshot, snapshotFromBinary);

        return snapshot;
    }

    argumentContentType(fileName: string, contentType?: string) {
        if (contentType && contentType !== 'application/octet-stream') {
            return contentType;
        }
        const ext = fileName.split('.').pop()?.toLowerCase();
        if (!ext) {
            return 'application/octet-stream';
        }
        switch (ext) {
            case 'html':
            case 'htm':
                return 'text/html';
            case 'json':
                return 'application/json';
            case 'txt':
                return 'text/plain';
            case 'pdf':
                return 'application/pdf';
            case 'doc':
            case 'docx':
                return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
            case 'xls':
            case 'xlsx':
                return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
            case 'ppt':
            case 'pptx':
                return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
            case 'jpg':
            case 'jpeg':
                return 'image/jpeg';
            case 'png':
                return 'image/png';
            case 'gif':
                return 'image/gif';
            case 'bmp':
                return 'image/bmp';
            case 'svg':
                return 'image/svg+xml';
            case 'webp':
                return 'image/webp';
            default:
                return 'application/octet-stream';
        }
    }

    @Threaded()
    async localFileToSnapshot(options: {
        filePath: string;
        contentType: string;
        fileName: string;
        outPath: string;
        url: URL;
    }) {
        const { filePath, contentType: initialContentType, fileName, url, outPath } = options;
        const contentType = this.argumentContentType(fileName, initialContentType);
        const pageNumber = url.hash ? parseInt(url.hash.slice(1), 10) : undefined;
        const urlCopy = new URL(url.href);
        urlCopy.hash = '';
        const snapshot: PageSnapshot = {
            title: '',
            href: url.href,
            html: '',
            text: '',
            traits: ['blob'],
        };

        if (contentType.startsWith('application/pdf')) {
            const pagesToRender = pageNumber ? [pageNumber, pageNumber + 1, pageNumber + 2] : [1, 2, 3];
            const extracted = await this.pdfExtractor.extractRendered(filePath, outPath, pagesToRender);

            snapshot.title = extracted.meta.title || fileName;

            snapshot.text = extracted.text;
            snapshot.parsed = {
                content: extracted.content,
                byline: extracted.meta?.Author,
                lang: extracted.meta?.Language || undefined,
                title: extracted.meta?.Title,
                publishedTime: this.pdfExtractor.parsePdfDate(extracted.meta?.ModDate || extracted.meta?.CreationDate)?.toISOString(),
            };
            snapshot.metadata = extracted.meta;

            snapshot.childFrames = extracted.pages.map((page) => {
                const childUrl = new URL(urlCopy.href);
                childUrl.hash = `#${page.page}`;

                return {
                    title: `${snapshot.title}#${page.page}`,
                    href: childUrl.href,
                    html: '',
                    text: page.text,
                    parsed: {
                        content: page.content,
                    },
                    screenshotUrl: page.pngPath ? pathToFileURL(page.pngPath).href : undefined,
                } as PageSnapshot;
            });
            snapshot.traits!.push('pdf');

            return snapshot;
        }

        if (
            contentType.startsWith('application/msword') ||
            contentType.startsWith('application/vnd.ms-word') ||
            contentType.startsWith('application/vnd.openxmlformats-officedocument.wordprocessingml.document')
        ) {
            const pagesToRender = pageNumber ? [pageNumber, pageNumber + 1, pageNumber + 2] : [1, 2, 3];
            const extracted = await this.sOfficeControl.extractFromWriter(filePath, outPath, { pagesToRender });

            snapshot.title = extracted.meta.title || fileName;
            snapshot.html = extracted.html;
            snapshot.text = extracted.text;
            snapshot.parsed = {
                content: extracted.content,
            };
            snapshot.metadata = extracted.meta;
            snapshot.childFrames = extracted.pages.map((page, idx) => {
                const childUrl = new URL(urlCopy.href);
                childUrl.hash = `#${idx + 1}`;

                return {
                    title: `${snapshot.title}#${idx + 1}`,
                    href: childUrl.href,
                    html: page.html,
                    text: page.text,
                    parsed: {
                        content: page.content,
                    },
                    screenshotUrl: page.pngPath ? pathToFileURL(page.pngPath).href : undefined,
                } as PageSnapshot;
            });
            snapshot.traits!.push('writer');

            return snapshot;
        }

        if (
            contentType.startsWith('application/vnd.ms-excel') ||
            contentType.startsWith('application/ms-excel') ||
            contentType.startsWith('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        ) {
            const pagesToRender = pageNumber ? [pageNumber, pageNumber + 1] : [1];
            const extracted = await this.sOfficeControl.extractFromCalc(filePath, outPath, { pagesToRender });

            snapshot.title = extracted.meta.title || fileName;
            snapshot.html = extracted.html;
            snapshot.text = extracted.text;
            snapshot.parsed = {
                content: extracted.content,
            };
            snapshot.metadata = extracted.meta;
            snapshot.childFrames = extracted.pages.map((page, idx) => {
                const childUrl = new URL(urlCopy.href);
                childUrl.hash = `#${idx + 1}`;

                return {
                    title: `${snapshot.title}#${idx + 1}`,
                    href: childUrl.href,
                    html: page.html,
                    text: page.text,
                    parsed: {
                        content: page.content,
                    },
                    screenshotUrl: page.pngPath ? pathToFileURL(page.pngPath).href : undefined,
                } as PageSnapshot;
            });
            snapshot.traits!.push('calc');

            return snapshot;
        }

        if (
            contentType.startsWith('application/ms-powerpoint') ||
            contentType.startsWith('application/vnd.ms-powerpoint') ||
            contentType.startsWith('application/vnd.openxmlformats-officedocument.presentationml.presentation')
        ) {
            const pagesToRender = pageNumber ? [pageNumber, pageNumber + 1, pageNumber + 2] : [1, 2, 3];
            const extracted = await this.sOfficeControl.extractFromImpress(filePath, outPath, { pagesToRender });

            snapshot.title = extracted.meta.title || fileName;
            snapshot.html = extracted.html;
            snapshot.text = extracted.text;
            snapshot.parsed = {
                content: extracted.content,
            };
            snapshot.metadata = extracted.meta;
            snapshot.childFrames = extracted.pages.map((page, idx) => {
                const childUrl = new URL(urlCopy.href);
                childUrl.hash = `#${idx + 1}`;

                return {
                    title: `${snapshot.title}#${idx + 1}`,
                    href: childUrl.href,
                    html: page.html,
                    text: page.text,
                    parsed: {
                        content: page.content,
                    },
                    screenshotUrl: page.pngPath ? pathToFileURL(page.pngPath).href : undefined,
                } as PageSnapshot;
            });
            snapshot.traits!.push('impress');

            return snapshot;
        }

        if (contentType.startsWith('image/')) {

            snapshot.title = fileName;
            snapshot.imgs = [{ src: url.href }];

            const viewPort = this.asyncLocalContext.get('viewport');

            const img = await this.canvasService.loadImage(await readFile(filePath));
            const resized = this.canvasService.fitImageToBox(img, viewPort?.width || 1024, viewPort?.height || 1024);
            const imageBuff = await this.canvasService.canvasToBuffer(resized);

            // const altText = await this.altTextService.getAltText({
            //     src: url.href,
            //     buff: imageBuff,
            // }, 'jina-vlm');
            const altText = await this.altTextService.vqa(imageBuff, this.asyncLocalContext.get('instruction'), 'jina-vlm');

            snapshot.text = altText || '';
            snapshot.parsed = {
                content: altText || '',
                textContent: altText || '',
            };
            snapshot.screenshot = imageBuff;
            snapshot.html = `<html style="height: 100%;"><head><meta name="viewport" content="width=device-width, minimum-scale=0.1"><title>${fileName}</title></head><body style="margin: 0px; height: 100%; background-color: rgb(14, 14, 14);"><p>${altText}</p></body></html>`;

            snapshot.traits!.push('image');

            return snapshot;
        }

        if (contentType.startsWith('text/xml') || contentType.startsWith('application/xml') || contentType.includes('+xml')) {
            const fileSize = await stat(filePath).then((stat) => stat.size);
            if (fileSize > 1024 * 1024 * 32) {
                throw new AssertionFailureError(`Failed to access ${url}: file too large`);
            }
            const encoding = contentType.includes('charset=') ? contentType.split('charset=')[1]?.trim().toLowerCase().replaceAll(/["';]/gi, '') : 'utf-8';
            const xmlText = await readFileText(filePath, encoding);

            const snapshot = await this.jsdomControl.xmlTextToSnapshot(xmlText, url);

            return snapshot;
        }

        throw new AssertionFailureError(`Failed to interpret ${url}: unexpected content type ${contentType}`);
    }
}