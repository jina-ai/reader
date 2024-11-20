export function cleanAttribute(attribute: string | null) {
    return attribute ? attribute.replace(/(\n+\s*)+/g, '\n') : '';
}
