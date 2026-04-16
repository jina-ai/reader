import { injectable } from 'tsyringe';
// import { InternalCloudRunReaderLM2 } from '../../3rd-party/internal-cloudrun';
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
export class ReaderLM2 extends ChatGPT0613 {
    static override description = 'JinaAI ReaderLM-v2';
    static override aliases = [
        'readerlm-v2'
    ];

    static override streamingSupported = true;
    static override chatOptimized = true;
    static override systemSupported = true;
    static override modelOptionsType = ReaderLMOptions;
    static override windowSize = ReaderLMOptions.windowSize;
    static override nSupported = false;
    static override functionCalling = 'none' as const;

    static override modelName = 'readerlm-v2';
    static override visionEnabled: boolean = false;

    override async init() {
        await this.dependencyReady();
        this.clients = [
            // new InternalCloudRunReaderLM2(this.envConfig.READER_LM2_DEPLOYMENT_API_KEY)
        ];
        this.emit('ready');
    }
}
