import { Also, AutoCastable, Prop, RPC_CALL_ENVIRONMENT } from 'civkit'; // Adjust the import based on where your decorators are defined
import type { Request, Response } from 'express';
import { Cookie, parseString as parseSetCookieString } from 'set-cookie-parser';

export enum CONTENT_FORMAT {
    CONTENT = 'content',
    MARKDOWN = 'markdown',
    HTML = 'html',
    TEXT = 'text',
    PAGESHOT = 'pageshot',
    SCREENSHOT = 'screenshot',
}

const CONTENT_FORMAT_VALUES = new Set<string>(Object.values(CONTENT_FORMAT));

export const IMAGE_RETENTION_MODES = ['none', 'all', 'alt', 'all_p', 'alt_p'] as const;
const IMAGE_RETENTION_MODE_VALUES = new Set<string>(IMAGE_RETENTION_MODES);

@Also({
    openapi: {
        operation: {
            parameters: {
                'Accept': {
                    description: `Specifies your preference for the response format.\n\n` +
                        `Supported formats: \n` +
                        `- text/event-stream\n` +
                        `- application/json or text/json\n` +
                        `- text/plain`
                    ,
                    in: 'header',
                    schema: { type: 'string' }
                },
                'X-Cache-Tolerance': {
                    description: `Sets internal cache tolerance in seconds if this header is specified with a integer.`,
                    in: 'header',
                    schema: { type: 'string' }
                },
                'X-No-Cache': {
                    description: `Ignores internal cache if this header is specified with a value.\n\nEquivalent to X-Cache-Tolerance: 0`,
                    in: 'header',
                    schema: { type: 'string' }
                },
                'X-Respond-With': {
                    description: `Specifies the (non-default) form factor of the crawled data you prefer.\n\n` +
                        `Supported formats: \n` +
                        `- markdown\n` +
                        `- html\n` +
                        `- text\n` +
                        `- pageshot\n` +
                        `- screenshot\n` +
                        `- content\n` +
                        `- any combination of the above\n\n` +
                        `Default: content\n`
                    ,
                    in: 'header',
                    schema: { type: 'string' }
                },
                'X-Wait-For-Selector': {
                    description: `Specifies a CSS selector to wait for the appearance of such an element before returning.\n\n` +
                        'Example: `X-Wait-For-Selector: .content-block`\n'
                    ,
                    in: 'header',
                    schema: { type: 'string' }
                },
                'X-Target-Selector': {
                    description: `Specifies a CSS selector for return target instead of the full html.\n\n` +
                        'Implies `X-Wait-For-Selector: (same selector)`'
                    ,
                    in: 'header',
                    schema: { type: 'string' }
                },
                'X-Remove-Selector': {
                    description: `Specifies a CSS selector to remove elements from the full html.\n\n` +
                        'Example `X-Remove-Selector: nav`'
                    ,
                    in: 'header',
                    schema: { type: 'string' }
                },
                'X-Keep-Img-Data-Url': {
                    description: `Keep data-url as it instead of transforming them to object-url. (Only applicable when targeting markdown format)\n\n` +
                        'Example `X-Keep-Img-Data-Url: true`'
                    ,
                    in: 'header',
                    schema: { type: 'string' }
                },
                'X-Proxy-Url': {
                    description: `Specifies your custom proxy if you prefer to use one.\n\n` +
                        `Supported protocols: \n` +
                        `- http\n` +
                        `- https\n` +
                        `- socks4\n` +
                        `- socks5\n\n` +
                        `For authentication, https://user:pass@host:port`,
                    in: 'header',
                    schema: { type: 'string' }
                },
                'X-Set-Cookie': {
                    description: `Sets cookie(s) to the headless browser for your request. \n\n` +
                        `Syntax is the same with standard Set-Cookie`,
                    in: 'header',
                    schema: { type: 'string' }
                },
                'X-With-Generated-Alt': {
                    description: `Enable automatic alt-text generating for images without an meaningful alt-text.\n\n` +
                        `Note: Does not work when \`X-Respond-With\` is specified`,
                    in: 'header',
                    schema: { type: 'string' }
                },
                'X-With-Images-Summary': {
                    description: `Enable dedicated summary section for images on the page.`,
                    in: 'header',
                    schema: { type: 'string' }
                },
                'X-With-links-Summary': {
                    description: `Enable dedicated summary section for hyper links on the page.`,
                    in: 'header',
                    schema: { type: 'string' }
                },
                'X-Retain-Images': {
                    description: `Image retention modes.\n\n` +
                        `Supported modes: \n` +
                        `- all: all images\n` +
                        `- none: no images\n` +
                        `- alt: only alt text\n` +
                        `- all_p: all images and with generated alt text\n` +
                        `- alt_p: only alt text and with generated alt\n\n`,
                    in: 'header',
                    schema: { type: 'string' }
                },
                'X-With-Iframe': {
                    description: `Enable filling iframe contents into main. (violates standards)`,
                    in: 'header',
                    schema: { type: 'string' }
                },
                'X-With-Shadow-Dom': {
                    description: `Enable filling shadow dom contents into main. (violates standards)`,
                    in: 'header',
                    schema: { type: 'string' }
                },
                'X-User-Agent': {
                    description: `Override User-Agent.`,
                    in: 'header',
                    schema: { type: 'string' }
                },
                'X-Timeout': {
                    description: `Specify timeout in seconds. Max 180.`,
                    in: 'header',
                    schema: { type: 'string' }
                },
                'X-Locale': {
                    description: 'Specify browser locale for the page.',
                    in: 'header',
                    schema: { type: 'string' }
                },
                'X-Referer': {
                    description: 'Specify referer for the page.',
                    in: 'header',
                    schema: { type: 'string' }
                }
            }
        }
    }
})
export class CrawlerOptions extends AutoCastable {

