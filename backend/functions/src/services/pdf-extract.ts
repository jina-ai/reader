import 'core-js/actual/promise/with-resolvers';
import { singleton } from 'tsyringe';
import _ from 'lodash';
import { TextItem } from 'pdfjs-dist/types/src/display/api';
import { AsyncService, HashManager } from 'civkit';
import { Logger } from '../shared/services/logger';
import { PDFContent } from '../db/pdf';
import dayjs from 'dayjs';
import { FirebaseStorageBucketControl } from '../shared';
import { randomUUID } from 'crypto';
const utc = require('dayjs/plugin/utc');  // Import the UTC plugin
dayjs.extend(utc);  // Extend dayjs with the UTC plugin
const timezone = require('dayjs/plugin/timezone');
dayjs.extend(timezone);

const pPdfjs = import('pdfjs-dist');


const md5Hasher = new HashManager('md5', 'hex');

function stdDev(numbers: number[]) {
    const mean = _.mean(numbers);
    const squareDiffs = numbers.map((num) => Math.pow(num - mean, 2));
    const avgSquareDiff = _.mean(squareDiffs);
    return Math.sqrt(avgSquareDiff);
}

function isRotatedByAtLeast35Degrees(transform: [number, number, number, number, number, number]): boolean {
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
        protected globalLogger: Logger,
        protected firebaseObjectStorage: FirebaseStorageBucketControl,
    ) {
        super(...arguments);
    }

    override async init() {
        await this.dependencyReady();
        this.pdfjs = await pPdfjs;

        this.emit('ready');
    }

    async extract(url: string | URL) {
        const loadingTask = this.pdfjs.getDocument({
            url,
            disableFontFace: true,
            verbosity: 0
        });

        const doc = await loadingTask.promise;
        const meta = await doc.getMetadata();

        const textItems: TextItem[][] = [];

        for (const pg of _.range(0, doc.numPages)) {
            const page = await doc.getPage(pg + 1);
            const textContent = await page.getTextContent();
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

    async cachedExtract(url: string | URL, cacheTolerance: number = 1000 * 3600 * 24) {
        if (!url) {
            return undefined;
        }

        const digest = md5Hasher.hash(url.toString());

        const cache: PDFContent | undefined = (await PDFContent.fromFirestoreQuery(PDFContent.COLLECTION.where('urlDigest', '==', digest).orderBy('createdAt', 'desc').limit(1)))?.[0];

        if (cache) {
            const age = Date.now() - cache?.createdAt.valueOf();
            const stale = cache.createdAt.valueOf() < (Date.now() - cacheTolerance);
            this.logger.info(`${stale ? 'Stale cache exists' : 'Cache hit'} for PDF ${url}, normalized digest: ${digest}, ${age}ms old, tolerance ${cacheTolerance}ms`, {
                url, digest, age, stale, cacheTolerance
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
                    this.logger.warn(`Unable to load cached content for ${url}`, { err });

                    return undefined;
                }
            }
        }

        let extracted;

        try {
            extracted = await this.extract(url);
        } catch (err) {
            this.logger.warn(`Unable to extract from pdf ${url}`, { err });
        }

        // Don't try again until the next hour
        const expireMixin = extracted ? {
            expireAt: new Date(Date.now() + this.cacheRetentionMs)
        } : {
            expireAt: new Date(Date.now() + 1000 * 3600)
        };
        const theID = randomUUID();

        await this.firebaseObjectStorage.saveFile(`pdfs/${theID}`,
            Buffer.from(JSON.stringify(extracted), 'utf-8'), { contentType: 'application/json' });
        PDFContent.save(
            PDFContent.from({
                _id: theID,
                src: url.toString(),
                meta: extracted?.meta || {},
                urlDigest: digest,
                createdAt: new Date(),
                ...expireMixin
            }).degradeForFireStore()
        ).catch((r) => {
            this.logger.warn(`Unable to cache PDF content for ${url}`, { err: r });
        });

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
