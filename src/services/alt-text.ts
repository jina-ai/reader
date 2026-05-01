import { AsyncService } from 'civkit/async-service';
import { HashManager } from 'civkit/hash';
import { AssertionFailureError } from 'civkit/civ-rpc';
import { singleton } from 'tsyringe';
import { GlobalLogger } from './logger';
import { CanvasService } from './canvas';
import { ImageInterrogationManager } from './common-iminterrogate';
import { ImgBrief } from './puppeteer';
import { AsyncLocalContext } from './async-context';
import { ImgAlt } from '../db/models';
import { StorageLayer } from '../db/noop-storage';
import { LLMManager } from './common-llm';

const md5Hasher = new HashManager('md5', 'hex');

@singleton()
export class AltTextService extends AsyncService {

    altsToIgnore = 'image,img,photo,picture,pic,alt,figure,fig,图片'.split(',');
    logger = this.globalLogger.child({ service: this.constructor.name });

    model = 'google/gemini-3.1-flash-lite-preview';

    constructor(
        protected globalLogger: GlobalLogger,
        protected imageInterrogator: ImageInterrogationManager,
        protected canvasService: CanvasService,
        protected asyncLocalContext: AsyncLocalContext,
        protected storageLayer: StorageLayer,
        protected llmManager: LLMManager,
    ) {
        super(...arguments);
    }

    override async init() {
        await this.dependencyReady();

        if (process.env.GCLOUD_PROJECT) {
            this.model = 'vertex-gemini-3.1-flash-lite';
        } else if (!this.llmManager.hasModel(this.model)) {
            await this.llmManager.importOpenRouterModel(this.model);
        }

        this.emit('ready');
    }

    async caption(input: string | Buffer, overrideModel?: string) {
        try {
            const img = await this.canvasService.loadImage(input);
            const contentTypeHint = Reflect.get(img, 'contentType');
            if (Math.min(img.naturalHeight, img.naturalWidth) <= 1) {
                return `A ${img.naturalWidth}x${img.naturalHeight} image, likely be a tacker probe`;
            }
            if (Math.min(img.naturalHeight, img.naturalWidth) < 64) {
                return `A ${img.naturalWidth}x${img.naturalHeight} small image, likely a logo, icon or avatar`;
            }
            const resized = this.canvasService.fitImageToSquareBox(img, 1024);
            const exported = await this.canvasService.canvasToBuffer(resized, 'image/png');

            const svgHint = contentTypeHint.includes('svg') ? `Beware this image is a SVG rendered on a gray background, the gray background is not part of the image.\n\n` : '';
            const svgSystemHint = contentTypeHint.includes('svg') ? ` Sometimes the system renders SVG on a gray background. When this happens, you must not include the gray background in the description.` : '';

            const r = await this.imageInterrogator.interrogate(overrideModel || this.model, {
                image: exported,
                prompt: `${svgHint}Give a concise image caption descriptive sentence in third person. Start directly with the subject.`,
                system: `You are BLIP2, an image captioning model. You will generate Alt Text (in web pages) for any image for a11y purposes. You must not start with "This image is sth...", instead, start direly with "sth..."${svgSystemHint}`,
            });

            return r.replaceAll(/[\n\"]|(\.\s*$)/g, '').trim();
        } catch (err) {
            throw new AssertionFailureError({
                message: `Could not generate alt text for ${typeof input === 'string' ? `url ${input}` : 'buffer'}`,
                cause: err
            });
        }
    }

    async vqa(
        input: string | Buffer,
        instruction: string = 'Give a professional, accurate, concise description for this image.',
        overrideModel?: string
    ) {
        try {
            const img = await this.canvasService.loadImage(input);
            const contentTypeHint = Reflect.get(img, 'contentType');
            if (Math.min(img.naturalHeight, img.naturalWidth) <= 1) {
                return `A ${img.naturalWidth}x${img.naturalHeight} image, likely be a tacker probe`;
            }
            if (Math.min(img.naturalHeight, img.naturalWidth) < 64) {
                return `A ${img.naturalWidth}x${img.naturalHeight} small image, likely a logo, icon or avatar`;
            }
            const resized = this.canvasService.fitImageToSquareBox(img, 1024);
            const exported = await this.canvasService.canvasToBuffer(resized, 'image/png');

            const svgHint = contentTypeHint.includes('svg') ? `Beware this image is a SVG rendered on a gray background, the gray background is not part of the image.\n\n` : '';

            const r = await this.imageInterrogator.interrogate(overrideModel || this.model, {
                image: exported,
                prompt: `${svgHint}${instruction}`,
                max_tokens: 768,
                temperature: 0,
                modelSpecific: {
                    stop: ['.', '\n']
                }
            });

            return r.replaceAll(/[\n\"]|(\.\s*$)/g, '').trim();
        } catch (err) {
            throw new AssertionFailureError({
                message: `Could not generate alt text for ${typeof input === 'string' ? `url ${input}` : 'buffer'}`,
                cause: err
            });
        }
    }

    async getAltText(imgBrief: ImgBrief, overrideModel?: string) {
        if (!imgBrief.src) {
            return undefined;
        }
        if (imgBrief.alt && !this.altsToIgnore.includes(imgBrief.alt.trim().toLowerCase())) {
            return imgBrief.alt;
        }
        const digest = md5Hasher.hash(imgBrief.src);
        let dims: number[] = [];
        do {
            if (imgBrief.loaded) {
                if (imgBrief.naturalWidth && imgBrief.naturalHeight) {
                    if (Math.min(imgBrief.naturalWidth, imgBrief.naturalHeight) < 64) {
                        dims = [imgBrief.naturalWidth, imgBrief.naturalHeight];
                        break;
                    }
                }
            }

            if (imgBrief.width && imgBrief.height) {
                if (Math.min(imgBrief.width, imgBrief.height) < 64) {
                    dims = [imgBrief.width, imgBrief.height];
                    break;
                }
            }

        } while (false);

        if (Math.min(...dims) <= 1) {
            return `A ${dims[0]}x${dims[1]} image, likely be a tacker probe`;
        }
        if (Math.min(...dims) < 64) {
            return `A ${dims[0]}x${dims[1]} small image, likely a logo, icon or avatar`;
        }

        const existing = await this.storageLayer.findImageAlt({ urlDigest: digest });

        if (existing) {
            return existing.generatedAlt || existing.originalAlt || '';
        }

        let generatedCaption = '';

        try {
            generatedCaption = await this.caption(imgBrief.buff || imgBrief.src, overrideModel);
        } catch (err) {
            this.logger.warn(`Unable to generate alt text for ${imgBrief.src}`, { err });
        }

        if (this.asyncLocalContext.ctx.DNT) {
            // Don't cache alt text if DNT is set
            return generatedCaption;
        }

        // Don't try again until the next day
        const expireMixin = generatedCaption ? {} : { expireAt: new Date(Date.now() + 1000 * 3600 * 24) };

        const cache = ImgAlt.from({
            _id: digest,
            src: imgBrief.src || '',
            width: imgBrief.naturalWidth || 0,
            height: imgBrief.naturalHeight || 0,
            urlDigest: digest,
            originalAlt: imgBrief.alt || '',
            generatedAlt: generatedCaption || '',
            createdAt: new Date(),
            ...expireMixin
        });
        await this.storageLayer.storeImageAlt(cache).catch((err) => {
            this.logger.warn(`Unable to cache alt text for ${imgBrief.src}`, { err });
        });

        return generatedCaption;
    }
};