    @Prop()
    url?: string;

    @Prop()
    html?: string;

    @Prop({
        desc: 'Base64 encoded PDF.',
        type: [File, String]
    })
    pdf?: File | string;

    @Prop({
        default: CONTENT_FORMAT.CONTENT,
        type: [CONTENT_FORMAT, String]
    })
    respondWith!: string;

    @Prop({
        default: false,
    })
    withGeneratedAlt!: boolean;

    @Prop({ default: 'all', type: IMAGE_RETENTION_MODE_VALUES })
    retainImages?: typeof IMAGE_RETENTION_MODES[number];

    @Prop({
        default: false,
    })
    withLinksSummary!: boolean;

    @Prop({
        default: false,
    })
    withImagesSummary!: boolean;

    @Prop({
        default: false,
    })
    noCache!: boolean;

    @Prop({
        default: false,
    })
    noGfm!: string | boolean;

    @Prop()
    cacheTolerance?: number;

    @Prop({ arrayOf: String })
    targetSelector?: string | string[];

    @Prop({ arrayOf: String })
    waitForSelector?: string | string[];

    @Prop({ arrayOf: String })
    removeSelector?: string | string[];

    @Prop({
        default: false,
    })
    keepImgDataUrl!: boolean;

    @Prop({
        default: false,
        type: [String, Boolean]
    })
    withIframe!: boolean | 'quoted';

    @Prop({
        default: false,
    })
    withShadowDom!: boolean;

    @Prop({
        arrayOf: String,
    })
    setCookies?: Cookie[];

    @Prop()
    proxyUrl?: string;

    @Prop()
    userAgent?: string;

    @Prop({
        arrayOf: String,
    })
    injectPageScript?: string[];

    @Prop({
        arrayOf: String,
    })
    injectFrameScript?: string[];

    @Prop({
        validate: (v: number) => v > 0 && v <= 180,
        type: Number,
        nullable: true,
    })
    timeout?: number | null;

    @Prop()
    locale?: string;

    @Prop()
    referer?: string;

