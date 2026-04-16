import { MathMLToLaTeX } from 'mathml-to-latex';

export interface MarkifyOptions {
    headingStyle?: 'atx' | 'setext';
    hr?: string;
    bulletListMarker?: '-' | '+' | '*';
    codeBlockStyle?: 'indented' | 'fenced';
    fence?: '```' | '~~~' | undefined;
    emDelimiter?: '_' | '*';
    strongDelimiter?: '__' | '**';
    linkStyle?: 'inlined' | 'referenced' | 'discarded';
    linkReferenceStyle?: 'full' | 'collapsed' | 'shortcut';
    preformattedCode?: boolean;
    footnoteStyle?: 'inline' | 'document';
    // Add other options as needed
    baseUrl?: string;
    gfm?: boolean;
}

export interface Replacer {
    name: string;
    replacement: (this: MarkifyService, content: string, node: Element, options?: MarkifyOptions) => string;
}

export interface MarkifyRule {
    filter: string | string[];
    replacement: Replacer['replacement'];
}

const tableCellAlignment: Record<string, string> = {
    left: ':---',
    right: '---:',
    center: ':---:',
};

export class MarkifyService {
    protected options: MarkifyOptions;

    protected rules: { [key: string]: Replacer[]; } = {};
    protected keepTags: Set<string> = new Set();

    links: Array<{
        href: string;
        domain: string;
        text: string;
        ref: number;
        title: string;
    }> = [];

    images: Array<{ src: string; alt: string; ref: number; }> = [];

    protected listLevel: number = -1;
    protected listStack: Array<{ tag: string; num?: number; }> = [];

    protected tableStack: Array<{ tag: string; hasTh: boolean; }> = [];
    refMap = new WeakMap<Element, MarkifyService['links'][0] | MarkifyService['images'][0]>();

    protected ignoreDivNewline: boolean = false;
    protected ignoreEmptyTextNode: boolean = true;
    protected layoutByTable = false;

    protected strongRegex: RegExp;
    protected emRegex: RegExp;
    protected trimRegex: RegExp;
    private higlightRegex: RegExp;

    commonMark: Record<string, Function> = {
        h1: this.processHeading,
        h2: this.processHeading,
        h3: this.processHeading,
        h4: this.processHeading,
        h5: this.processHeading,
        h6: this.processHeading,
        p: this.processParagraph,
        br: this.processBr,
        hr: this.processHr,
        strong: this.processStrong,
        b: this.processStrong,
        em: this.processEmphasis,
        i: this.processEmphasis,
        ul: this.processListWrapper,
        ol: this.processListWrapper,
        li: this.processListItem,
        a: this.processAnchor,
        img: this.processImage,
        pre: this.processPre,
        code: this.processCode,
        div: this.processDivNode,
        svg: this.processSVG,
        title: this.processTitle,
        figcaption: this.processFigcaption,
        link: this.skip,
        script: this.skip,
        meta: this.skip,
        style: this.skip,
        details: this.processDivNode,
        label: this.processLabel,
        select: this.processSelect,
        option: this.processOption,
        blockquote: this.processBlockQuote,
    };
    gfm: Record<string, Function> = {
        table: this.processTable,
        thead: this.processThead,
        tbody: this.processTbody,
        tr: this.processTr,
        th: this.processTd,
        td: this.processTd,
        strike: this.processStrike,
        del: this.processStrike,
        s: this.processStrike,
        input: this.processInput,
        math: this.processMath,
    };

    fnMap: Record<string, Function>;

    constructor(options: MarkifyOptions = {}) {
        this.options = Object.assign({}, options);

        this.fnMap = {
            ...this.commonMark,
            ...(this.options.gfm ? this.gfm : {}),
        };

        this.strongRegex = /^\*\*(.*?)\*\*$/g;
        this.emRegex = /^_(.*?)_$/g;
        this.trimRegex = /\s+/g;
        this.higlightRegex = /highlight-(?:text|source)-([a-z0-9]+)/;
        if (this.options.baseUrl?.startsWith('blob:') || this.options.baseUrl?.startsWith('data:')) {
            delete this.options.baseUrl;
        }

        this.init();
    }

