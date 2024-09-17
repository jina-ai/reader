import { AsyncService, AutoCastable, Prop } from 'civkit';
import { Logger } from '../shared/services/logger';

const pLinkedom = import('linkedom');

export class HTMLtoMarkdown extends AsyncService {

    linkedom!: Awaited<typeof pLinkedom>;

    constructor(
        protected logger: Logger,
    ) {
        super(...arguments);
    }


    override async init() {
        await this.dependencyReady();

        this.linkedom = await pLinkedom;

        this.emit('ready');
    }

}


export class MarkdownASTNode extends AutoCastable {
    @Prop({
        required: true
    })
    type!: string;
}

export class MDCode extends MarkdownASTNode {
    @Prop({
        default: 'code'
    })
    override type!: 'code';

    @Prop()
    lang?: string;

    @Prop({
        required: true,
        default: ''
    })
    text!: string;
}

export class MDHTML extends MarkdownASTNode {
    @Prop({
        default: 'html'
    })
    override type!: 'html';

    @Prop({
        required: true,
        default: ''
    })
    text!: string;
}


export class MarkdownASTParentNode extends MarkdownASTNode {

    @Prop({
        default: [],
        arrayOf: MarkdownASTNode
    })
    children!: MarkdownASTNode[];
}


export class MarkdownASTRoot extends MarkdownASTParentNode {
    @Prop({
        default: 'root'
    })
    override type!: 'root';
}

export class MDParagraph extends MarkdownASTParentNode {
    @Prop({
        default: 'paragraph'
    })
    override type!: 'paragraph';
}

export class MDHeading extends MarkdownASTParentNode {
    @Prop({
        default: 'heading'
    })
    override type!: 'heading';

    @Prop({
        required: true,
        type: Number,
        validate(v: number) {
            return v >= 1 && v <= 6;
        }
    })
    level!: 1 | 2 | 3 | 4 | 5 | 6;
}

export class MDList extends MarkdownASTParentNode {
    @Prop({
        default: 'list'
    })
    override type!: 'list';

    @Prop({
        default: false,
    })
    ordered!: boolean;
}

export class MDListItem extends MarkdownASTParentNode {
    @Prop({
        default: 'listItem'
    })
    override type!: 'listItem';

    @Prop({
        default: false,
    })
    spread?: boolean;

    @Prop()
    checked?: boolean;

    @Prop({
        default: false,
        arrayOf: MarkdownASTNode
    })
    override children!: MarkdownASTNode[];
}

export class MDLink extends MarkdownASTParentNode {
    @Prop({
        default: 'link'
    })
    override type!: 'link';

    @Prop({
        required: true
    })
    href!: string;

    @Prop()
    alt?: string;

    @Prop({
        default: false,
        arrayOf: MarkdownASTNode
    })
    override children!: MarkdownASTNode[];
}

export class MDStrong extends MarkdownASTParentNode {
    @Prop({
        default: 'strong'
    })
    override type!: 'strong';

    @Prop({
        default: false,
        arrayOf: MarkdownASTNode
    })
    override children!: MarkdownASTNode[];
}

export class MDEmphasis extends MarkdownASTParentNode {
    @Prop({
        default: 'emphasis'
    })
    override type!: 'emphasis';

    @Prop({
        default: false,
        arrayOf: MarkdownASTNode
    })
    override children!: MarkdownASTNode[];
}

export class MDDelete extends MarkdownASTParentNode {
    @Prop({
        default: 'delete'
    })
    override type!: 'delete';

    @Prop({
        default: false,
        arrayOf: MarkdownASTNode
    })
    override children!: MarkdownASTNode[];
}


export class MDLiteral extends MarkdownASTNode {
    @Prop({
        default: 'literal'
    })
    override type!: 'literal';

    @Prop({
        required: true,
        default: ''
    })
    text!: string;
}

export class MDLineBreak extends MarkdownASTNode {
    @Prop({
        default: 'break'
    })
    override type!: 'break';
}

export class MDThematicBreak extends MarkdownASTNode {
    @Prop({
        default: 'thematicBreak'
    })
    override type!: 'thematicBreak';
}

