import { AsyncService } from 'civkit/async-service';
import { singleton } from 'tsyringe';

import { PageSnapshot } from './puppeteer';
import { Logger } from '../shared/services/logger';
import _ from 'lodash';
import { AssertionFailureError } from 'civkit';
import { LLMManager } from '../shared/services/common-llm';

@singleton()
export class VlmControl extends AsyncService {

    logger = this.globalLogger.child({ service: this.constructor.name });

    constructor(
        protected globalLogger: Logger,
        protected commonLLM: LLMManager
    ) {
        super(...arguments);
    }

    override async init() {
        await this.dependencyReady();

        this.emit('ready');
    }

    async* fromBrowserSnapshot(snapshot?: PageSnapshot & {
        pageshotUrl?: string,
    }) {
        const pageshot = snapshot?.pageshotUrl || snapshot?.pageshot;

        if (!pageshot) {
            throw new AssertionFailureError('Screenshot of the page is not available');
        }

        const it = this.commonLLM.iterRun('vertex-gemini-1.5-flash-002', {
            prompt: [
                typeof pageshot === 'string' ? new URL(pageshot) : pageshot,
                `Convert this webpage screenshot into a markdown source file that does not contain HTML tags, retaining the page language and visual structures.`,
            ],

            options: {
                system: 'You are Reader-LM-v7, an OCR model that generates Markdown source files only. No HTML, notes and chit-chats allowed',
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
