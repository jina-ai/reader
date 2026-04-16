import { HTTPService, HTTPServiceRequestOptions } from 'civkit/http';
import _ from 'lodash';
import { ProxyAgent } from 'undici';
import { InputServerEventStream } from '../lib/transform-server-event-stream';
import { Readable } from 'stream';

/**
 * @license
 * Copyright 2024 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
/**
 * Possible roles.
 * @public
 */
export const POSSIBLE_ROLES = ["user", "model", "function", "system"] as const;

/**
 * Harm categories that would cause prompts or candidates to be blocked.
 * @public
 */
export enum HarmCategory {
    HARM_CATEGORY_UNSPECIFIED = "HARM_CATEGORY_UNSPECIFIED",
    HARM_CATEGORY_HATE_SPEECH = "HARM_CATEGORY_HATE_SPEECH",
    HARM_CATEGORY_SEXUALLY_EXPLICIT = "HARM_CATEGORY_SEXUALLY_EXPLICIT",
    HARM_CATEGORY_HARASSMENT = "HARM_CATEGORY_HARASSMENT",
    HARM_CATEGORY_DANGEROUS_CONTENT = "HARM_CATEGORY_DANGEROUS_CONTENT",
}

/**
 * Threshold above which a prompt or candidate will be blocked.
 * @public
 */
export enum HarmBlockThreshold {
    // Threshold is unspecified.
    HARM_BLOCK_THRESHOLD_UNSPECIFIED = "HARM_BLOCK_THRESHOLD_UNSPECIFIED",
    // Content with NEGLIGIBLE will be allowed.
    BLOCK_LOW_AND_ABOVE = "BLOCK_LOW_AND_ABOVE",
    // Content with NEGLIGIBLE and LOW will be allowed.
    BLOCK_MEDIUM_AND_ABOVE = "BLOCK_MEDIUM_AND_ABOVE",
    // Content with NEGLIGIBLE, LOW, and MEDIUM will be allowed.
    BLOCK_ONLY_HIGH = "BLOCK_ONLY_HIGH",
    // All content will be allowed.
    BLOCK_NONE = "BLOCK_NONE",
}

/**
 * Probability that a prompt or candidate matches a harm category.
 * @public
 */
export enum HarmProbability {
    // Probability is unspecified.
    HARM_PROBABILITY_UNSPECIFIED = "HARM_PROBABILITY_UNSPECIFIED",
    // Content has a negligible chance of being unsafe.
    NEGLIGIBLE = "NEGLIGIBLE",
    // Content has a low chance of being unsafe.
    LOW = "LOW",
    // Content has a medium chance of being unsafe.
    MEDIUM = "MEDIUM",
    // Content has a high chance of being unsafe.
    HIGH = "HIGH",
}

/**
 * Reason that a prompt was blocked.
 * @public
 */
export enum BlockReason {
    // A blocked reason was not specified.
    BLOCKED_REASON_UNSPECIFIED = "BLOCKED_REASON_UNSPECIFIED",
    // Content was blocked by safety settings.
    SAFETY = "SAFETY",
    // Content was blocked, but the reason is uncategorized.
    OTHER = "OTHER",
}

/**
 * Reason that a candidate finished.
 * @public
 */
export enum FinishReason {
    // Default value. This value is unused.
    FINISH_REASON_UNSPECIFIED = "FINISH_REASON_UNSPECIFIED",
    // Natural stop point of the model or provided stop sequence.
    STOP = "STOP",
    // The maximum number of tokens as specified in the request was reached.
    MAX_TOKENS = "MAX_TOKENS",
    // The candidate content was flagged for safety reasons.
    SAFETY = "SAFETY",
    // The candidate content was flagged for recitation reasons.
    RECITATION = "RECITATION",
    // Unknown reason.
    OTHER = "OTHER",
}

/**
 * Task type for embedding content.
 * @public
 */
export enum TaskType {
    TASK_TYPE_UNSPECIFIED = "TASK_TYPE_UNSPECIFIED",
    RETRIEVAL_QUERY = "RETRIEVAL_QUERY",
    RETRIEVAL_DOCUMENT = "RETRIEVAL_DOCUMENT",
    SEMANTIC_SIMILARITY = "SEMANTIC_SIMILARITY",
    CLASSIFICATION = "CLASSIFICATION",
    CLUSTERING = "CLUSTERING",
}