export class MDImage extends MarkdownASTNode {
    @Prop({
        default: 'image'
    })
    override type!: 'image';

    @Prop({
        required: true
    })
    src!: string;

    @Prop()
    alt?: string;

    @Prop()
    title?: string;
}

export class MDInlineCode extends MarkdownASTNode {
    @Prop({
        default: 'inlineCode'
    })
    override type!: 'inlineCode';

    @Prop({
        required: true,
        default: ''
    })
    text!: string;
}

export class MDMath extends MarkdownASTNode {
    @Prop({
        default: 'math'
    })
    override type!: 'math';

    @Prop()
    lang?: string;

    @Prop({
        required: true,
        default: ''
    })
    text!: string;
}

export class MDInlineMath extends MarkdownASTNode {
    @Prop({
        default: 'inlineMath'
    })
    override type!: 'inlineMath';

    @Prop()
    lang?: string;

    @Prop({
        required: true,
        default: ''
    })
    text!: string;
}


export class MDTableHeading extends MarkdownASTNode {
    @Prop({
        default: 'tableHeading'
    })
    override type!: 'tableHeading';

    @Prop({
        required: true
    })
    text!: string;

    @Prop({
        default: 'left',
        validate(v: string) {
            return ['left', 'center', 'right'].includes(v);
        }
    })
    align?: 'left' | 'center' | 'right';
}

export class MDTableHeader extends MarkdownASTParentNode {
    @Prop({
        default: 'tableHeader'
    })
    override type!: 'tableHeader';

    @Prop({
        default: false,
        arrayOf: MDTableHeading
    })
    override children!: MDTableHeading[];
}
export class MDTableCell extends MarkdownASTParentNode {
    @Prop({
        default: 'tableCell'
    })
    override type!: 'tableCell';

    @Prop({
        default: false,
        arrayOf: MarkdownASTNode
    })
    override children!: MarkdownASTNode[];
}

export class MDTableRow extends MarkdownASTParentNode {
    @Prop({
        default: 'tableRow'
    })
    override type!: 'tableRow';

    @Prop({
        default: false,
        arrayOf: MDTableCell
    })
    override children!: MDTableCell[];
}

export class MDTable extends MarkdownASTParentNode {
    @Prop({
        default: 'table'
    })
    override type!: 'table';

    @Prop({
        default: false,
        arrayOf: [MDTableHeader, MDTableRow]
    })
    override children!: (MDTableHeader | MDTableRow)[];
}

export class MDBlockQuote extends MarkdownASTParentNode {
    @Prop({
        default: 'blockquote'
    })
    override type!: 'blockquote';
}

export const flowContents = [MDBlockQuote, MDCode, MDHeading, MDHTML, MDList, MDThematicBreak, MDParagraph, MDMath, MDTable];
export const phrasingContent = [MDLineBreak, MDEmphasis, MDStrong, MDHTML, MDImage, MDInlineCode, MDInlineMath, MDLink, MDLiteral, MDDelete];

export const childrenAllowedNodes = new Map<Function, Function[]>([
    [MDBlockQuote, flowContents],
    [MDHeading, phrasingContent],
    [MDList, [MDListItem]],
    [MDListItem, flowContents],
    [MDParagraph, phrasingContent],
    [MDTable, [MDTableHeader, MDTableRow]],
    [MDTableHeader, [MDTableHeading]],
    [MDTableRow, [MDTableCell]],

]);

export class HTMLToMarkdownJob {

    root = new MarkdownASTRoot();
    stack: MarkdownASTParentNode[] = [this.root];
    ptr: MarkdownASTNode = this.root;

    metadata: Record<string, any> = {};

    constructor(public dom: Document) {
    }

    restFlow() {
        this.ptr = this.root;
    }

    walk() {
        const tw = this.dom.createTreeWalker(
            this.dom.documentElement,
            1 | 4,
            {
                acceptNode: (node) => {
                    const tagName = node.nodeName.toLowerCase();
                    if (['script', 'style', 'link'].includes(tagName)) {
                        return NodeFilter.FILTER_REJECT; // Ignore these nodes
                    }

                    return NodeFilter.FILTER_ACCEPT; // Accept everything else
                }
            }
        );


    }

}
