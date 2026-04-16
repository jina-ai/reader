import { spawn, SpawnOptionsWithoutStdio } from 'child_process';
import { singleton } from 'tsyringe';
import { AsyncService } from 'civkit/async-service';
import { GlobalLogger } from './logger';
import { DownstreamServiceFailureError } from 'civkit/civ-rpc';
import { isMainThread } from 'worker_threads';
import { AsyncLocalContext } from './async-context';
import { readdir, readFile } from 'fs/promises';
import path from 'path';
import { PDFExtractor } from './pdf-extract';
import { JSDomControl } from './jsdom';

@singleton()
export class SOffice extends AsyncService {

    logger = this.globalLogger.child({ service: 'SOffice' });

    constructor(
        protected globalLogger: GlobalLogger,
        protected asyncLocalContext: AsyncLocalContext,
        protected pdfExtractor: PDFExtractor,
        protected jsdomControl: JSDomControl,
    ) {
        super(...arguments);
    }

    override async init() {
        await this.dependencyReady();

        if (isMainThread) {
            this.emit('ready');
            return;
        }

        this.emit('ready');
    }

    supports(mimeType: string) {
        const supportedTypes: string[] = [
            'application/msword',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'application/vnd.ms-excel',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'application/vnd.ms-powerpoint',
            'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        ];

        return supportedTypes.includes(mimeType.toLowerCase());
    }

    runSOffice(args: string[], options?: SpawnOptionsWithoutStdio) {
        const sofficeProcess = spawn('soffice', ['soffice', '--headless', ...args], options);

        sofficeProcess.stderr?.on('data',
            this.asyncLocalContext.bridged(
                (data: Buffer) => {
                    this.logger.warn(`soffice stderr: ${data.toString('utf-8')}`);
                }
            )
        );
        sofficeProcess.stdout?.on('data',
            this.asyncLocalContext.bridged(
                (data: Buffer) => {
                    this.logger.debug(`soffice stdout: ${data.toString('utf-8')}`);
                }
            )
        );

        return new Promise<void>((resolve, reject) => {
            sofficeProcess.once('error',
                this.asyncLocalContext.bridged(
                    (err: Error) => {
                        this.logger.error('soffice process error', { err });
                        reject(err);
                    }
                )
            );
            sofficeProcess.once('exit',
                this.asyncLocalContext.bridged(
                    (code: number | null, signal: string | null) => {
                        if (code === 0) {
                            resolve();
                            return;
                        }

                        if (code !== null) {
                            const err = new DownstreamServiceFailureError(`soffice process exited with code ${code}`);
                            this.logger.error('soffice process exited with error', { code });
                            reject(err);
                            return;
                        }

                        const err = new DownstreamServiceFailureError(`soffice process was killed by signal ${signal}`);
                        this.logger.error('soffice process killed by signal', { signal });
                        reject(err);
                    }
                )
            );
        });
    }

    async extractFromCalc(inputFilePath: string, outputDirPath: string,
        options?: {
            spawnOptions?: SpawnOptionsWithoutStdio;
            pagesToRender?: number[] | Set<number>;
        }
    ) {
        try {
            await this.runSOffice(['--convert-to', 'html', '--outdir', outputDirPath, inputFilePath], options?.spawnOptions).catch((err) => {
                this.logger.warn(`First attempt to convert calc to snapshot failed, retrying xhtml approach...`, { err });
                return this.runSOffice(['--convert-to', 'xhtml', '--outdir', outputDirPath, inputFilePath], options?.spawnOptions);
            });

            // await this.runSOffice(['--convert-to', 'xhtml:XHTML Calc File', '--outdir', outputDirPath, inputFilePath], options);
        } catch (err) {
            this.logger.warn(`Failed to convert calc to html`, { err, inputFilePath, outputDirPath });
            throw new DownstreamServiceFailureError('Failed to convert to html');
        }
        let dirFiles = await readdir(outputDirPath, { withFileTypes: true, encoding: 'utf-8' });
        const htmlFile = dirFiles.find((f) => f.isFile() && f.name.endsWith('.html') || f.name.endsWith('.xhtml'));

        if (!htmlFile) {
            this.logger.warn(`No html/xhtml file found after calc conversion`, { inputFilePath, outputDirPath, dirFiles });
            throw new DownstreamServiceFailureError('Failed to find converted html file');
        }
        const htmlFilePath = path.join(outputDirPath, htmlFile.name);
        try {
            await this.runSOffice(['--convert-to', 'pdf:calc_pdf_Export:{"SinglePageSheets":{"type":"boolean","value":"true"}}', '--outdir', outputDirPath, inputFilePath], options?.spawnOptions);
        } catch (err) {
            this.logger.warn(`Failed to convert calc to pdf`, { err, inputFilePath, outputDirPath });
            throw new DownstreamServiceFailureError('Failed to convert to pdf');
        }

        dirFiles = await readdir(outputDirPath, { withFileTypes: true, encoding: 'utf-8' });
        const pdfFile = dirFiles.find((f) => f.isFile() && f.name.endsWith('.pdf'));

        if (!pdfFile) {
            this.logger.warn(`No pdf file found after calc conversion`, { inputFilePath, outputDirPath, dirFiles });
            throw new DownstreamServiceFailureError('Failed to find converted pdf file');
        }
        const pdfFilePath = path.join(outputDirPath, pdfFile.name);
        const extracted = await this.pdfExtractor.extractRendered(pdfFilePath, outputDirPath, options?.pagesToRender);

        const html = await readFile(htmlFilePath, { encoding: 'utf-8' });

        const htmlElem = this.jsdomControl.snippetToElement(html);

        const pages = Array.from(htmlElem.querySelectorAll('body>table')).map((x) => x.outerHTML).map((x, i) => {
            const pdf = extracted.pages[i];

            const page = {
                viewport: pdf.pngPath ? {
                    width: pdf.width,
                    height: pdf.height
                } : undefined,
                html: x,
                content: pdf.content,
                text: pdf.text,
                pngPath: pdf.pngPath,
            };

            return page;
        });

        return {
            html: html,
            meta: extracted.meta,
            content: extracted.content,
            text: extracted.text,
            pages: pages,
        };
    }

    async extractFromWriter(inputFilePath: string, outputDirPath: string,
        options?: {
            spawnOptions?: SpawnOptionsWithoutStdio;
            pagesToRender?: number[] | Set<number>;
        }
    ) {
        try {
            await this.runSOffice(['--convert-to', 'html', '--outdir', outputDirPath, inputFilePath], options?.spawnOptions).catch((err) => {
                this.logger.warn(`First attempt to convert writer to snapshot failed, retrying xhtml approach...`, { err });
                return this.runSOffice(['--convert-to', 'xhtml', '--outdir', outputDirPath, inputFilePath], options?.spawnOptions);
            });

            // await this.runSOffice(['--convert-to', 'xhtml:XHTML Writer File', '--outdir', outputDirPath, inputFilePath], options);
        } catch (err) {
            this.logger.warn(`Failed to convert calc to html`, { err, inputFilePath, outputDirPath });
            throw new DownstreamServiceFailureError('Failed to convert to html');
        }
        let dirFiles = await readdir(outputDirPath, { withFileTypes: true, encoding: 'utf-8' });
        const htmlFile = dirFiles.find((f) => f.isFile() && f.name.endsWith('.html') || f.name.endsWith('.xhtml'));

        if (!htmlFile) {
            this.logger.warn(`No html/xhtml file found after writer conversion`, { inputFilePath, outputDirPath, dirFiles });
            throw new DownstreamServiceFailureError('Failed to find converted html file');
        }
        const htmlFilePath = path.join(outputDirPath, htmlFile.name);
        try {
            await this.runSOffice(['--convert-to', 'pdf', '--outdir', outputDirPath, inputFilePath], options?.spawnOptions);
        } catch (err) {
            this.logger.warn(`Failed to convert writer to pdf`, { err, inputFilePath, outputDirPath });
            throw new DownstreamServiceFailureError('Failed to convert to pdf');
        }

        dirFiles = await readdir(outputDirPath, { withFileTypes: true, encoding: 'utf-8' });
        const pdfFile = dirFiles.find((f) => f.isFile() && f.name.endsWith('.pdf'));

        if (!pdfFile) {
            this.logger.warn(`No pdf file found after writer conversion`, { inputFilePath, outputDirPath, dirFiles });
            throw new DownstreamServiceFailureError('Failed to find converted pdf file');
        }
        const pdfFilePath = path.join(outputDirPath, pdfFile.name);
        const extracted = await this.pdfExtractor.extractRendered(pdfFilePath, outputDirPath, options?.pagesToRender);

        const html = await readFile(htmlFilePath, { encoding: 'utf-8' });

        const pages = extracted.pages.map((x) => {
            const pdf = x;

            const page = {
                viewport: pdf.pngPath ? {
                    width: pdf.width,
                    height: pdf.height
                } : undefined,
                html: '',
                content: pdf.content,
                text: pdf.text,
                pngPath: pdf.pngPath,
            };

            return page;
        });

        return {
            html: html,
            meta: extracted.meta,
            content: extracted.content,
            text: extracted.text,
            pages: pages,
        };
    }

    async extractFromImpress(inputFilePath: string, outputDirPath: string,
        options?: {
            spawnOptions?: SpawnOptionsWithoutStdio;
            pagesToRender?: number[] | Set<number>;
        }
    ) {
        try {
            await this.runSOffice(['--convert-to', 'html', '--outdir', outputDirPath, inputFilePath], options?.spawnOptions).catch((err) => {
                this.logger.warn(`First attempt to convert impress to snapshot failed, retrying xhtml approach...`, { err });
                return this.runSOffice(['--convert-to', 'xhtml', '--outdir', outputDirPath, inputFilePath], options?.spawnOptions);
            });

            // await this.runSOffice(['--convert-to', 'xhtml:XHTML Impress File', '--outdir', outputDirPath, inputFilePath], options);
        } catch (err) {
            this.logger.warn(`Failed to convert impress to html`, { err, inputFilePath, outputDirPath });
            throw new DownstreamServiceFailureError('Failed to convert to html');
        }
        let dirFiles = await readdir(outputDirPath, { withFileTypes: true, encoding: 'utf-8' });
        const htmlFile = dirFiles.find((f) => f.isFile() && f.name.endsWith('.html') || f.name.endsWith('.xhtml'));

        if (!htmlFile) {
            this.logger.warn(`No html/xhtml file found after impress conversion`, { inputFilePath, outputDirPath, dirFiles });
            throw new DownstreamServiceFailureError('Failed to find converted html file');
        }
        const htmlFilePath = path.join(outputDirPath, htmlFile.name);
        try {
            await this.runSOffice(['--convert-to', 'pdf', '--outdir', outputDirPath, inputFilePath], options?.spawnOptions);
        } catch (err) {
            this.logger.warn(`Failed to convert impress to pdf`, { err, inputFilePath, outputDirPath });
            throw new DownstreamServiceFailureError('Failed to convert to pdf');
        }

        dirFiles = await readdir(outputDirPath, { withFileTypes: true, encoding: 'utf-8' });
        const pdfFile = dirFiles.find((f) => f.isFile() && f.name.endsWith('.pdf'));

        if (!pdfFile) {
            this.logger.warn(`No pdf file found after impress conversion`, { inputFilePath, outputDirPath, dirFiles });
            throw new DownstreamServiceFailureError('Failed to find converted pdf file');
        }
        const pdfFilePath = path.join(outputDirPath, pdfFile.name);
        const extracted = await this.pdfExtractor.extractRendered(pdfFilePath, outputDirPath, options?.pagesToRender);

        const html = await readFile(htmlFilePath, { encoding: 'utf-8' });

        const pages = extracted.pages.map((x) => {
            const pdf = x;

            const page = {
                viewport: pdf.pngPath ? {
                    width: pdf.width,
                    height: pdf.height
                } : undefined,
                html: '',
                content: pdf.content,
                text: pdf.text,
                pngPath: pdf.pngPath,
            };

            return page;
        });

        return {
            html: html,
            meta: extracted.meta,
            content: extracted.content,
            text: extracted.text,
            pages: pages,
        };
    }



}