/**
 * @public
 */
export enum FunctionCallingMode {
    // Unspecified function calling mode. This value should not be used.
    MODE_UNSPECIFIED = "MODE_UNSPECIFIED",
    // Default model behavior, model decides to predict either a function call
    // or a natural language repspose.
    AUTO = "AUTO",
    // Model is constrained to always predicting a function call only.
    // If "allowed_function_names" are set, the predicted function call will be
    // limited to any one of "allowed_function_names", else the predicted
    // function call will be any one of the provided "function_declarations".
    ANY = "ANY",
    // Model will not predict any function call. Model behavior is same as when
    // not passing any function declarations.
    NONE = "NONE",
}
/**
 * Content type for both prompts and response candidates.
 * @public
 */
export interface Content {
    role: string;
    parts: Part[];
}

/**
 * Content part - includes text or image part types.
 * @public
 */
export type Part =
    | TextPart
    | InlineDataPart
    | FunctionCallPart
    | FunctionResponsePart
    | FileDataPart;

/**
 * Content part interface if the part represents a text string.
 * @public
 */
export interface TextPart {
    text: string;
    inlineData?: never;
    functionCall?: never;
    functionResponse?: never;
    fileData?: never;
}

/**
 * Content part interface if the part represents an image.
 * @public
 */
export interface InlineDataPart {
    text?: never;
    inlineData: GenerativeContentBlob;
    functionCall?: never;
    functionResponse?: never;
    fileData?: never;
}

/**
 * Content part interface if the part represents FunctionResponse.
 * @public
 */
export interface FunctionCallPart {
    text?: never;
    inlineData?: never;
    functionCall: FunctionCall;
    functionResponse?: never;
    fileData?: never;
}

/**
 * Content part interface if the part represents FunctionResponse.
 * @public
 */
export interface FunctionResponsePart {
    text?: never;
    inlineData?: never;
    functionCall?: never;
    functionResponse: FunctionResponse;
    fileData?: never;
}

/**
 * A predicted [FunctionCall] returned from the model
 * that contains a string representing the [FunctionDeclaration.name]
 * and a structured JSON object containing the parameters and their values.
 * @public
 */
export interface FunctionCall {
    name: string;
    args: object;
}

/**
 * The result output from a [FunctionCall] that contains a string
 * representing the [FunctionDeclaration.name]
 * and a structured JSON object containing any output
 * from the function is used as context to the model.
 * This should contain the result of a [FunctionCall]
 * made based on model prediction.
 * @public
 */
export interface FunctionResponse {
    name: string;
    response: object;
}

/**
 * Interface for sending an image.
 * @public
 */
export interface GenerativeContentBlob {
    mimeType: string;
    /**
     * Image as a base64 string.
     */
    data: string;
}

/**
 * Content part interface if the part represents FunctionResponse.
 * @public
 */
export interface FileDataPart {
    text?: never;
    inlineData?: never;
    functionCall?: never;
    functionResponse?: never;
    fileData: FileData;
}

/**
 * Data pointing to a file uploaded with the Files API.
 * @public
 */
export interface FileData {
    mimeType: string;
    fileUri: string;
}

/**
 * Base parameters for a number of methods.
 * @public
 */
export interface BaseParams {
    safetySettings?: SafetySetting[];
    generationConfig?: GenerationConfig;
}

/**
 * Params passed to {@link GoogleGenerativeAI.getGenerativeModel}.
 * @public
 */
export interface ModelParams extends BaseParams {
    model: string;
    tools?: Tool[];
    toolConfig?: ToolConfig;
    systemInstruction?: Content;
}

/**
 * Request sent to `generateContent` endpoint.
 * @public
 */
export interface GenerateContentRequest extends BaseParams {
    contents: Content[];
    tools?: Tool[];
    toolConfig?: ToolConfig;
    systemInstruction?: Content;
}

/**
 * Safety setting that can be sent as part of request parameters.
 * @public
 */
export interface SafetySetting {
    category: HarmCategory;
    threshold: HarmBlockThreshold;
}

/**
 * Config options for content-related requests
 * @public
 */
export interface GenerationConfig {
    candidateCount?: number;
    stopSequences?: string[];
    maxOutputTokens?: number;
    temperature?: number;
    topP?: number;
    topK?: number;
}

