export function cleanAttribute(attribute: string) {
    return attribute ? attribute.replace(/(\n+\s*)+/g, '\n') : '';
}
