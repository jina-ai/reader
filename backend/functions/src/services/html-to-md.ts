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

export const childrenAllowedNodes = new Map<typeof MarkdownASTNode, (typeof MarkdownASTNode)[]>([
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
        this.stack.length = 0;
        this.stack.push(this.root);
    }

    checkIfAllowedToHaveChild(cls: typeof MarkdownASTNode) {
        const ptrCls = this.ptr.constructor;
        const allowedClasses = childrenAllowedNodes.get(ptrCls as typeof MarkdownASTNode);
        if (allowedClasses?.includes(cls)) {
            return true;
        }

        return false;
    }

    seekToInsert(cls: typeof MarkdownASTNode) {
        while (true) {
            if (this.checkIfAllowedToHaveChild(cls)) {
                return;
            }

            if (this.stack.length >= 2) {
                this.stack.pop()!;
                this.ptr = this.stack[this.stack.length - 1];

                continue;
            }

            break;
        }

        this.restFlow();
    }

    newBlockquote() {
        const node = new MDBlockQuote();
        this.restFlow();
        (this.ptr as MarkdownASTRoot).children.push(node);
        this.stack.push(node);
        this.ptr = node;

        return node;
    }

    newHeading(n: 1 | 2 | 3 | 4 | 5 | 6) {
        const node = new MDHeading();
        node.level = n;
        this.restFlow();
        (this.ptr as MarkdownASTRoot).children.push(node);
        this.stack.push(node);
        this.ptr = node;

        return node;
    }

    newParagraph() {
        const node = new MDParagraph();
        this.restFlow();
        (this.ptr as MarkdownASTRoot).children.push(node);
        this.stack.push(node);
        this.ptr = node;

        return node;
    }

    newList(ordered: boolean = false) {
        this.seekToInsert(MDList);
        const node = new MDList();
        node.ordered = ordered;
        (this.ptr as MarkdownASTParentNode).children.push(node);
        this.stack.push(node);
        this.ptr = node;

        return node;
    }

    newListItem(ordered: boolean = false) {
        this.seekToInsert(MDListItem);
        if (this.ptr === this.root) {
            this.newList(ordered);
        }
        const node = new MDListItem();
        (this.ptr as MarkdownASTParentNode).children.push(node);
        this.stack.push(node);
        this.ptr = node;

        return node;
    }

    newTable() {
        this.seekToInsert(MDTable);
        const node = new MDTable();
        (this.ptr as MarkdownASTParentNode).children.push(node);
        this.stack.push(node);
        this.ptr = node;

        return node;
    }

    newTableHeader() {
        this.seekToInsert(MDTableHeader);
        if (this.ptr === this.root) {
            this.newTable();
        }
        const node = new MDTableHeader();
        (this.ptr as MarkdownASTParentNode).children.push(node);
        this.stack.push(node);
        this.ptr = node;

        return node;
    }

    newTableRow() {
        this.seekToInsert(MDTableCell);
        if (this.ptr === this.root) {
            this.newTable();
        }
        const node = new MDTableCell();
        (this.ptr as MarkdownASTParentNode).children.push(node);
        this.stack.push(node);
        this.ptr = node;

        return node;
    }

    newCode(inline?: boolean) {
        const node = inline ? new MDInlineCode : new MDCode();
        this.seekToInsert(node.constructor as typeof MarkdownASTNode);
        (this.ptr as MarkdownASTRoot).children.push(node);

        return node;
    }

    newHTML() {
        const node = new MDHTML();
        this.seekToInsert(node.constructor as typeof MarkdownASTNode);
        (this.ptr as MarkdownASTRoot).children.push(node);

        return node;
    }

    newMath(inline?: boolean) {
        const node = inline ? new MDInlineMath : new MDMath();
        this.seekToInsert(node.constructor as typeof MarkdownASTNode);
        (this.ptr as MarkdownASTRoot).children.push(node);

        return node;
    }

    newLineBreak() {
        const node = new MDLineBreak();
        this.seekToInsert(node.constructor as typeof MarkdownASTNode);
        (this.ptr as MarkdownASTRoot).children.push(node);

        return node;
    }

    newEmphasis() {
        const node = new MDEmphasis();
        this.seekToInsert(node.constructor as typeof MarkdownASTNode);
        (this.ptr as MarkdownASTRoot).children.push(node);

        return node;
    }

    newString() {
        const node = new MDLiteral();
        this.seekToInsert(node.constructor as typeof MarkdownASTNode);
        (this.ptr as MarkdownASTRoot).children.push(node);

        return node;
    }

    newImage() {
        const node = new MDImage();
        this.seekToInsert(node.constructor as typeof MarkdownASTNode);
        (this.ptr as MarkdownASTRoot).children.push(node);

        return node;
    }

    newLiteral() {
        const node = new MDLiteral();
        this.seekToInsert(node.constructor as typeof MarkdownASTNode);
        (this.ptr as MarkdownASTRoot).children.push(node);

        return node;
    }

    newDelete() {
        const node = new MDDelete();
        this.seekToInsert(node.constructor as typeof MarkdownASTNode);
        (this.ptr as MarkdownASTRoot).children.push(node);

        return node;
    }

    newLink() {
        const node = new MDLink();
        this.seekToInsert(node.constructor as typeof MarkdownASTNode);
        (this.ptr as MarkdownASTRoot).children.push(node);

        return node;
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

        tw.nextSibling();
        tw.firstChild();

    }

}
