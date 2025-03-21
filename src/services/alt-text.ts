import { AssertionFailureError, AsyncService, HashManager } from 'civkit';
import { singleton } from 'tsyringe';
import { GlobalLogger } from './logger';
import { CanvasService } from './canvas';
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
        protected globalLogger: GlobalLogger,
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
            const contentTypeHint = Reflect.get(img, 'contentType');
            if (Math.min(img.naturalHeight, img.naturalWidth) < 64) {
                throw new AssertionFailureError({ message: `Image is too small to generate alt text for url ${url}` });
            }
            const resized = this.canvasService.fitImageToSquareBox(img, 1024);
            const exported = await this.canvasService.canvasToBuffer(resized, 'image/png');

            const svgHint = contentTypeHint.includes('svg') ? `Beware this image is a SVG rendered on a gray background, the gray background is not part of the image.\n\n` : '';
            const svgSystemHint = contentTypeHint.includes('svg') ? ` Sometimes the system renders SVG on a gray background. When this happens, you must not include the gray background in the description.` : '';

            const r = await this.imageInterrogator.interrogate('vertex-gemini-2.0-flash', {
                image: exported,
                prompt: `${svgHint}Give a concise image caption descriptive sentence in third person. Start directly with the description.`,
                system: `You are BLIP2, an image caption model. You will generate Alt Text (in web pages) for any image for a11y purposes. You must not start with "This image is sth...", instead, start direly with "sth..."${svgSystemHint}`,
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
            return generatedCaption;
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