/**
 * Params for {@link GenerativeModel.startChat}.
 * @public
 */
export interface StartChatParams extends BaseParams {
    history?: Content[];
    tools?: Tool[];
    toolConfig?: ToolConfig;
    systemInstruction?: Content;
}

/**
 * Params for calling {@link GenerativeModel.countTokens}
 * @public
 */
export interface CountTokensRequest {
    contents: Content[];
}

/**
 * Params for calling {@link GenerativeModel.embedContent}
 * @public
 */
export interface EmbedContentRequest {
    content: Content;
    taskType?: TaskType;
    title?: string;
}

/**
 * Params for calling  {@link GenerativeModel.batchEmbedContents}
 * @public
 */
export interface BatchEmbedContentsRequest {
    requests: EmbedContentRequest[];
}

/**
 * Params passed to getGenerativeModel() or GoogleAIFileManager().
 * @public
 */
export interface RequestOptions {
    /**
     * Request timeout in milliseconds.
     */
    timeout?: number;
    /**
     * Version of API endpoint to call (e.g. "v1" or "v1beta"). If not specified,
     * defaults to latest stable version.
     */
    apiVersion?: string;
    /**
     * Additional attribution information to include in the x-goog-api-client header.
     * Used by wrapper SDKs.
     */
    apiClient?: string;
    /**
     * Base endpoint url. Defaults to "https://generativelanguage.googleapis.com"
     */
    baseUrl?: string;
}

/**
 * Defines a tool that model can call to access external knowledge.
 * @public
 */
export declare type Tool = FunctionDeclarationsTool;

/**
 * Structured representation of a function declaration as defined by the
 * [OpenAPI 3.0 specification](https://spec.openapis.org/oas/v3.0.3). Included
 * in this declaration are the function name and parameters. This
 * FunctionDeclaration is a representation of a block of code that can be used
 * as a Tool by the model and executed by the client.
 * @public
 */
export declare interface FunctionDeclaration {
    /**
     * The name of the function to call. Must start with a letter or an
     * underscore. Must be a-z, A-Z, 0-9, or contain underscores and dashes, with
     * a max length of 64.
     */
    name: string;
    /**
     * Optional. Description and purpose of the function. Model uses it to decide
     * how and whether to call the function.
     */
    description?: string;
    /**
     * Optional. Describes the parameters to this function in JSON Schema Object
     * format. Reflects the Open API 3.03 Parameter Object. string Key: the name
     * of the parameter. Parameter names are case sensitive. Schema Value: the
     * Schema defining the type used for the parameter. For function with no
     * parameters, this can be left unset.
     *
     * @example with 1 required and 1 optional parameter: type: OBJECT properties:
     * ```
     * param1:
     *
     *   type: STRING
     * param2:
     *
     *  type: INTEGER
     * required:
     *
     *   - param1
     * ```
     */
    parameters?: FunctionDeclarationSchema;
}

/**
 * A FunctionDeclarationsTool is a piece of code that enables the system to
 * interact with external systems to perform an action, or set of actions,
 * outside of knowledge and scope of the model.
 * @public
 */
export declare interface FunctionDeclarationsTool {
    /**
     * Optional. One or more function declarations
     * to be passed to the model along with the current user query. Model may
     * decide to call a subset of these functions by populating
     * [FunctionCall][content.part.functionCall] in the response. User should
     * provide a [FunctionResponse][content.part.functionResponse] for each
     * function call in the next turn. Based on the function responses, Model will
     * generate the final response back to the user. Maximum 64 function
     * declarations can be provided.
     */
    functionDeclarations?: FunctionDeclaration[];
}

/**
 * Contains the list of OpenAPI data types
 * as defined by https://swagger.io/docs/specification/data-models/data-types/
 * @public
 */
export enum FunctionDeclarationSchemaType {
    /** String type. */
    STRING = "STRING",
    /** Number type. */
    NUMBER = "NUMBER",
    /** Integer type. */
    INTEGER = "INTEGER",
    /** Boolean type. */
    BOOLEAN = "BOOLEAN",
    /** Array type. */
    ARRAY = "ARRAY",
    /** Object type. */
    OBJECT = "OBJECT",
}

/**
 * Schema for parameters passed to {@link FunctionDeclaration.parameters}.
 * @public
 */