    protected init() {
        this.keepTags.clear();
        this.rules = {};
        this.listLevel = -1;
        this.listStack = [];
        this.tableStack = [];
        this.links = [];
        this.images = [];
        this.ignoreDivNewline = false;
        this.ignoreEmptyTextNode = true;
        this.layoutByTable = false;
    }

    markify(element: HTMLElement): string {
        let markdown = '';
        markdown = this.processNode(element);
        // Trim leading/trailing whitespace and ensure consistent newlines
        let r = markdown.trim().replace(/\n{3,}/g, '\n\n');

        if (this.options.linkStyle === 'referenced' && this.links.length) {
            r += '\n\n';
            switch (this.options.linkReferenceStyle) {
                case 'collapsed':
                case 'shortcut': {
                    r += this.links.map((x) => `[${x.text}]: ${x.href}${x.title ? ` "${x.title}"` : ''}`).join('\n');
                    break;
                }

                default: {
                    r += this.links.map((x) => `[${x.ref}]: ${x.href}${x.title ? ` "${x.title}"` : ''}`).join('\n');
                    break;
                }
            }
        }

        return r;
    }

    protected processNode(element: Element): string {
        const { nodeType, nodeName } = element;

        if (nodeType === 3) {
            return this.processTextNode(element as unknown as Text);
        }
        if (![1, 9, 11].includes(nodeType)) return '';

        const tagName = nodeName.toLowerCase();
        if (this.keepTags.has(tagName)) {
            return element.outerHTML || '';
        }

        const customRuleSet = this.rules[tagName];
        const fn = this.fnMap[tagName];

        const r = fn ? fn.call(this, element) : this.processChildren(element);
        if (customRuleSet?.length) {
            return this.replaceByRules(r || '', element, customRuleSet);
        }

        return r;
    }

    protected skip(_: any) {
        return '';
    }

    protected processDivNode(divNode: HTMLDivElement): string {
        const markdown = this.processChildren(divNode);

        const firstChild = divNode.firstChild;
        const className = divNode.className || '';
        const language = (className.match(this.higlightRegex) || [])[1];
        if (firstChild?.nodeName === 'PRE' && language) {
            return `\n\n${this.options.fence}${language}\n${firstChild.textContent}\n${this.options.fence}\n\n`;
        }

        // const trimmedMarkdown = markdown.replace(/^\n+|\n+$/g, '');
        let trimmedMarkdown = markdown;
        let start = 0;
        let end = trimmedMarkdown.length - 1;
        while (trimmedMarkdown[start] === '\n') {
            start++;
        }
        while (trimmedMarkdown[end] === '\n') {
            end--;
        }
        trimmedMarkdown = trimmedMarkdown.slice(start, end + 1);

        if (this.ignoreDivNewline) {
            return `${trimmedMarkdown} `;
        }

        if (trimmedMarkdown) return `\n\n${trimmedMarkdown}\n\n`;

        return markdown;
    }

    protected processTextNode(textNode: Text): string {
        let text = textNode.data || '';

        if (!text.trim()) {
            // return this.ignoreEmptyTextNode ? '' : ' ';
            if (this.ignoreEmptyTextNode || !text.includes(' ')) return '';
            return ' ';
        }

        const emDelimiter = this.options.emDelimiter || '_';
        const strongDelimiter = this.options.strongDelimiter || '**';

        // Escape markdown control characters
        // if (!this.ignoreEscaping) {
        //   text = text.replace(/^(\*|_|`|~|>|#|-|\+|=|\!|\[|\]|\(|\))/g, '\\$1');
        // }

        // remove extra spaces and new lines
        text = text.replace(this.trimRegex, ' ');

        //handle emphasis and strong within text node.
        text = text.replace(
            this.strongRegex,
            ` ${strongDelimiter}$1${strongDelimiter} `,
        );
        text = text.replace(this.emRegex, ` ${emDelimiter}$1${emDelimiter} `);

        return text;
    }

