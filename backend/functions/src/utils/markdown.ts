export function tidyMarkdown(markdown: string): string {
    const lines = markdown.split('\n');
    const processedLines = lines.map((line) => {
        // Remove leading spaces from each line
        line = line.replace(/^[ \t]+/, '');

        // Handle complex broken links with text and optional images
        line = line.replace(/\[\s*([^\]\n!]*?)\s*(?:!\[([^\]]*)\]\((.*?)\))?\s*\]\s*\(\s*([^)\n]+)\s*\)/g, (match, text, alt, imgUrl, linkUrl) => {
            text = text.replace(/\s+/g, ' ').trim();
            alt = alt ? alt.replace(/\s+/g, ' ').trim() : '';
            imgUrl = imgUrl ? imgUrl.replace(/\s+/g, '').trim() : '';
            linkUrl = linkUrl.replace(/\s+/g, '').trim();
            if (imgUrl) {
                return `[${text} ![${alt}](${imgUrl})](${linkUrl})`;
            } else {
                return `[${text}](${linkUrl})`;
            }
        });

        // Normalize regular links that may be broken across lines
        line = line.replace(/\[\s*([^\]\n]+)\]\s*\(\s*([^)\n]+)\s*\)/g, (match, text, url) => {
            text = text.replace(/\s+/g, ' ').trim();
            url = url.replace(/\s+/g, '').trim();
            return `[${text}](${url})`;
        });

        return line;
    });

    // Join the processed lines back together
    let normalizedMarkdown = processedLines.join('\n');

    // Replace more than two consecutive empty lines with exactly two empty lines
    normalizedMarkdown = normalizedMarkdown.replace(/\n{3,}/g, '\n\n');

    return normalizedMarkdown.trim();
}
