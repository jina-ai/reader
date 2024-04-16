import { AssertionFailureError, AsyncService, HashManager } from 'civkit';
import { singleton } from 'tsyringe';
import { Logger } from '../shared/services/logger';
import { CanvasService } from '../shared/services/canvas';
import { ImageInterrogationManager } from '../shared/services/common-iminterrogate';
import { ImgBrief } from './puppeteer';
import { ImgAlt } from '../db/img-alt';


const md5Hasher = new HashManager('md5', 'hex');

@singleton()
export class AltTextService extends AsyncService {

    logger = this.globalLogger.child({ service: this.constructor.name });

    constructor(
        protected globalLogger: Logger,
        protected imageInterrogator: ImageInterrogationManager,
        protected canvasService: CanvasService
    ) {
        super(...arguments);
    }

    override async init() {
        await this.dependencyReady();
        this.emit('ready');
    }

    async caption(url: string) {
        try {
            const img = await this.canvasService.loadImage(url);
            const resized = this.canvasService.fitImageToSquareBox(img, 1024);
            const exported = await this.canvasService.canvasToBuffer(resized, 'image/png');

            const r = await this.imageInterrogator.interrogate('blip2', {
                image: exported,
                // prompt: `A formal caption in one sentence, concise and in the third person: HTML <img> alt text of this image. Return "**NSFW**" if you don't feel comfortable captioning it.`
            });

            return r.replaceAll(/[\n\"]|(\.\s*$)/g, '').trim();
        } catch (err) {
            throw new AssertionFailureError({ message: `Could not generate alt text for url ${url}`, cause: err });
        }
    }

    async getAltTextAndShortDigest(imgBrief: ImgBrief) {
        if (!imgBrief.src) {
            return undefined;
        }
        const digest = md5Hasher.hash(imgBrief.src);
        const shortDigest = Buffer.from(digest, 'hex').toString('base64url');

        const existing = await ImgAlt.fromFirestore(shortDigest);

        if (existing?.generatedAlt) {
            return {
                shortDigest,
                alt: existing.generatedAlt,
            };
        }

        let generatedCaption;

        if (!imgBrief.alt) {
            try {
                generatedCaption = await this.caption(imgBrief.src);
            } catch (err) {
                this.logger.warn(`Unable to generate alt text for ${imgBrief.src}`, { err });
            }
        }

        await ImgAlt.COLLECTION.doc(shortDigest).set(
            {
                _id: shortDigest,
                src: imgBrief.src || '',
                width: imgBrief.naturalWidth || 0,
                height: imgBrief.naturalHeight || 0,
                urlDigest: digest,
                originalAlt: imgBrief.alt || '',
                generatedAlt: generatedCaption || '',
                createdAt: new Date()
            }, { merge: true }
        );

        return {
            shortDigest,
            alt: generatedCaption,
        };
    }
}