    protected replaceByRules(
        text: string,
        element: Element,
        replacers: Replacer[],
    ): string {
        let replacedText = text;
        for (const replacer of replacers) {
            replacedText = replacer.replacement.call(this, replacedText, element, this.options);
        }
        return replacedText;
    }

    protected processTitle(element: Element): string {
        const titleText = this.processChildren(element);
        if (!titleText) return '';

        return `${titleText}\n`;
    }

    protected processHeading(element: Element): string {
        const headingStyle = this.options.headingStyle || 'atx';
        const headingText = this.processChildren(element).trim();
        const name: string = element.tagName ?? 'h6';
        const level = +name[1];

        if (!headingText) return '';

        if (headingStyle === 'setext' && level <= 2) {
            const underline = level <= 2 ? (level === 1 ? '=' : '-') : '';
            return underline
                ? `\n${headingText}\n${underline.repeat(headingText.length)}\n\n`
                : `\n${headingText}\n\n`;
        } else {
            return `\n${'#'.repeat(level)} ${headingText}\n\n`;
        }
    }

    protected processHr(element: Element): string {
        const hr = this.options.hr || '* * *';

        return `\n\n${hr}\n\n`;
    }

    protected processBr(element: Element): string {
        return '\n\n';
    }

    protected processSelect(element: Element): string {
        const markdown = this.processChildren(element);
        if (!markdown) {
            return '';
        }

        return `\n${markdown}\n\n`;
    }

    protected processOption(element: Element): string {
        // const value = element.attribs?.value || '';
        const value = element.getAttribute('value') || '';

        return `${value}\n`;
    }

    protected processLabel(element: Element): string {
        const labelText = this.processChildren(element);
        if (!labelText) return '';

        return `${labelText} `;
    }

    protected processStrong(element: Element): string {
        const strongDelimiter = this.options.strongDelimiter || '**';

        const text = this.processChildren(element);
        if (!text) return '';

        return `${strongDelimiter}${text.trim()}${strongDelimiter}`;
    }

    protected processEmphasis(element: Element): string {
        let text = this.processChildren(element).trim();
        if (!text) return '';

        text = text.replace(/_/g, '\\_');
        const emDelimiter = this.options.emDelimiter || '_';
        return `${emDelimiter}${text}${emDelimiter}`;
    }

    protected processListWrapper(element: Element): string {
        const tag = element.tagName?.toLowerCase() || 'ul';

        // store this wrapper in the listStack
        this.listStack.unshift({ tag, num: 0 });
        this.listLevel++;

        const markdown = this.processChildren(element);

        this.listLevel--;
        this.listStack.shift();

        return `\n${markdown}\n`;
    }

    protected processListItem(element: Element): string {
        const markdown: string[] = [];
        let prevlistStack = this.listStack[0];
        let withNewList = false;

        this.ignoreDivNewline = true;

        if (!prevlistStack || prevlistStack.tag === 'li') {
            prevlistStack = { tag: 'ul', num: 0 };
            this.listStack.unshift(prevlistStack);
            this.listLevel++;
            withNewList = true;
        }

        this.listStack.unshift({ tag: 'li' });

        let listItemText = this.processChildren(element);
        if (listItemText[0] === '\n') {
            listItemText = listItemText.slice(1);
        }
        if (listItemText[listItemText.length - 1] === '\n') {
            listItemText = listItemText.slice(0, -1);
        }

        const bulletListMarker =
            prevlistStack.tag === 'ol'
                ? `${prevlistStack.num! + 1}.`
                : this.options.bulletListMarker || '*';
        if (listItemText) {
            markdown.push(
                `${'    '.repeat(
                    this.listLevel,
                )}${bulletListMarker}   ${listItemText}\n`,
            );
        } else {
            markdown.push('\n');
        }

        prevlistStack.num!++;
        this.listStack.shift();

        if (withNewList) {
            this.listLevel--;
            this.listStack.shift();
        }

        this.ignoreDivNewline = false;
        return markdown.join('');
    }

