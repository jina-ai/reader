import { assignTransferProtocolMeta, marshalErrorLike, RPCHost, RPCReflection, AssertionFailureError, ParamValidationError } from 'civkit';
import { singleton } from 'tsyringe';
import { CloudHTTPv2, Ctx, Logger, OutputServerEventStream, RPCReflect } from '../shared';
import _ from 'lodash';
import { PageSnapshot, PuppeteerControl } from '../services/puppeteer';
import TurnDownService from 'turndown';
import { Request, Response } from 'express';
import normalizeUrl from "@esm2cjs/normalize-url";

type ImageInfo = {
  original: string;
  alt: string;
  src: string;
  isLinked: boolean;
  linkUrl?: string;
};

async function captionImages(markdown: string): Promise<string> {
  const imageRegex = /(!\[([^\]]*)\]\(([^)\s]+)(?:\s"[^"]*")?\))(\](?:\(([^\)]+)\)))?/g;
  let updatedMarkdown = markdown;
  const images: ImageInfo[] = [];

  // Extracting all images and their details from the markdown
  let match: RegExpExecArray | null;
  while ((match = imageRegex.exec(markdown))) {
    const isLinked = !!match[4]; // Check if image is linked
    const imageInfo: ImageInfo = {
      original: match[0],
      alt: match[2],
      src: match[3],
      isLinked: isLinked,
      linkUrl: isLinked ? match[5] : undefined
    };
    images.push(imageInfo);
  }

  // Filtering images with missing alt text
  const imagesWithMissingAlt = images.filter(image => image.alt.trim() === '');

  // Captioning images in parallel
  const captionPromises = imagesWithMissingAlt.map((image, index) =>
    captionImage(image.src).then(caption => ({
      ...image,
      alt: `Image ${index + 1}: ${caption}`
    }))
  );

  const captionedImages = await Promise.all(captionPromises);

  // Replacing the old markdown image syntax with new captions
  captionedImages.forEach(image => {
    const imageMarkdown = image.isLinked
      ? `[![${image.alt}](${image.src})](${image.linkUrl})`
      : `![${image.alt}](${image.src})`;
    updatedMarkdown = updatedMarkdown.replace(image.original, imageMarkdown);
  });

  return updatedMarkdown;
}

// calling blip2 or whatever faster
async function captionImage(url: string): Promise<string> {
  // TODO: This function should return a caption for the given URL
  // @yanlong
  return Promise.resolve(`Caption for ${url}`);
}

function tidyMarkdown(markdown: string): string {

    // Step 1: Handle complex broken links with text and optional images spread across multiple lines
    let normalizedMarkdown = markdown.replace(/\[\s*([^]+?)\s*\]\s*\(\s*([^)]+)\s*\)/g, (match, text, url) => {
        // Remove internal new lines and excessive spaces within the text
        text = text.replace(/\s+/g, ' ').trim();
        url = url.replace(/\s+/g, '').trim();
        return `[${text}](${url})`;
    });

    normalizedMarkdown = normalizedMarkdown.replace(/\[\s*([^!]*?)\s*\n*(?:!\[([^\]]*)\]\((.*?)\))?\s*\n*\]\s*\(\s*([^)]+)\s*\)/g, (match, text, alt, imgUrl, linkUrl) => {
        // Normalize by removing excessive spaces and new lines
        text = text.replace(/\s+/g, ' ').trim();
        alt = alt ? alt.replace(/\s+/g, ' ').trim() : '';
        imgUrl = imgUrl ? imgUrl.replace(/\s+/g, '').trim() : '';
        linkUrl = linkUrl.replace(/\s+/g, '').trim();
        if (imgUrl) {
            return `[${text} ![${alt}](${imgUrl})](${linkUrl})`;
        } else {
            return `[${text}](${linkUrl})`;
        }
    });

    // Step 2: Normalize regular links that may be broken across lines
    normalizedMarkdown = normalizedMarkdown.replace(/\[\s*([^\]]+)\]\s*\(\s*([^)]+)\)/g, (match, text, url) => {
        text = text.replace(/\s+/g, ' ').trim();
        url = url.replace(/\s+/g, '').trim();
        return `[${text}](${url})`;
    });

    // Step 3: Replace more than two consecutive empty lines with exactly two empty lines
    normalizedMarkdown = normalizedMarkdown.replace(/\n{3,}/g, '\n\n');

    // Step 4: Remove leading spaces from each line
    normalizedMarkdown = normalizedMarkdown.replace(/^[ \t]+/gm, '');

    return normalizedMarkdown.trim();
}

@singleton()
export class CrawlerHost extends RPCHost {
    logger = this.globalLogger.child({ service: this.constructor.name });