export interface FunctionDeclarationSchema {
    /** The type of the parameter. */
    type: FunctionDeclarationSchemaType;
    /** The format of the parameter. */
    properties: { [k: string]: FunctionDeclarationSchemaProperty; };
    /** Optional. Description of the parameter. */
    description?: string;
    /** Optional. Array of required parameters. */
    required?: string[];
}

/**
 * Schema is used to define the format of input/output data.
 * Represents a select subset of an OpenAPI 3.0 schema object.
 * More fields may be added in the future as needed.
 * @public
 */
export interface FunctionDeclarationSchemaProperty {
    /**
     * Optional. The type of the property. {@link
     * FunctionDeclarationSchemaType}.
     */
    type?: FunctionDeclarationSchemaType;
    /** Optional. The format of the property. */
    format?: string;
    /** Optional. The description of the property. */
    description?: string;
    /** Optional. Whether the property is nullable. */
    nullable?: boolean;
    /** Optional. The items of the property. {@link FunctionDeclarationSchema} */
    items?: FunctionDeclarationSchema;
    /** Optional. The enum of the property. */
    enum?: string[];
    /** Optional. Map of {@link FunctionDeclarationSchema}. */
    properties?: { [k: string]: FunctionDeclarationSchema; };
    /** Optional. Array of required property. */
    required?: string[];
    /** Optional. The example of the property. */
    example?: unknown;
}

/**
 * Tool config. This config is shared for all tools provided in the request.
 * @public
 */
export interface ToolConfig {
    functionCallingConfig: FunctionCallingConfig;
    [k: string]: unknown;
}

/**
 * @public
 */
export interface FunctionCallingConfig {
    mode?: FunctionCallingMode;
    allowedFunctionNames?: string[];
}

/**
 * Result object returned from generateContent() call.
 *
 * @public
 */
export interface GenerateContentResult {
    response: EnhancedGenerateContentResponse;
}

/**
 * Result object returned from generateContentStream() call.
 * Iterate over `stream` to get chunks as they come in and/or
 * use the `response` promise to get the aggregated response when
 * the stream is done.
 *
 * @public
 */
export interface GenerateContentStreamResult {
    stream: AsyncGenerator<EnhancedGenerateContentResponse>;
    response: Promise<EnhancedGenerateContentResponse>;
}

/**
 * Response object wrapped with helper methods.
 *
 * @public
 */
export interface EnhancedGenerateContentResponse
    extends GenerateContentResponse {
    /**
     * Returns the text string assembled from all `Part`s of the first candidate
     * of the response, if available.
     * Throws if the prompt or candidate was blocked.
     */
    text: () => string;
    /**
     * Deprecated: use `functionCalls()` instead.
     * @deprecated - use `functionCalls()` instead
     */
    functionCall: () => FunctionCall | undefined;
    /**
     * Returns function calls found in any `Part`s of the first candidate
     * of the response, if available.
     * Throws if the prompt or candidate was blocked.
     */
    functionCalls: () => FunctionCall[] | undefined;
}

/**
 * Individual response from {@link GenerativeModel.generateContent} and
 * {@link GenerativeModel.generateContentStream}.
 * `generateContentStream()` will return one in each chunk until
 * the stream is done.
 * @public
 */
export interface GenerateContentResponse {
    candidates?: GenerateContentCandidate[];
    promptFeedback?: PromptFeedback;
}

/**
 * If the prompt was blocked, this will be populated with `blockReason` and
 * the relevant `safetyRatings`.
 * @public
 */
export interface PromptFeedback {
    blockReason: BlockReason;
    safetyRatings: SafetyRating[];
    blockReasonMessage?: string;
}

/**
 * A candidate returned as part of a {@link GenerateContentResponse}.
 * @public
 */
export interface GenerateContentCandidate {
    index: number;
    content: Content;
    finishReason?: FinishReason;
    finishMessage?: string;
    safetyRatings?: SafetyRating[];
    citationMetadata?: CitationMetadata;
}

/**
 * Citation metadata that may be found on a {@link GenerateContentCandidate}.
 * @public
 */
export interface CitationMetadata {
    citationSources: CitationSource[];
}

/**
 * A single citation source.
 * @public
 */
export interface CitationSource {
    startIndex?: number;
    endIndex?: number;
    uri?: string;
    license?: string;
}

