import { ParamValidationError } from 'civkit';

export function cleanAttribute(attribute: string | null) {
    return attribute ? attribute.replace(/(\n+\s*)+/g, '\n') : '';
}


export function tryDecodeURIComponent(input: string) {
    try {
        return decodeURIComponent(input);
    } catch (err) {
        if (URL.canParse(input, 'http://localhost:3000')) {
            return input;
        }

        throw new ParamValidationError(`Invalid URIComponent: ${input}`);
    }
}