    turnDownService = new TurnDownService().use(require('turndown-plugin-gfm').gfm);

    constructor(
        protected globalLogger: Logger,
        protected puppeteerControl: PuppeteerControl,
    ) {
        super(...arguments);
    }

    override async init() {
        await this.dependencyReady();

        this.emit('ready');
    }

    formatSnapshot(snapshot: PageSnapshot) {

        const toBeTurnedToMd = snapshot.parsed?.content;
        const turnedDown = toBeTurnedToMd ? this.turnDownService.turndown(toBeTurnedToMd).trim() : '';

        const contentText = turnedDown && !(turnedDown.startsWith('<') && turnedDown.endsWith('>')) ? turnedDown : snapshot.text?.trim();

        const cleanText = tidyMarkdown(contentText).trim();

        const captionedText = captionImages(cleanText);

        const formatted = {
            title: (snapshot.parsed?.title || snapshot.title || '').trim(),
            url: snapshot.href?.trim(),
            content: captionedText,

            toString() {
                return `Title: ${this.title}

URL Source: ${this.url}

Markdown Content:
${this.content}
`;
            }
        };

        return formatted;
    }

    @CloudHTTPv2({
        name: 'crawl2',
        runtime: {
            memory: '4GiB',
            timeoutSeconds: 540,
            concurrency: 4,
        },
        httpMethod: ['get', 'post'],
        returnType: [String, OutputServerEventStream],
    })
    @CloudHTTPv2({
        runtime: {
            memory: '8GiB',
            timeoutSeconds: 540,
            concurrency: 16,
        },
        httpMethod: ['get', 'post'],
        returnType: [String, OutputServerEventStream],
    })
    async crawl(
        @RPCReflect() rpcReflect: RPCReflection,
        @Ctx() ctx: {
            req: Request,
            res: Response,
        },
    ) {
        const noSlashURL = ctx.req.url.slice(1);
        let urlToCrawl;
        try {
            urlToCrawl = new URL(normalizeUrl(noSlashURL.trim()));
        } catch (err) {
            throw new ParamValidationError({
                message: `${err}`,
                path: 'url'
            });
        }
        const screenshotEnabled = Boolean(ctx.req.headers['x-screenshot']);
        const noCache = Boolean(ctx.req.headers['x-no-cache']);

        if (!ctx.req.accepts('text/plain') && ctx.req.accepts('text/event-stream')) {
            const sseStream = new OutputServerEventStream();
            rpcReflect.return(sseStream);

            try {
                for await (const scrapped of this.puppeteerControl.scrap(urlToCrawl.toString(), noCache)) {
                    if (!scrapped) {
                        continue;
                    }

                    const formatted = this.formatSnapshot(scrapped);

                    if (scrapped.screenshot && screenshotEnabled) {
                        sseStream.write({
                            event: 'screenshot',
                            data: scrapped.screenshot.toString('base64'),
                        });
                    }

                    sseStream.write({
                        event: 'data',
                        data: formatted,
                    });
                }
            } catch (err: any) {
                this.logger.error(`Failed to crawl ${urlToCrawl.toString()}`, { err: marshalErrorLike(err) });
                sseStream.write({
                    event: 'error',
                    data: marshalErrorLike(err),
                });
            }

            sseStream.end();

            return sseStream;
        }

        let lastScrapped;
        if (!ctx.req.accepts('text/plain') && (ctx.req.accepts('text/json') || ctx.req.accepts('application/json'))) {
            for await (const scrapped of this.puppeteerControl.scrap(urlToCrawl.toString(), noCache)) {
                lastScrapped = scrapped;
                if (!scrapped?.parsed?.content || !(scrapped.title?.trim())) {
                    continue;
                }

                const formatted = this.formatSnapshot(scrapped);

                return formatted;
            }

            if (!lastScrapped) {
                throw new AssertionFailureError(`No content available for URL ${urlToCrawl}`);
            }

            return this.formatSnapshot(lastScrapped);
        }

        for await (const scrapped of this.puppeteerControl.scrap(urlToCrawl.toString(), noCache)) {
            lastScrapped = scrapped;
            if (!scrapped?.parsed?.content || !(scrapped.title?.trim())) {
                continue;
            }

            const formatted = this.formatSnapshot(scrapped);

            return assignTransferProtocolMeta(`${formatted}`, { contentType: 'text/plain', envelope: null });
        }

        if (!lastScrapped) {
            throw new AssertionFailureError(`No content available for URL ${urlToCrawl}`);
        }

        return `${this.formatSnapshot(lastScrapped)}`;
    }


}