    protected processAnchor(element: Element): string {
        let href = element.getAttribute('href') || '';
        let domain = '';
        const title = (element.getAttribute('title') || '').replace(/"/g, '\\"');

        let text = this.processChildren(element);
        text = text.replace(/\s+/g, ' ').trim();

        if (this.options.baseUrl) {
            try {
                const parsed = new URL(href, this.options.baseUrl);
                href = parsed.href;
                domain = parsed.hostname;
            } catch (e) { void 0; }
        }

        const linkStyle = this.options.linkStyle || 'inlined';

        let linkRef = undefined;
        if (href) {
            linkRef = this.links.length + 1;
            const rec = { href, text, title, ref: linkRef, domain };
            this.refMap.set(element, rec);
            this.links.push(rec);
        }

        const headingRegex = /^#{1,} /;

        switch (linkStyle) {
            case 'referenced':
                switch (this.options.linkReferenceStyle) {
                    case 'collapsed':
                        if (headingRegex.test(text)) {
                            const hashPart = text.slice(0, text.indexOf(' ') + 1);
                            const textPart = text.slice(text.indexOf(' ') + 1);
                            return `${hashPart}[${textPart}][]`;
                        }

                        return `[${text}][]`;
                    case 'shortcut':
                        if (headingRegex.test(text)) {
                            const hashPart = text.slice(0, text.indexOf(' ') + 1);
                            const textPart = text.slice(text.indexOf(' ') + 1);
                            return `${hashPart}[${textPart}]`;
                        }

                        return `[${text}]`;
                    case 'full':
                    default: {
                        if (headingRegex.test(text)) {
                            const hashPart = text.slice(0, text.indexOf(' ') + 1);
                            const textPart = text.slice(text.indexOf(' ') + 1);
                            return `${hashPart}[${textPart}][${linkRef ?? ''}]`;
                        }

                        return `[${text}][${linkRef ?? ''}]`;
                    }
                }
            case 'discarded':
                return text;
            case 'inlined':
            default: {
                if (headingRegex.test(text)) {
                    const hashPart = text.slice(0, text.indexOf(' ') + 1);
                    const textPart = text.slice(text.indexOf(' ') + 1);
                    return `${hashPart}[${textPart}](${href}${title ? ` "${title}"` : ''})`;
                }

                return `[${text}](${href}${title ? ` "${title}"` : ''})`;
            }
        }
    }

    protected processImage(element: Element): string {
        const src = element.getAttribute('src') || '';
        const alt = element.getAttribute('alt') || '';
        const title = element.getAttribute('title') || '';

        const rec = { src, alt, ref: this.images.length + 1 };
        this.refMap.set(element, rec);
        this.images.push(rec);

        return `![${alt}](${src}${title ? ` "${title}"` : ''})`;
    }

    protected processPreformattedChildren(nodes?: Element[]) {
        if (!nodes) return '';
        const markdown: string[] = [];
        nodes.forEach((node) => {
            if (node.nodeType === 3) {
                markdown.push((node as any).data || '');
            } else if (node.tagName?.toLowerCase() === 'code') {
                // If there's a <code> inside <pre>, process its text content
                markdown.push(this.processCode(node));
            } else {
                // Process other tags as text
                markdown.push(this.processNode(node));
            }
        });

        return markdown.join('');
    }

    protected processCode(element: Element): string {
        this.ignoreEmptyTextNode = false;
        const text = this.getCodeText(element);
        this.ignoreEmptyTextNode = true;

        return text;
    }

    protected getCodeText(element: Element): string {
        const classes = element.className.split(' ') || [];
        const language =
            classes
                .find((cls) => cls.startsWith('language-') || cls.startsWith('lang-'))
                ?.replace(/^(language-|lang-)/, '') ?? '';

        const codeBlockStyle = this.options.codeBlockStyle || 'indented';
        // const code = this.processPreformattedChildren(Array.from(element.childNodes) as Element[]) || '';
        const code = element.textContent || '';

        if (!code) return '';

        if (!language && !code.includes('\n')) {
            return `\`${code.trim()}\``;
        }

        if (codeBlockStyle === 'fenced') {
            const fence = this.options.fence || '```';

            return `\n${fence}${language}\n${code.trim()}\n${fence}\n`;
        } else {
            return `\n    ${code.trim().replace(/\n/g, '\n    ')}\n`;
        }
    }

    protected processPre(element: Element): string {
        this.ignoreEmptyTextNode = false;
        const preText = this.processPreformattedChildren(Array.from(element.childNodes) as Element[]);
        this.ignoreEmptyTextNode = true;

        return preText;
    }

    protected processParagraph(element: Element): string {
        const text = this.processChildren(element).trim();
        if (!text) return '';

        return `\n${text}\n\n`;
    }

    protected processSVG(element: Element): string {
        // Handle SVG elements if needed
        return '';
    }

    protected processTable(element: Element): string {
        this.tableStack.unshift({ tag: 'table', hasTh: false });
        const markdown = this.processChildren(element);

        let tableIndex = 0;
        for (; tableIndex < this.tableStack.length; tableIndex++) {
            if (this.tableStack[tableIndex].tag === 'table') {
                break;
            }
        }

        this.tableStack = this.tableStack.slice(tableIndex + 1);
        const items: string[] = [];
        if (!markdown.startsWith('\n')) {
            items.push('\n');
        }
        items.push(markdown);
        if (!markdown.endsWith('\n')) {
            items.push('\n');
        }
        return items.join('');
    }

    protected processThead(element: Element): string {
        return this.processChildren(element);
    }

    protected processTbody(element: Element): string {
        return this.processChildren(element);
    }

    protected processTd(element: Element): string {
        const items: string[] = [];
        const text = this.processChildren(element);
        items.push(`${this.layoutByTable ? text : text.replace(/\s+/g, ' ')}`.trim());

        return items.join('');
    }

    protected processTr(element: Element): string {
        const markdown: string[] = [];
        const cellContents: string[] = [];
        const alignments: string[] = [];

        const children = Array.from(element.childNodes) as Element[];
        let isTh = children.some((child) => child.tagName?.toLowerCase() === 'th');

        if (this.tableStack[0]?.tag !== 'table') isTh = false;

        let lastTable = this.tableStack.find((item) => item.tag === 'table');

        this.tableStack.unshift({ tag: 'tr', hasTh: false });

        const isWrappedByTable = lastTable?.tag === 'table';

        if (
            !isWrappedByTable ||
            (!isTh && !lastTable?.hasTh)
        ) {
            // treat as normal div
            this.layoutByTable = true;
            const tableText = `${this.processChildren(element)}\n`;
            this.layoutByTable = false;
            return tableText;
        }

        if (isTh && lastTable) {
            lastTable.hasTh = true;
        }

        for (let i = 0; i < children.length; i++) {
            const child = children[i];
            const name = child.tagName?.toLowerCase() ?? '';
            if (name === 'th' || name === 'td') {
                const cellContent = (this.processChildren(child) ?? '').replace(/\s+/g, ' ').trim();

                cellContents.push(cellContent);
                if (name === 'th') {
                    alignments.push(child.getAttribute('align') || '');
                }
            }
        }
        const cellContentStr = cellContents.join(' | ');
        markdown.push(`| ${cellContentStr} |\n`);

        if (isTh) {
            const divider = alignments
                .map((align) => {
                    return tableCellAlignment[align] ?? '---';
                })
                .join(' | ');
            markdown.push(`| ${divider} |\n`);
        }

        return markdown.join('');
    }

    protected processStrike(element: Element): string {
        const text = this.processChildren(element);
        if (!text) return '';

        return `~~${text}~~`;
    }

    protected processInput(element: Element) {
        if (element.getAttribute('type') === 'checkbox') {
            return this.processCheckBox(element);
        }

        return '';
    }

    protected processCheckBox(element: Element): string {
        const checked = element.getAttribute('checked') !== undefined;

        return `- [${checked ? 'x' : ' '}] `;
    }

    protected isUnicodeSupported() {
        try {
            new RegExp("\\p{L}", "u");
            return true;
        } catch {
            return false;
        }
    }

    protected needSpace(str1: string, str2: string): boolean {
        const useUnicode = this.isUnicodeSupported();
        const endsWithText = useUnicode
            ? /[\p{L}\p{N}_]$/u.test(str1)
            : /[^\s\W]$/.test(str1);

        const startsWithText = useUnicode
            ? /^[\p{L}\p{N}_]/u.test(str2)
            : /^[^\s\W]/.test(str2);

        return endsWithText && startsWithText;
    }

    protected processChildren(element: Element): string {
        let markdown = '';
        const items: any[] = [];
        let lastItem = '';

        (Array.from(element.childNodes) as Element[] || []).forEach((child) => {
            const { tagName } = child;
            const cname = tagName?.toLowerCase() ?? '';

            let childContent = this.processNode(child);
            if (!childContent) return;
            const parentTag = child.parentNode?.nodeName.toLowerCase() || '';
            // first level of list
            if (this.listLevel > 0 &&
                (parentTag === 'ul' || parentTag === 'ol') &&
                cname &&
                cname !== 'li'
            ) {
                childContent = `${'    '.repeat(this.listLevel) + childContent}\n`;
            }

            if (['ul', 'ol'].includes(cname)) {
                if (!lastItem?.endsWith('\n\n') && !childContent.startsWith('\n')) {
                    childContent = '\n' + childContent;
                }
            }
            else if (this.needSpace(lastItem, childContent)) {
                childContent = ' ' + childContent;
            }

            lastItem = childContent;
            items.push(childContent);
        });

        markdown = items.join('');
        return markdown;
    }

    protected processFigcaption(element: Element) {
        return `\n\n${this.processChildren(element)}\n\n`;
    }

    protected processBlockQuote(element: Element): string {
        let items: string[] = [];

        (Array.from(element.childNodes) as Element[] || []).forEach((child) => {
            const childContent = this.processNode(child);
            if (!childContent) return;
            items.push(childContent.replace(/^ /g, ''));
        });
        const markdown = items.join('').trim();

        if (!markdown) return '';

        return `\n> ${markdown.replace(/\n/g, '\n> ')}\n\n`;
    }

    protected processNodes(elements: Element[]): string {
        const markdown: string[] = [];
        for (const child of elements) {
            const cmd = this.processNode(child);
            markdown.push(cmd);
        }
        return markdown.join('');
    }

    protected processMath(element: Element): string {
        try {
            const latex = MathMLToLaTeX.convert(element.outerHTML);
            if (!latex.trim()) return '';
            // Parent is p and no siblings, then is block. Otherwise inline.
            if (element.parentElement?.tagName.toLowerCase() === 'p' && element.parentElement.childNodes.length === 1) {
                return `\n\n$$\n${latex.trim()}\n$$\n\n`;
            }

            return `$${latex.trim()}$`;
        } catch (e) {
            return element.textContent || '';
        }
    }

    public use(addRuleFns: Array<(service: MarkifyService) => void>) {
        addRuleFns.forEach((fn) => {
            fn(this);
        });
    }

    public addRule(name: string, rule: MarkifyRule) {
        const { filter, replacement } = rule;
        const tags = Array.isArray(filter) ? filter : [filter];

        tags.forEach((tag) => {
            const replacers = this.rules[tag] || [];
            replacers.push({
                name,
                replacement: replacement,
            });
            this.rules[tag] = replacers;
        });
    }

    public keep(tag?: string) {
        if (!tag) return;
        this.keepTags.add(tag.toLowerCase());
    }

    public getLinks() {
        return this.links.map((link) => ({
            href: link.href,
            text: link.text,
            ref: link.ref,
        }));
    }
}
