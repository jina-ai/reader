import { AsyncService } from 'civkit/async-service';
import { singleton } from 'tsyringe';

import { PageSnapshot } from './puppeteer';
import { Logger } from '../shared/services/logger';
import _ from 'lodash';
import { AssertionFailureError } from 'civkit';
import { LLMManager } from '../shared/services/common-llm';
import { JSDomControl } from './jsdom';

const tripleBackTick = '```';

@singleton()
export class LmControl extends AsyncService {

    logger = this.globalLogger.child({ service: this.constructor.name });

    constructor(
        protected globalLogger: Logger,
        protected commonLLM: LLMManager,
        protected jsdomControl: JSDomControl,
    ) {
        super(...arguments);
    }

    override async init() {
        await this.dependencyReady();

        this.emit('ready');
    }

    async* geminiFromBrowserSnapshot(snapshot?: PageSnapshot & {
        pageshotUrl?: string,
    }) {
        const pageshot = snapshot?.pageshotUrl || snapshot?.pageshot;

        if (!pageshot) {
            throw new AssertionFailureError('Screenshot of the page is not available');
        }

        const html = await this.jsdomControl.cleanHTMLforLMs(snapshot.html, 'script,link,style,textarea,select>option,svg')

        const it = this.commonLLM.iterRun('vertex-gemini-1.5-flash-002', {
            prompt: [
                `HTML: \n${html}\n\nSCREENSHOT: \n`,
                typeof pageshot === 'string' ? new URL(pageshot) : pageshot,
                `Convert this webpage into a markdown source file that does not contain HTML tags, retaining the page language and visual structures.`,
            ],

            options: {
                system: 'You are ReaderLM-v7, a model that generates Markdown source files only. No HTML, notes and chit-chats allowed',
                stream: true
            }
        });

        const chunks: string[] = [];
        for await (const txt of it) {
            chunks.push(txt);
            const output: PageSnapshot = {
                ...snapshot,
                parsed: {
                    ...snapshot?.parsed,
                    textContent: chunks.join(''),
                }
            };
            yield output;
        }

        return;
    }

    async* readerLMMarkdownFromSnapshot(snapshot?: PageSnapshot) {
        if (!snapshot) {
            throw new AssertionFailureError('Snapshot of the page is not available');
        }

        const html = await this.jsdomControl.cleanHTMLforLMs(snapshot.html, 'script,link,style,textarea,select>option,svg');

        const it = this.commonLLM.iterRun('readerlm-v2', {
            prompt: `Extract the main content from the given HTML and convert it to Markdown format.\n\n${tripleBackTick}html\n${html}\n${tripleBackTick}\n`,

            options: {
                // system: 'You are an AI assistant developed by Jina AI',
                stream: true
            }
        });

        const chunks: string[] = [];
        for await (const txt of it) {
            chunks.push(txt);
            const output: PageSnapshot = {
                ...snapshot,
                parsed: {
                    ...snapshot?.parsed,
                    textContent: chunks.join(''),
                }
            };
            yield output;
        }

        return;
    }

    async* readerLMFromSnapshot(schema?: string, instruction: string = 'Infer useful information from the HTML and present it in a structured JSON object.', snapshot?: PageSnapshot) {
        if (!snapshot) {
            throw new AssertionFailureError('Snapshot of the page is not available');
        }

        const html = await this.jsdomControl.cleanHTMLforLMs(snapshot.html, 'script,link,style,textarea,select>option,svg');

        const it = this.commonLLM.iterRun('readerlm-v2', {
            prompt: `${instruction}\n\n${tripleBackTick}html\n${html}\n${tripleBackTick}\n${schema ? `The JSON schema:\n${tripleBackTick}json\n${schema}\n${tripleBackTick}\n` : ''}`,
            options: {
                // system: 'You are an AI assistant developed by Jina AI',
                stream: true
            }
        });

        const chunks: string[] = [];
        for await (const txt of it) {
            chunks.push(txt);
            const output: PageSnapshot = {
                ...snapshot,
                parsed: {
                    ...snapshot?.parsed,
                    textContent: chunks.join(''),
                }
            };
            yield output;
        }

        return;
    }
}
