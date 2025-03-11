import 'core-js/actual/promise/with-resolvers';
import { singleton } from 'tsyringe';
import _ from 'lodash';
import { TextItem } from 'pdfjs-dist/types/src/display/api';
import { AssertionFailureError, AsyncService, HashManager } from 'civkit';
import { GlobalLogger } from './logger';
import { PDFContent } from '../db/pdf';
import dayjs from 'dayjs';
import { FirebaseStorageBucketControl } from '../shared/services/firebase-storage-bucket';
import { randomUUID } from 'crypto';
import type { PDFDocumentLoadingTask } from 'pdfjs-dist';
import path from 'path';
import { AsyncLocalContext } from './async-context';
const utc = require('dayjs/plugin/utc');  // Import the UTC plugin
dayjs.extend(utc);  // Extend dayjs with the UTC plugin
const timezone = require('dayjs/plugin/timezone');
dayjs.extend(timezone);

const pPdfjs = import('pdfjs-dist/legacy/build/pdf.mjs');
const nodeCmapUrl = path.resolve(require.resolve('pdfjs-dist'), '../../cmaps') + '/';

const md5Hasher = new HashManager('md5', 'hex');

function stdDev(numbers: number[]) {
    const mean = _.mean(numbers);
    const squareDiffs = numbers.map((num) => Math.pow(num - mean, 2));
    const avgSquareDiff = _.mean(squareDiffs);
    return Math.sqrt(avgSquareDiff);
}

function isRotatedByAtLeast35Degrees(transform?: [number, number, number, number, number, number]): boolean {
    if (!transform) {
        return false;
    }
    const [a, b, c, d, _e, _f] = transform;

    // Calculate the rotation angles using arctan(b/a) and arctan(-c/d)
    const angle1 = Math.atan2(b, a) * (180 / Math.PI); // from a, b
    const angle2 = Math.atan2(-c, d) * (180 / Math.PI); // from c, d

    // Either angle1 or angle2 can be used to determine the rotation, they should be equivalent
    const rotationAngle1 = Math.abs(angle1);
    const rotationAngle2 = Math.abs(angle2);

    // Check if the absolute rotation angle is greater than or equal to 35 degrees
    return rotationAngle1 >= 35 || rotationAngle2 >= 35;
}

@singleton()
export class PDFExtractor extends AsyncService {

    logger = this.globalLogger.child({ service: this.constructor.name });
    pdfjs!: Awaited<typeof pPdfjs>;

    cacheRetentionMs = 1000 * 3600 * 24 * 7;

    constructor(
        protected globalLogger: GlobalLogger,
        protected firebaseObjectStorage: FirebaseStorageBucketControl,
        protected asyncLocalContext: AsyncLocalContext,
    ) {
        super(...arguments);
    }

    override async init() {
        await this.dependencyReady();
        this.pdfjs = await pPdfjs;

        this.emit('ready');
    }

    isDataUrl(url: string) {
        return url.startsWith('data:');
    }

    parseDataUrl(url: string) {
        const protocol = url.slice(0, url.indexOf(':'));
        const contentType = url.slice(url.indexOf(':') + 1, url.indexOf(';'));
        const data = url.slice(url.indexOf(',') + 1);
        if (protocol !== 'data' || !data) {
            throw new Error('Invalid data URL');
        }

        if (contentType !== 'application/pdf') {
            throw new Error('Invalid data URL type');
        }

        return {
            type: contentType,
            data: data
        };
    }

