// import { OpenAICompatHTTP } from './openai-compat';

// export class InternalCloudRunReaderLM2 extends OpenAICompatHTTP {
//     name = 'InternalReaderLMCloudRun';

//     supportedCompletionModels = [
//     ];
//     supportedChatCompletionModels = [
//         'readerlm-v2',
//     ];

//     supportedImageGenerationModels = [
//     ];

//     constructor(apiKey: string, organization?: string) {
//         super(apiKey, process.env.OVERRIDE_READERLM_V2_URL', organization);
//     }
// }

// export class InternalCloudRunJinaVLM extends OpenAICompatHTTP {
//     name = 'InternalJinaVLMCloudRun';

//     supportedCompletionModels = [
//     ];
//     supportedChatCompletionModels = [
//         'jina-vlm',
//     ];

//     supportedImageGenerationModels = [
//     ];

//     constructor(apiKey: string, organization?: string) {
//         super(apiKey, process.env.OVERRIDE_JINA_VLM_URL, organization);
//     }
// }