/**
 * A safety rating associated with a {@link GenerateContentCandidate}
 * @public
 */
export interface SafetyRating {
    category: HarmCategory;
    probability: HarmProbability;
    blocked?: boolean;
}

/**
 * Response from calling {@link GenerativeModel.countTokens}.
 * @public
 */
export interface CountTokensResponse {
    totalTokens: number;
}

/**
 * Response from calling {@link GenerativeModel.embedContent}.
 * @public
 */
export interface EmbedContentResponse {
    embedding: ContentEmbedding;
}

/**
 * Response from calling {@link GenerativeModel.batchEmbedContents}.
 * @public
 */
export interface BatchEmbedContentsResponse {
    embeddings: ContentEmbedding[];
}

/**
 * A single content embedding.
 * @public
 */
export interface ContentEmbedding {
    values: number[];
}

export class GoogleGeminiHTTP extends HTTPService {
    name = 'GoogleGemini';

    constructor(apiKey: string, public baseUri: string = 'https://generativelanguage.googleapis.com/v1beta') {
        super(baseUri);

        this.baseHeaders['x-goog-api-client'] = `Developers know-better/1.0`;
        // this.baseHeaders['x-goog-api-key'] = `${apiKey}`;
        this.apiKey = apiKey;

        this.baseOptions.timeout = 1000 * 60 * 30 * 0.5;

        let agent!: ProxyAgent;
        const proxyUri = process.env.http_proxy;
        if (proxyUri) {
            agent = new ProxyAgent({
                uri: proxyUri
            });
        }
        if (agent) {
            Reflect.set(this.baseOptions, 'dispatcher', agent);
        }
    }

    set apiKey(apiKey: string) {
        this.baseHeaders['x-goog-api-key'] = apiKey;
    }
    get apiKey() {
        return this.baseHeaders['x-goog-api-key'] as string;
    }

    complete<T extends GenerateContentRequest>(model: string, payload: T, opts?: typeof this['baseOptions']) {
        return this.postJson<GenerateContentResponse>(`/models/${model}:generateContent`, payload,
            { ...opts, responseType: 'json' }
        );
    }

    streamComplete<T extends GenerateContentRequest>(model: string, payload: T, opts?: typeof this['baseOptions']) {
        return this.postJsonWithSearchParams<InputServerEventStream>(`/models/${model}:generateContent`, {
            alt: 'sse'
        }, payload,
            { ...opts, responseType: 'stream' }
        );
    }

    countTokens<T extends CountTokensRequest>(model: string, payload: T, opts?: typeof this['baseOptions']) {
        return this.postJson<CountTokensResponse>(`/models/${model}:countTokens`, payload,
            { ...opts, responseType: 'json' }
        );
    }

    override async __processResponse(options: HTTPServiceRequestOptions, r: Response): Promise<any> {
        if (r.status === 401) {
            this.emit('unauthorized', r);
        }
        if (r.status !== 200) {
            throw await r.json();
        }
        const s = await super.__processResponse(options, r) as any as Readable;
        if (options.responseType === 'stream') {
            const parseStream = new InputServerEventStream();
            s.pipe(parseStream);
            parseStream.once('end', () => {
                if (!s.readableEnded) {
                    r.body?.cancel();
                }
            });

            return parseStream;
        }

        return s;
    }
}

export class VertexGeminiHTTP extends GoogleGeminiHTTP {
    override name = 'VertexGemini';

    constructor(
        apiKey: string,
        public project: string,
        public region: string = 'us-central1',
    ) {
        super(apiKey, `https://${region}-aiplatform.googleapis.com/v1beta1/projects/${project}/locations/${region}/publishers/google`);
    }

    override get apiKey() {
        return this.baseHeaders['x-goog-api-key'] as string;
    }
    override set apiKey(input: string) {
        this.baseHeaders['authorization'] = `Bearer ${input}`;
        this.baseHeaders['x-goog-api-key'] = input;
    }

    override streamComplete<T extends GenerateContentRequest>(model: string, payload: T, opts?: typeof this['baseOptions']) {
        return this.postJsonWithSearchParams<InputServerEventStream>(`/models/${model}:streamGenerateContent`, { alt: 'sse' }, payload,
            { ...opts, responseType: 'stream' }
        );
    }
}