    async extract(url: string | URL) {
        let loadingTask: PDFDocumentLoadingTask;

        if (typeof url === 'string' && this.isDataUrl(url)) {
            const { data } = this.parseDataUrl(url);
            const binary = Uint8Array.from(Buffer.from(data, 'base64'));
            loadingTask = this.pdfjs.getDocument({
                data: binary,
                disableFontFace: true,
                verbosity: 0,
                cMapUrl: nodeCmapUrl,
            });
        } else {
            loadingTask = this.pdfjs.getDocument({
                url,
                disableFontFace: true,
                verbosity: 0,
                cMapUrl: nodeCmapUrl,
            });
        }


        const doc = await loadingTask.promise;
        const meta = await doc.getMetadata();

        const textItems: TextItem[][] = [];

        for (const pg of _.range(0, doc.numPages)) {
            const page = await doc.getPage(pg + 1);
            const textContent = await page.getTextContent({ includeMarkedContent: true });
            textItems.push((textContent.items as TextItem[]));
        }

        const articleCharHeights: number[] = [];
        for (const textItem of textItems.flat()) {
            if (textItem.height) {
                articleCharHeights.push(...Array(textItem.str.length).fill(textItem.height));
            }
        }
        const articleAvgHeight = _.mean(articleCharHeights);
        const articleStdDevHeight = stdDev(articleCharHeights);
        // const articleMedianHeight = articleCharHeights.sort()[Math.floor(articleCharHeights.length / 2)];
        const mdOps: Array<{
            text: string;
            op?: 'new' | 'append';
            mode: 'h1' | 'h2' | 'p' | 'appendix' | 'space';
        }> = [];

        const rawChunks: string[] = [];

        let op: 'append' | 'new' = 'new';
        let mode: 'h1' | 'h2' | 'p' | 'space' | 'appendix' = 'p';
        for (const pageTextItems of textItems) {
            const charHeights = [];
            for (const textItem of pageTextItems as TextItem[]) {
                if (textItem.height) {
                    charHeights.push(...Array(textItem.str.length).fill(textItem.height));
                }
                rawChunks.push(`${textItem.str}${textItem.hasEOL ? '\n' : ''}`);
            }

            const avgHeight = _.mean(charHeights);
            const stdDevHeight = stdDev(charHeights);
            // const medianHeight = charHeights.sort()[Math.floor(charHeights.length / 2)];

            for (const textItem of pageTextItems) {
                if (textItem.height > articleAvgHeight + 3 * articleStdDevHeight) {
                    mode = 'h1';
                } else if (textItem.height > articleAvgHeight + 2 * articleStdDevHeight) {
                    mode = 'h2';
                } else if (textItem.height && textItem.height < avgHeight - stdDevHeight) {
                    mode = 'appendix';
                } else if (textItem.height) {
                    mode = 'p';
                } else {
                    mode = 'space';
                }

                if (isRotatedByAtLeast35Degrees(textItem.transform as any)) {
                    mode = 'appendix';
                }

                mdOps.push({
                    op,
                    mode,
                    text: textItem.str
                });

                if (textItem.hasEOL && !textItem.str) {
                    op = 'new';
                } else {
                    op = 'append';
                }
            }
        }

        const mdChunks = [];
        const appendixChunks = [];
        mode = 'space';
        for (const x of mdOps) {
            const previousMode: string = mode;
            const changeToMdChunks = [];

            const isNewStart = x.mode !== 'space' && (x.op === 'new' || (previousMode === 'appendix' && x.mode !== previousMode));

            if (isNewStart) {
                switch (x.mode) {
                    case 'h1': {
                        changeToMdChunks.push(`\n\n# `);
                        mode = x.mode;
                        break;
                    }

                    case 'h2': {
                        changeToMdChunks.push(`\n\n## `);
                        mode = x.mode;
                        break;
                    }

                    case 'p': {
                        changeToMdChunks.push(`\n\n`);
                        mode = x.mode;
                        break;
                    }

                    case 'appendix': {
                        mode = x.mode;
                        appendixChunks.push(`\n\n`);
                        break;
                    }

                    default: {
                        break;
                    }
                }
            } else {
                if (x.mode === 'appendix' && appendixChunks.length) {
                    const lastChunk = appendixChunks[appendixChunks.length - 1];
                    if (!lastChunk.match(/(\s+|-)$/) && lastChunk.length !== 1) {
                        appendixChunks.push(' ');
                    }
                } else if (mdChunks.length) {
                    const lastChunk = mdChunks[mdChunks.length - 1];
                    if (!lastChunk.match(/(\s+|-)$/) && lastChunk.length !== 1) {
                        changeToMdChunks.push(' ');
                    }
                }
            }

            if (x.text) {
                if (x.mode == 'appendix') {
                    if (appendixChunks.length || isNewStart) {
                        appendixChunks.push(x.text);
                    } else {
                        changeToMdChunks.push(x.text);
                    }
                } else {
                    changeToMdChunks.push(x.text);
                }
            }

            if (isNewStart && x.mode !== 'appendix' && appendixChunks.length) {
                const appendix = appendixChunks.join('').split(/\r?\n/).map((x) => x.trim()).filter(Boolean).map((x) => `> ${x}`).join('\n');
                changeToMdChunks.unshift(appendix);
                changeToMdChunks.unshift(`\n\n`);
                appendixChunks.length = 0;
            }

            if (x.mode === 'space' && changeToMdChunks.length) {
                changeToMdChunks.length = 1;
            }
            if (changeToMdChunks.length) {
                mdChunks.push(...changeToMdChunks);
            }
        }

        if (mdChunks.length) {
            mdChunks[0] = mdChunks[0].trimStart();
        }

        return { meta: meta.info as Record<string, any>, content: mdChunks.join(''), text: rawChunks.join('') };
    }

