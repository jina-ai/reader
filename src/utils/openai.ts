import { get_encoding, TiktokenEncoding } from 'tiktoken';

export function getChatGptMetaPrompt(lang: string) {
    const knowledgeCutoff = '2021-09-01';
    const currentDate = new Date().toLocaleDateString('pt-br').split('/').reverse().join('-');
    /* eslint-disable max-len */
    switch (lang) {
        case 'zh-CN':
            return `你是ChatGPT，由OpenAI训练的大型语言模型。回答尽可能简洁。 ${knowledgeCutoff} 当前日期：${currentDate}`;
        case 'zh-TW':
            return `你是ChatGPT，由OpenAI訓練的大型語言模型。回答盡可能簡潔。 ${knowledgeCutoff} 當前日期：${currentDate}`;
        case 'ja':
            return `あなたはChatGPTです。OpenAIによって訓練された大規模な言語モデルです。できるだけ簡潔に答えてください。 ${knowledgeCutoff} 現在の日付：${currentDate}`;
        case 'ko':
            return `당신은 ChatGPT입니다. OpenAI에 의해 훈련 된 대규모 언어 모델입니다. 가능한 한 간결하게 대답하십시오. ${knowledgeCutoff} 현재 날짜：${currentDate}`;
        case 'fr':
            return `Vous êtes ChatGPT, un grand modèle de langue entraîné par OpenAI. Répondez aussi concisément que possible. ${knowledgeCutoff} Date actuelle : ${currentDate}`;
        case 'de':
            return `Du bist ChatGPT, ein großes Sprachmodell, das von OpenAI trainiert wurde. Antworte so kurz wie möglich. ${knowledgeCutoff} Aktuelles Datum: ${currentDate}`;
        case 'es':
            return `Eres ChatGPT, un gran modelo de lenguaje entrenado por OpenAI. Responde lo más conciso posible. ${knowledgeCutoff} Fecha actual: ${currentDate}`;
        case 'it':
            return `Sei ChatGPT, un grande modello linguistico addestrato da OpenAI. Rispondi il più conciso possibile. ${knowledgeCutoff} Data attuale: ${currentDate}`;
        case 'ru':
            return `Вы ChatGPT, большая языковая модель, обученная OpenAI. Отвечайте как можно более конкретно. ${knowledgeCutoff} Текущая дата: ${currentDate}`;
        default:
            return `You are ChatGPT, a large language model trained by OpenAI. Answer as concisely as possible. ${knowledgeCutoff} Current date: ${currentDate}`;
    }
}

const encoders: Record<string, ReturnType<typeof get_encoding>> = {};

function getEncoding(encoding: TiktokenEncoding) {
    if (!encoders[encoding]) {
        encoders[encoding] = get_encoding(encoding, {
            "<|im_start|>": 100264,
            "<|im_end|>": 100265,
        });
    }

    return encoders[encoding];
}

export function countGPTToken(
    str?: string | null | any[], model: string = 'gpt-3.5-turbo'
): number {
    if (!str) {
        return 0;
    }
    let encoding;
    if (model === 'text-davinci-003') {
        encoding = getEncoding('p50k_base');
    } else if (model.startsWith('gpt-4o') || model.startsWith('o1')) {
        encoding = getEncoding('o200k_base');
    } else {
        encoding = getEncoding('cl100k_base');
    }

    const txtContent = Array.isArray(str) ? str.map((x) => x.text).join('') : str;

    try {
        return encoding.encode(txtContent, 'all').length;
    } catch (err) {
        return NaN;
    }
}

function decodeBinary(buff: Uint8Array) {
    const decoder = new TextDecoder();

    const text = decoder.decode(buff);

    return text.endsWith('�') ? text.slice(0, -1) : text;
}

export function tokenTrim(str: string, maxTokens: number, model: string = 'gpt-3.5-turbo') {
    if (!str) {
        return '';
    }
    let encoding;
    if (model === 'text-davinci-003') {
        encoding = getEncoding('p50k_base');
    } else if (model.startsWith('gpt-4o') || model.startsWith('o1')) {
        encoding = getEncoding('o200k_base');
    } else {
        encoding = getEncoding('cl100k_base');
    }

    try {
        const tokens = encoding.encode(str, 'all').slice(0, maxTokens);

        return decodeBinary(encoding.decode(tokens));
    } catch (err) {
        return '�';
    }
}