    static override from(input: any) {
        const instance = super.from(input) as CrawlerOptions;
        const ctx = Reflect.get(input, RPC_CALL_ENVIRONMENT) as {
            req: Request,
            res: Response,
        } | undefined;

        const customMode = ctx?.req.get('x-respond-with') || ctx?.req.get('x-return-format');
        if (customMode !== undefined) {
            instance.respondWith = customMode;
        }

        const locale = ctx?.req.get('x-locale');
        if (locale !== undefined) {
            instance.locale = locale;
        }

        const referer = ctx?.req.get('x-referer');
        if (referer !== undefined) {
            instance.referer = referer;
        }

        const withGeneratedAlt = ctx?.req.get('x-with-generated-alt');
        if (withGeneratedAlt !== undefined) {
            instance.withGeneratedAlt = Boolean(withGeneratedAlt);
        }
        const withLinksSummary = ctx?.req.get('x-with-links-summary');
        if (withLinksSummary !== undefined) {
            instance.withLinksSummary = Boolean(withLinksSummary);
        }
        const withImagesSummary = ctx?.req.get('x-with-images-summary');
        if (withImagesSummary !== undefined) {
            instance.withImagesSummary = Boolean(withImagesSummary);
        }
        const retainImages = ctx?.req.get('x-retain-images');
        if (retainImages && IMAGE_RETENTION_MODE_VALUES.has(retainImages)) {
            instance.retainImages = retainImages as any;
        }
        if (instance.withGeneratedAlt) {
            instance.retainImages = 'all_p';
        }
        const noCache = ctx?.req.get('x-no-cache');
        if (noCache !== undefined) {
            instance.noCache = Boolean(noCache);
        }
        if (instance.noCache && instance.cacheTolerance === undefined) {
            instance.cacheTolerance = 0;
        }
        let cacheTolerance = parseInt(ctx?.req.get('x-cache-tolerance') || '');
        if (!isNaN(cacheTolerance)) {
            instance.cacheTolerance = cacheTolerance;
        }

        const noGfm = ctx?.req.get('x-no-gfm');
        if (noGfm) {
            instance.noGfm = noGfm === 'table' ? noGfm : Boolean(noGfm);
        }

        let timeoutSeconds = parseInt(ctx?.req.get('x-timeout') || '');
        if (!isNaN(timeoutSeconds) && timeoutSeconds > 0) {
            instance.timeout = timeoutSeconds <= 180 ? timeoutSeconds : 180;
        } else if (ctx?.req.get('x-timeout')) {
            instance.timeout = null;
        }

        const removeSelector = ctx?.req.get('x-remove-selector')?.split(', ');
        instance.removeSelector ??= removeSelector;
        const targetSelector = ctx?.req.get('x-target-selector')?.split(', ');
        instance.targetSelector ??= targetSelector;
        const waitForSelector = ctx?.req.get('x-wait-for-selector')?.split(', ');
        instance.waitForSelector ??= waitForSelector || instance.targetSelector;
        instance.targetSelector = filterSelector(instance.targetSelector);
        const overrideUserAgent = ctx?.req.get('x-user-agent');
        instance.userAgent ??= overrideUserAgent;

        const keepImgDataUrl = ctx?.req.get('x-keep-img-data-url');
        if (keepImgDataUrl !== undefined) {
            instance.keepImgDataUrl = Boolean(keepImgDataUrl);
        }
        const withIframe = ctx?.req.get('x-with-iframe');
        if (withIframe !== undefined) {
            instance.withIframe = withIframe.toLowerCase() === 'quoted' ? 'quoted' : Boolean(withIframe);
        }
        if (instance.withIframe) {
            instance.timeout ??= null;
        }
        const withShadowDom = ctx?.req.get('x-with-shadow-dom');
        if (withShadowDom) {
            instance.withShadowDom = Boolean(withShadowDom);
        }
        if (instance.withShadowDom) {
            instance.timeout ??= null;
        }

        const cookies: Cookie[] = [];
        const setCookieHeaders = ctx?.req.get('x-set-cookie')?.split(', ') || (instance.setCookies as any as string[]);
        if (Array.isArray(setCookieHeaders)) {
            for (const setCookie of setCookieHeaders) {
                cookies.push({
                    ...parseSetCookieString(setCookie, { decodeValues: true }),
                });
            }
        } else if (setCookieHeaders && typeof setCookieHeaders === 'string') {
            cookies.push({
                ...parseSetCookieString(setCookieHeaders, { decodeValues: true }),
            });
        }
        instance.setCookies = cookies;

        const proxyUrl = ctx?.req.get('x-proxy-url');
        instance.proxyUrl ??= proxyUrl;

        if (instance.cacheTolerance) {
            instance.cacheTolerance = instance.cacheTolerance * 1000;
        }

        return instance;
    }

    isEarlyReturnApplicable() {
        if (this.timeout !== undefined) {
            return false;
        }
        if (this.waitForSelector?.length) {
            return false;
        }
        if (this.injectFrameScript?.length || this.injectPageScript?.length) {
            return false;
        }

        return true;
    }

    isCacheQueryApplicable() {
        if (this.noCache) {
            return false;
        }
        if (this.cacheTolerance === 0) {
            return false;
        }
        if (this.setCookies?.length) {
            return false;
        }
        if (this.injectFrameScript?.length || this.injectPageScript?.length) {
            return false;
        }

        return true;
    }

    isRequestingCompoundContentFormat() {
        return !CONTENT_FORMAT_VALUES.has(this.respondWith);
    }
}

export class CrawlerOptionsHeaderOnly extends CrawlerOptions {
    static override from(input: any) {
        const instance = super.from({
            [RPC_CALL_ENVIRONMENT]: Reflect.get(input, RPC_CALL_ENVIRONMENT),
        }) as CrawlerOptionsHeaderOnly;

        return instance;
    }
}

function filterSelector(s?: string | string[]) {
    if (!s) {
        return s;
    }
    const sr = Array.isArray(s) ? s : [s];
    const selectors = sr.filter((i) => {
        const innerSelectors = i.split(',').map((s) => s.trim());
        const someViolation = innerSelectors.find((x) => x.startsWith('*') || x.startsWith(':') || x.includes('*:'));
        if (someViolation) {
            return false;
        }
        return true;
    });

    return selectors;
};
