import { Also, AutoCastable, ParamValidationError, Prop, RPC_CALL_ENVIRONMENT } from 'civkit'; // Adjust the import based on where your decorators are defined
import type { Request, Response } from 'express';
import { Cookie, parseString as parseSetCookieString } from 'set-cookie-parser';

export enum CONTENT_FORMAT {
    CONTENT = 'content',
    MARKDOWN = 'markdown',
    HTML = 'html',
    TEXT = 'text',
    PAGESHOT = 'pageshot',
    SCREENSHOT = 'screenshot',
    VLM = 'vlm',
    READER_LM = 'readerlm-v2',
}

export enum ENGINE_TYPE {
    AUTO = 'auto',
    BROWSER = 'browser',
    DIRECT = 'direct',
    VLM = 'vlm',
    READER_LM = 'readerlm-v2',
}

const CONTENT_FORMAT_VALUES = new Set<string>(Object.values(CONTENT_FORMAT));

export const IMAGE_RETENTION_MODES = ['none', 'all', 'alt', 'all_p', 'alt_p'] as const;
const IMAGE_RETENTION_MODE_VALUES = new Set<string>(IMAGE_RETENTION_MODES);
export const BASE_URL_MODES = ['initial', 'final'] as const;
const BASE_URL_MODE_VALUES = new Set<string>(BASE_URL_MODES);

class Viewport extends AutoCastable {
    @Prop({
        default: 1024
    })
    width!: number;
    @Prop({
        default: 1024
    })
    height!: number;
    @Prop()
    deviceScaleFactor?: number;
    @Prop()
    isMobile?: boolean;
    @Prop()
    isLandscape?: boolean;
    @Prop()
    hasTouch?: boolean;
}

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
                },
                'X-Token-Budget': {
                    description: 'Specify a budget in tokens.\n\nIf the resulting token cost exceeds the budget, the request is rejected.',
                    in: 'header',
                    schema: { type: 'string' }
                },
                'X-Engine': {
                    description: 'Specify the engine to use for crawling.\n\nSupported: browser, direct, vlm, readerlm-v2',
                    in: 'header',
                    schema: { type: 'string' }
                },
                'X-Base': {
                    description: 'Select base modes of relative URLs.\n\nSupported: initial, final',
                    in: 'header',
                    schema: { type: 'string' }
                },
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
        type: BASE_URL_MODE_VALUES,
        default: 'initial',
    })
    base?: typeof BASE_URL_MODES[number];

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
    withLinksSummary!: boolean | string;

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

    @Prop()
    engine?: string;

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

    @Prop()
    tokenBudget?: number;

    @Prop()
    viewport?: Viewport;

    @Prop()
    instruction?: string;

    @Prop()
    jsonSchema?: object;

    @Prop()
    version?: number;

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
        if (instance.respondWith) {
            instance.respondWith = instance.respondWith.toLowerCase();
        }
        if (instance.respondWith?.includes('lm')) {
            if (instance.respondWith.includes('content') || instance.respondWith.includes('markdown')) {
                throw new ParamValidationError({
                    path: 'respondWith',
                    message: `LM formats conflicts with content/markdown.`,
                });
            }
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
            if (withLinksSummary === 'all') {
                instance.withLinksSummary = withLinksSummary;
            } else {
                instance.withLinksSummary = Boolean(withLinksSummary);
            }
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

        const engine = ctx?.req.get('x-engine');
        if (engine) {
            instance.engine = engine;
        }
        if (instance.engine) {
            instance.engine = instance.engine.toLowerCase();
        }
        if (instance.engine === ENGINE_TYPE.VLM) {
            instance.engine = ENGINE_TYPE.BROWSER;
            instance.respondWith = CONTENT_FORMAT.VLM;
        } else if (instance.engine === ENGINE_TYPE.READER_LM) {
            instance.engine = ENGINE_TYPE.AUTO;
            instance.respondWith = CONTENT_FORMAT.READER_LM;
        }

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

        const tokenBudget = ctx?.req.get('x-token-budget') || undefined;
        instance.tokenBudget ??= parseInt(tokenBudget || '') || undefined;

        const baseMode = ctx?.req.get('x-base') || undefined;
        if (baseMode) {
            instance.base = baseMode as any;
        }

        if (instance.cacheTolerance) {
            instance.cacheTolerance = instance.cacheTolerance * 1000;
        }

        const version = ctx?.req.get('x-version');
        if (version) {
            const versionNum = Number(version.replace('v', ''));
            instance.version = isNaN(versionNum) ? undefined : versionNum;
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
        if (this.respondWith.includes('lm')) {
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
        if (this.viewport) {
            return false;
        }

        return true;
    }

    isRequestingCompoundContentFormat() {
        return !CONTENT_FORMAT_VALUES.has(this.respondWith);
    }

    browserIsNotRequired() {
        if (this.respondWith.includes(CONTENT_FORMAT.PAGESHOT) || this.respondWith.includes(CONTENT_FORMAT.SCREENSHOT)) {
            return false;
        }
        if (this.injectFrameScript?.length || this.injectPageScript?.length) {
            return false;
        }
        if (this.waitForSelector?.length) {
            return false;
        }
        if (this.withIframe || this.withShadowDom) {
            return false;
        }
        if (this.viewport) {
            return false;
        }
        if (this.pdf) {
            return false;
        }
        if (this.html) {
            return false;
        }

        return true;
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
