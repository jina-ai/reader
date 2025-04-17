import { Also, AutoCastable, ParamValidationError, Prop, RPC_CALL_ENVIRONMENT } from 'civkit/civ-rpc';
import { FancyFile } from 'civkit/fancy-file';
import { Cookie, parseString as parseSetCookieString } from 'set-cookie-parser';
import { Context } from '../services/registry';
import { TurnDownTweakableOptions } from './turndown-tweakable-options';
import type { PageSnapshot } from '../services/puppeteer';

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
    CURL = 'curl',
    CF_BROWSER_RENDERING = 'cf-browser-rendering',
}

export enum RESPOND_TIMING {
    HTML = 'html',
    VISIBLE_CONTENT = 'visible-content',
    MUTATION_IDLE = 'mutation-idle',
    RESOURCE_IDLE = 'resource-idle',
    MEDIA_IDLE = 'media-idle',
    NETWORK_IDLE = 'network-idle',
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
                    description: `Specifies the (non-default) form of the crawled data you prefer.\n\n` +
                        `Supported formats: \n` +
                        `- markdown\n` +
                        `- html\n` +
                        `- text\n` +
                        `- pageshot\n` +
                        `- screenshot\n` +
                        `- content\n` +
                        `- any combination of the above\n` +
                        `- readerlm-v2\n` +
                        `- vlm\n\n` +
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
                'X-Proxy': {
                    description: `Use a proxy server provided by us.\n\nOptionally specify two-letter country code.`,
                    in: 'header',
                    schema: { type: 'string' }
                },
                'X-Robots-Txt': {
                    description: `Load and conform to the respective robot.txt on the target origin.\n\nOptionally specify a bot UA to check against.\n\n`,
                    in: 'header',
                    schema: { type: 'string' }
                },
                'DNT': {
                    description: `When set to 1, prevent the result of this request to be cached in the system.\n\n`,
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
                'X-Respond-Timing': {
                    description: `Explicitly specify the respond timing. One of the following:\n\n` +
                        `- html: directly return unrendered HTML\n` +
                        `- visible-content: return immediately when any content becomes available\n` +
                        `- mutation-idle: wait for DOM mutations to settle and remain unchanged for at least 0.2s\n` +
                        `- resource-idle: wait for no additional resources that would affect page logic and content has SUCCEEDED loading in 0.5s\n` +
                        `- media-idle: wait for no additional resources, including media resources, has SUCCEEDED loading in 0.5s\n` +
                        `- network-idle: wait for full load of webpage, also known as networkidle0.\n\n`,
                    in: 'header',
                    schema: { type: 'string' }
                },
                'X-Engine': {
                    description: 'Specify the engine to use for crawling.\n\nSupported: browser, direct, cf-browser-rendering',
                    in: 'header',
                    schema: { type: 'string' }
                },
                'X-Base': {
                    description: 'Select base modes of relative URLs.\n\nSupported: initial, final',
                    in: 'header',
                    schema: { type: 'string' }
                },
                'X-Md-Heading-Style': {
                    description: 'Heading style of the generated markdown.\n\nThis is an option passed through to [Turndown](https://github.com/mixmark-io/turndown?tab=readme-ov-file#options).\n\nSupported: setext, atx',
                    in: 'header',
                    schema: { type: 'string' }
                },
                'X-Md-Hr': {
                    description: 'Hr text of the generated markdown.\n\nThis is an option passed through to [Turndown](https://github.com/mixmark-io/turndown?tab=readme-ov-file#options).',
                    in: 'header',
                    schema: { type: 'string' }
                },
                'X-Md-Bullet-List-Marker': {
                    description: 'Bullet list marker of the generated markdown.\n\nThis is an option passed through to [Turndown](https://github.com/mixmark-io/turndown?tab=readme-ov-file#options).\n\nSupported: -, +, *',
                    in: 'header',
                    schema: { type: 'string' }
                },
                'X-Md-Em-Delimiter': {
                    description: 'Em delimiter of the generated markdown.\n\nThis is an option passed through to [Turndown](https://github.com/mixmark-io/turndown?tab=readme-ov-file#options).\n\nSupported: _, *',
                    in: 'header',
                    schema: { type: 'string' }
                },
                'X-Md-Strong-Delimiter': {
                    description: 'Strong delimiter of the generated markdown.\n\nThis is an option passed through to [Turndown](https://github.com/mixmark-io/turndown?tab=readme-ov-file#options).\n\nSupported: **, __',
                    in: 'header',
                    schema: { type: 'string' }
                },
                'X-Md-Link-Style': {
                    description: 'Link style of the generated markdown.\n\nThis is an option passed through to [Turndown](https://github.com/mixmark-io/turndown?tab=readme-ov-file#options).\n\nSupported: inlined, referenced, discarded',
                    in: 'header',
                    schema: { type: 'string' }
                },
                'X-Md-Link-Reference-Style': {
                    description: 'Link reference style of the generated markdown.\n\nThis is an option passed through to [Turndown](https://github.com/mixmark-io/turndown?tab=readme-ov-file#options).\n\nSupported: full, collapsed, shortcut, discarded',
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
        type: [FancyFile, String]
    })
    pdf?: FancyFile | string;

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
    proxy?: string;

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
    robotsTxt?: string;

