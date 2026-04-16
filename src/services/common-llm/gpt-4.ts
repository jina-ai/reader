import { Prop } from 'civkit/civ-rpc';
import _ from "lodash";
import { injectable } from "tsyringe";

import { ChatGPTMessage, ChatGPTModelOptions } from './gpt-35';
import { ChatGPT1106,  } from './gpt-1106';
import { countGPTToken } from '../../utils/openai';

export class GPT4oModelOptions extends ChatGPTModelOptions {
    static override windowSize = 128_000;

    @Prop({
        default: 'gpt-4o',
    })
    override model!: string;

    @Prop({
        required: true,
        desc: 'The messages to generate chat completions for, in the [chat format](/docs/guides/chat/introduction).',
        arrayOf: ChatGPTMessage,
        validateCollection(this: typeof ChatGPTModelOptions, messages: ChatGPTMessage[]) {
            return _.sum(messages.map((m) => countGPTToken(m.content, 'gpt-4o'))) <= this.windowSize;
        },
    })
    override messages!: ChatGPTMessage[];
}

@injectable()
export class GPT4o_20240513 extends ChatGPT1106 {
    static override description = 'OpenAI GPT 4 Omni Model 2024-05-13';
    static override aliases = [
        'gpt-4o-2024-05-13',
    ];
    static override modelOptionsType = GPT4oModelOptions;
    static override windowSize = GPT4oModelOptions.windowSize;
    static override visionEnabled = true;
    static override interleavedPromptSupported = true;

    static override modelName = 'gpt-4o-2024-05-13';
}

@injectable()
export class GPT4o extends GPT4o_20240513 {
    static override description = 'OpenAI GPT 4 Omni Model 2024-08-06';
    static override aliases = [
        'gpt-4o-2024-08-06',
        'gpt-4o',
    ];
    static override modelName = 'gpt-4o-2024-08-06';
}


@injectable()
export class GPT4oMini extends GPT4o_20240513 {
    static override description = 'OpenAI GPT 4 Omni Model mini 2024-07-18';
    static override aliases = [
        'gpt-4o-mini-2024-07-18',
        'gpt-4o-mini',
    ];
    static override modelName = 'gpt-4o-mini-2024-07-18';
}
