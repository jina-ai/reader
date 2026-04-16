import 'reflect-metadata';
import { injectable, container } from 'tsyringe';
import { AsyncService } from 'civkit/async-service';
import { GlobalLogger } from '../services/logger';
import { LLMManager } from '../services/common-llm';
import { AltTextService } from '../services/alt-text';

@injectable()
export class Hello extends AsyncService {
    logger = this.globalLogger.child({ service: this.constructor.name });

    constructor(
        protected globalLogger: GlobalLogger,
        protected llmManager: LLMManager,
        protected altTextService: AltTextService,
    ) {
        super(...arguments);
    }

    override async init() {
        await this.dependencyReady();

        await this.llmManager.importOpenRouterModel('google/gemini-2.5-flash-lite');

        this.emit('ready');
    }

    async main() {
        await this.serviceReady();

        const r = await this.altTextService.caption('https://jina-ai-gmbh.ghost.io/content/images/2025/09/banner_code_embeddings.png');

        this.logger.info(`Alt text: ${r}`);

        // const r = await this.llmManager.run('google/gemini-2.5-flash-lite', {
        //     prompt: interleavedPrompt`${new URL('https://img.freepik.com/free-photo/closeup-scarlet-macaw-from-side-view-scarlet-macaw-closeup-head_488145-3540.jpg?semt=ais_incoming&w=740&q=80')}\nWhat is this`,
        //     options: {
        //         stream: true,
        //     }
        // });

        // r.on('data', (chunk) => {
        //     this.logger.info(`LLM: ${chunk}`);
        // });

        // await once(r, 'end');
    }
}

const instance = container.resolve(Hello);
export default instance;

if (require.main === module) {
    instance.main().finally(() => process.exit(0));
}