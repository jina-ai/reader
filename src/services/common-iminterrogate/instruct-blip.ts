import { AutoCastable, Prop } from 'civkit/civ-rpc';
import { ReplicateHTTP } from '../../3rd-party/replicate';
import _ from 'lodash';
import { injectable } from 'tsyringe';

import { AbstractImageInterrogationModel, ImageInterrogationOptions } from './base';
import { EnvConfig } from '../envconfig';
import { GlobalLogger } from '../logger';

export class ReplicateInstructBlipVicuna13bModelOptions extends AutoCastable {

    @Prop({
        desc: `Image prompt to send to the model.`,
        required: true
    })
    img!: string | Blob | Buffer;

    @Prop({
        desc: `Text prompt to send to the model.`,
        required: true,
        default: `Describe the image in great detail.`
    })
    prompt!: string;

    @Prop({
        desc: `Maximum number of tokens to generate. A word is generally 2-3 tokens`,
    })
    max_tokens?: number;

    @Prop({
        desc: `Adjusts randomness of outputs, greater than 1 is random and 0 is deterministic, 0.75 is a good starting value.`,
    })
    temperature?: number;

    @Prop({
        desc: `When decoding text, samples from the top p percentage of most likely tokens; lower to ignore less likely tokens`,
    })
    top_p?: number;

    @Prop({
        desc: `When decoding text, samples from the top k most likely tokens; lower to ignore less likely tokens. Defaults to 0 (no top-k sampling).`,
    })
    top_k?: number;

    @Prop({
        desc: `When > 0 and top_k > 1, penalizes new tokens based on their similarity to previous tokens. Can help minimize repitition while maintaining semantic coherence. Set to 0 to disable.`,
    })
    penalty_alpha?: number;

    @Prop({
        desc: `Penalty for repeated words in generated text; 1 is no penalty, values greater than 1 discourage repetition, less than 1 encourage it.`,
    })
    repetition_penalty?: number;

    @Prop({
        desc: `Increasing the length_penalty parameter above 1.0 will cause the model to favor longer sequences, while decreasing it below 1.0 will cause the model to favor shorter sequences.`,
    })
    length_penalty?: number;

    @Prop({
        desc: `If set to int > 0, all ngrams of size no_repeat_ngram_size can only occur once.`,
    })
    no_repeat_ngram_size?: number;

    @Prop({
        desc: `Set seed for reproducible outputs. Set to -1 for random seed.`,
    })
    seed?: number;

    @Prop({
        desc: `provide debugging output in logs`,
    })
    debug?: boolean;
}

@injectable()
export class InstructBLIP extends AbstractImageInterrogationModel<ReplicateInstructBlipVicuna13bModelOptions> {
    static override description = 'An instruction-tuned multi-modal model based on BLIP-2 and Vicuna-13B';
    static override aliases = [
        'instructblip'
    ];
    static override modelOptionsType = ReplicateInstructBlipVicuna13bModelOptions;

    // https://replicate.com/joehoover/instructblip-vicuna13b/versions
    static replicateModel: string = 'c4c54e3c8c97cd50c2d2fec9be3b6065563ccf7d43787fb99f84151b867178fe';

    override clients: Array<ReplicateHTTP> = [];

    logger = this.globalLogger.child({ service: this.constructor.name });

    constructor(
        protected envConfig: EnvConfig,
        protected globalLogger: GlobalLogger,
    ) {
        super(...arguments);
    }

    override async init() {
        await this.dependencyReady();
        this.clients = [
            new ReplicateHTTP(this.envConfig.REPLICATE_API_KEY),
        ];
        this.emit('ready');
    }

    override async _run<U extends ImageInterrogationOptions<ReplicateInstructBlipVicuna13bModelOptions>>(client: this['clients'][number], modelOpts: U): Promise<string> {
        const payload: any = ReplicateInstructBlipVicuna13bModelOptions.from({
            ...modelOpts.modelSpecific,
            img: await this.toUrl(modelOpts.image),
            prompt: modelOpts.prompt,
            max_length: modelOpts.max_tokens,
        });
        if (modelOpts.prompt) {
            payload.question = modelOpts.prompt;
        } else {
            payload.caption = true;
        }

        const rp = await client.createPrediction((this.constructor as typeof InstructBLIP).replicateModel,
            payload
        );

        const predictionId = rp.data.id;

        const r = await client.pollPrediction(predictionId);

        return r.output.join('');
    }
}
