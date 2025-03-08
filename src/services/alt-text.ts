import { AssertionFailureError, AsyncService, HashManager } from 'civkit';
import { singleton } from 'tsyringe';
import { Logger } from '../shared/services/logger';
import { CanvasService } from '../shared/services/canvas';
import { ImageInterrogationManager } from '../shared/services/common-iminterrogate';
import { ImgBrief } from './puppeteer';
import { ImgAlt } from '../db/img-alt';
import { AsyncLocalContext } from './async-context';

const md5Hasher = new HashManager('md5', 'hex');

@singleton()
export class AltTextService extends AsyncService {

    altsToIgnore = 'image,img,photo,picture,pic,alt,figure,fig'.split(',');
    logger = this.globalLogger.child({ service: this.constructor.name });

    constructor(
        protected globalLogger: Logger,
        protected imageInterrogator: ImageInterrogationManager,
        protected canvasService: CanvasService,
        protected asyncLocalContext: AsyncLocalContext
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

            const r = await this.imageInterrogator.interrogate('vertex-gemini-1.5-flash-002', {
                image: exported,
                prompt: `Yield a concise image caption sentence in third person.`,
                system: 'You are BLIP2, an image caption model.',
            });

            return r.replaceAll(/[\n\"]|(\.\s*$)/g, '').trim();
        } catch (err) {
            throw new AssertionFailureError({ message: `Could not generate alt text for url ${url}`, cause: err });
        }
    }

    async getAltText(imgBrief: ImgBrief) {
        if (!imgBrief.src) {
            return undefined;
        }
        if (imgBrief.alt && !this.altsToIgnore.includes(imgBrief.alt.trim().toLowerCase())) {
            return imgBrief.alt;
        }
        const digest = md5Hasher.hash(imgBrief.src);
        const shortDigest = Buffer.from(digest, 'hex').toString('base64url');

        const existing = await ImgAlt.fromFirestore(shortDigest);

        if (existing) {
            return existing.generatedAlt || existing.originalAlt || '';
        }

        let generatedCaption = '';

        try {
            generatedCaption = await this.caption(imgBrief.src);
        } catch (err) {
            this.logger.warn(`Unable to generate alt text for ${imgBrief.src}`, { err });
        }

        if (this.asyncLocalContext.ctx.DNT) {
            // Don't cache alt text if DNT is set
            return;
        }

        // Don't try again until the next day
        const expireMixin = generatedCaption ? {} : { expireAt: new Date(Date.now() + 1000 * 3600 * 24) };

        await ImgAlt.COLLECTION.doc(shortDigest).set(
            {
                _id: shortDigest,
                src: imgBrief.src || '',
                width: imgBrief.naturalWidth || 0,
                height: imgBrief.naturalHeight || 0,
                urlDigest: digest,
                originalAlt: imgBrief.alt || '',
                generatedAlt: generatedCaption || '',
                createdAt: new Date(),
                ...expireMixin
            }, { merge: true }
        );

        return generatedCaption;
    }
}
