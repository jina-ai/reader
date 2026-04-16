import { OpenAICompatHTTP } from './openai-compat';


export class OpenAIHTTP extends OpenAICompatHTTP {
    name = 'OfficialOpenAI';

    supportedCompletionModels = [
        'gpt-3.5-turbo-instruct',
        'babbage-002',
        'davinci-002',
    ];
    supportedChatCompletionModels = [
        'gpt-3.5-turbo',
        'gpt-3.5-turbo-0125',
        'gpt-3.5-turbo-1106',
        'gpt-3.5-turbo-0613',
        'gpt-3.5-turbo-0301',

        'gpt-3.5-turbo-16k',
        'gpt-3.5-turbo-16k-1106',
        'gpt-3.5-turbo-16k-0613',

        'gpt-4',
        'gpt-4-0613',

        'gpt-4-vision-preview',
        'gpt-4-turbo-preview',
        'gpt-4-0125-preview',
        'gpt-4-1106-preview',

        'gpt-4-32k',
        'gpt-4-32k-0613',

        'gpt-4-turbo',
        'gpt-4-turbo-2024-04-09',

        'gpt-4o',
        'gpt-4o-2024-05-13',

        'gpt-4o-mini',
        'gpt-4o-mini-2024-07-18',
    ];

    supportedImageGenerationModels = [
        'dall-e-2',
        'dall-e-3'
    ];


    constructor(apiKey: string, organization?: string) {
        super(apiKey, 'https://api.openai.com/v1', organization);
    }

}