    async cachedExtract(url: string, cacheTolerance: number = 1000 * 3600 * 24, alternativeUrl?: string) {
        if (!url) {
            return undefined;
        }
        let nameUrl = alternativeUrl || url;
        const digest = md5Hasher.hash(nameUrl);

        if (this.isDataUrl(url)) {
            nameUrl = `blob://pdf:${digest}`;
        }

        const cache: PDFContent | undefined = nameUrl.startsWith('blob:') ? undefined :
            (await PDFContent.fromFirestoreQuery(PDFContent.COLLECTION.where('urlDigest', '==', digest).orderBy('createdAt', 'desc').limit(1)))?.[0];

        if (cache) {
            const age = Date.now() - cache?.createdAt.valueOf();
            const stale = cache.createdAt.valueOf() < (Date.now() - cacheTolerance);
            this.logger.info(`${stale ? 'Stale cache exists' : 'Cache hit'} for PDF ${nameUrl}, normalized digest: ${digest}, ${age}ms old, tolerance ${cacheTolerance}ms`, {
                data: url, url: nameUrl, digest, age, stale, cacheTolerance
            });

            if (!stale) {
                if (cache.content && cache.text) {
                    return {
                        meta: cache.meta,
                        content: cache.content,
                        text: cache.text
                    };
                }

                try {
                    const r = await this.firebaseObjectStorage.downloadFile(`pdfs/${cache._id}`);
                    let cached = JSON.parse(r.toString('utf-8'));

                    return {
                        meta: cached.meta,
                        content: cached.content,
                        text: cached.text
                    };
                } catch (err) {
                    this.logger.warn(`Unable to load cached content for ${nameUrl}`, { err });

                    return undefined;
                }
            }
        }

        let extracted;

        try {
            extracted = await this.extract(url);
        } catch (err: any) {
            this.logger.warn(`Unable to extract from pdf ${nameUrl}`, { err, url, nameUrl });
            throw new AssertionFailureError(`Unable to process ${nameUrl} as pdf: ${err?.message}`);
        }

        if (!this.asyncLocalContext.ctx.DNT && !nameUrl.startsWith('blob:')) {
            const theID = randomUUID();
            await this.firebaseObjectStorage.saveFile(`pdfs/${theID}`,
                Buffer.from(JSON.stringify(extracted), 'utf-8'), { contentType: 'application/json' });
            PDFContent.save(
                PDFContent.from({
                    _id: theID,
                    src: nameUrl,
                    meta: extracted?.meta || {},
                    urlDigest: digest,
                    createdAt: new Date(),
                    expireAt: new Date(Date.now() + this.cacheRetentionMs)
                }).degradeForFireStore()
            ).catch((r) => {
                this.logger.warn(`Unable to cache PDF content for ${nameUrl}`, { err: r });
            });
        }

        return extracted;
    }

    parsePdfDate(pdfDate: string | undefined) {
        if (!pdfDate) {
            return undefined;
        }
        // Remove the 'D:' prefix
        const cleanedDate = pdfDate.slice(2);

        // Define the format without the timezone part first
        const dateTimePart = cleanedDate.slice(0, 14);
        const timezonePart = cleanedDate.slice(14);

        // Construct the full date string in a standard format
        const formattedDate = `${dateTimePart}${timezonePart.replace("'", "").replace("'", "")}`;

        // Parse the date with timezone
        const parsedDate = dayjs(formattedDate, "YYYYMMDDHHmmssZ");

        const date = parsedDate.toDate();

        if (!date.valueOf()) {
            return undefined;
        }

        return date;
    }
}