    @Prop()
    doNotTrack?: number | null;

    @Prop()
    markdown?: TurnDownTweakableOptions;

    @Prop({
        type: RESPOND_TIMING,
    })
    respondTiming?: RESPOND_TIMING;

    _hintIps?: string[];

    static override from(input: any) {
        const instance = super.from(input) as CrawlerOptions;
        const ctx = Reflect.get(input, RPC_CALL_ENVIRONMENT) as Context | undefined;

        const customMode = ctx?.get('x-respond-with') || ctx?.get('x-return-format');
        if (customMode) {
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

        const locale = ctx?.get('x-locale');
        if (locale) {
            instance.locale = locale;
        }

        const referer = ctx?.get('x-referer');
        if (referer) {
            instance.referer = referer;
        }

        const withGeneratedAlt = ctx?.get('x-with-generated-alt');
        if (withGeneratedAlt) {
            instance.withGeneratedAlt = Boolean(withGeneratedAlt);
        }
        const withLinksSummary = ctx?.get('x-with-links-summary');
        if (withLinksSummary) {
            if (withLinksSummary === 'all') {
                instance.withLinksSummary = withLinksSummary;
            } else {
                instance.withLinksSummary = Boolean(withLinksSummary);
            }
        }
        const withImagesSummary = ctx?.get('x-with-images-summary');
        if (withImagesSummary) {
            instance.withImagesSummary = Boolean(withImagesSummary);
        }
        const retainImages = ctx?.get('x-retain-images');
        if (retainImages && IMAGE_RETENTION_MODE_VALUES.has(retainImages)) {
            instance.retainImages = retainImages as any;
        }
        if (instance.withGeneratedAlt) {
            instance.retainImages = 'all_p';
        }
        const noCache = ctx?.get('x-no-cache');
        if (noCache) {
            instance.noCache = Boolean(noCache);
        }
        if (instance.noCache && instance.cacheTolerance === undefined) {
            instance.cacheTolerance = 0;
        }
        let cacheTolerance = parseInt(ctx?.get('x-cache-tolerance') || '');
        if (!isNaN(cacheTolerance)) {
            instance.cacheTolerance = cacheTolerance;
        }

        const noGfm = ctx?.get('x-no-gfm');
        if (noGfm) {
            instance.noGfm = noGfm === 'table' ? noGfm : Boolean(noGfm);
        }

        let timeoutSeconds = parseInt(ctx?.get('x-timeout') || '');
        if (!isNaN(timeoutSeconds) && timeoutSeconds > 0) {
            instance.timeout = timeoutSeconds <= 180 ? timeoutSeconds : 180;
        } else if (ctx?.get('x-timeout')) {
            instance.timeout = null;
        }

        const removeSelector = ctx?.get('x-remove-selector')?.split(', ').filter(Boolean);
        instance.removeSelector ??= removeSelector?.length ? removeSelector : undefined;
        const targetSelector = ctx?.get('x-target-selector')?.split(', ').filter(Boolean);
        instance.targetSelector ??= targetSelector?.length ? targetSelector : undefined;
        const waitForSelector = ctx?.get('x-wait-for-selector')?.split(', ').filter(Boolean);
        instance.waitForSelector ??= (waitForSelector?.length ? waitForSelector : undefined) || instance.targetSelector;
        const overrideUserAgent = ctx?.get('x-user-agent') || undefined;
        instance.userAgent ??= overrideUserAgent;

        const engine = ctx?.get('x-engine');
        if (engine) {
            instance.engine = engine;
        }
        if (instance.engine) {
            instance.engine = instance.engine.toLowerCase();
        }
        if (instance.engine === 'vlm') {
            instance.engine = ENGINE_TYPE.BROWSER;
            instance.respondWith = CONTENT_FORMAT.VLM;
        } else if (instance.engine === 'readerlm-v2') {
            instance.engine = ENGINE_TYPE.AUTO;
            instance.respondWith = CONTENT_FORMAT.READER_LM;
        }

        const keepImgDataUrl = ctx?.get('x-keep-img-data-url');
        if (keepImgDataUrl) {
            instance.keepImgDataUrl = Boolean(keepImgDataUrl);
        }
        const withIframe = ctx?.get('x-with-iframe');
        if (withIframe) {
            instance.withIframe = withIframe.toLowerCase() === 'quoted' ? 'quoted' : Boolean(withIframe);
        }
        if (instance.withIframe) {
            instance.timeout ??= null;
        }
        const withShadowDom = ctx?.get('x-with-shadow-dom');
        if (withShadowDom) {
            instance.withShadowDom = Boolean(withShadowDom);
        }
        if (instance.withShadowDom) {
            instance.timeout ??= null;
        }

        const cookies: Cookie[] = [];
        const setCookieHeaders = (ctx?.get('x-set-cookie')?.split(', ') || (instance.setCookies as any as string[])).filter(Boolean);
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

        const proxyUrl = ctx?.get('x-proxy-url');
        instance.proxyUrl ??= proxyUrl || undefined;
        const proxy = ctx?.get('x-proxy');
        instance.proxy ??= proxy || undefined;
        const robotsTxt = ctx?.get('x-robots-txt');
        instance.robotsTxt ??= robotsTxt || undefined;

        const tokenBudget = ctx?.get('x-token-budget');
        instance.tokenBudget ??= parseInt(tokenBudget || '') || undefined;

        const baseMode = ctx?.get('x-base');
        if (baseMode) {
            instance.base = baseMode as any;
        }

        const dnt = ctx?.get('dnt');
        instance.doNotTrack ??= (parseInt(dnt || '') || null);

        const respondTiming = ctx?.get('x-respond-timing');
        if (respondTiming) {
            instance.respondTiming ??= respondTiming as RESPOND_TIMING;
        }

        if (instance.cacheTolerance) {
            instance.cacheTolerance = instance.cacheTolerance * 1000;
        }

        if (ctx) {
            instance.markdown ??= TurnDownTweakableOptions.fromCtx(ctx);
        }

        return instance;
    }

    get presumedRespondTiming() {
        if (this.respondTiming) {
            return this.respondTiming;
        }
        if (this.timeout && this.timeout >= 20) {
            return RESPOND_TIMING.NETWORK_IDLE;
        }
        if (this.respondWith.includes('shot') || this.respondWith.includes('vlm')) {
            return RESPOND_TIMING.MEDIA_IDLE;
        }

        return RESPOND_TIMING.RESOURCE_IDLE;
    }

    isSnapshotAcceptableForEarlyResponse(snapshot: PageSnapshot) {
        if (this.waitForSelector?.length) {
            return false;
        }
        const presumedTiming = this.presumedRespondTiming;
        if (presumedTiming === RESPOND_TIMING.MEDIA_IDLE && snapshot.lastMediaResourceLoaded && snapshot.lastMutationIdle) {
            const now = Date.now();
            if ((Math.max(snapshot.lastMediaResourceLoaded, snapshot.lastContentResourceLoaded || 0) + 500) < now) {
                return true;
            }
        }
        if ((this.respondWith.includes('vlm') || this.respondWith.includes('pageshot')) && !snapshot.pageshot) {
            return false;
        }
        if ((this.respondWith.includes('vlm') || this.respondWith.includes('screenshot')) && !snapshot.screenshot) {
            return false;
        }
        if (presumedTiming === RESPOND_TIMING.RESOURCE_IDLE && snapshot.lastContentResourceLoaded && snapshot.lastMutationIdle) {
            const now = Date.now();
            if ((snapshot.lastContentResourceLoaded + 500) < now) {
                return true;
            }
        }
        if (this.injectFrameScript?.length || this.injectPageScript?.length) {
            return false;
        }
        if (presumedTiming === RESPOND_TIMING.VISIBLE_CONTENT && snapshot.parsed?.content) {
            return true;
        }
        if (presumedTiming === RESPOND_TIMING.HTML && snapshot.html) {
            return true;
        }
        if (presumedTiming === RESPOND_TIMING.NETWORK_IDLE) {
            return false;
        }
        if (presumedTiming === RESPOND_TIMING.MUTATION_IDLE && snapshot.lastMutationIdle) {
            return true;
        }
        if (this.respondWith.includes('lm')) {
            return false;
        }
        if (this.withIframe) {
            return false;
        }

        return !snapshot.isIntermediate;
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
        if (this.respondTiming && ![RESPOND_TIMING.HTML, RESPOND_TIMING.VISIBLE_CONTENT].includes(this.respondTiming)) {
            return false;
        }
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