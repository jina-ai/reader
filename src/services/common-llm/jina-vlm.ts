import { injectable } from 'tsyringe';
import { ChatGPT0613, ChatGPTModelOptions } from './gpt-35';
import { Prop } from 'civkit/civ-rpc';


export class ReaderLMOptions extends ChatGPTModelOptions {
    static override windowSize = Math.floor(512000 * 0.8);

    @Prop({
        default: 1.05,
    })
    repetition_penalty?: number;
}

@injectable()
export class JinaVLM extends ChatGPT0613 {
    static override description = 'JinaAI Jina-VLM';
    static override aliases = [
        'jina-vlm'
    ];

    static override streamingSupported = true;
    static override chatOptimized = true;
    static override modelOptionsType = ReaderLMOptions;
    static override windowSize = ReaderLMOptions.windowSize;
    static override nSupported = false;
    static override functionCalling = 'none' as const;
    static override interleavedPromptSupported = true;

    static override modelName = 'jina-vlm';
    static override visionEnabled: boolean = true;

    override async init() {
        await this.dependencyReady();
        this.clients = [
            // new InternalCloudRunJinaVLM(this.envConfig.JINA_VLM_DEPLOYMENT_API_KEY)
        ];
        this.emit('ready');
    }
}
