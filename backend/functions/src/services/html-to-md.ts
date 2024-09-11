import { AsyncService, AutoCastable, Prop } from 'civkit';
import { Logger } from '../shared/services/logger';


export class HTMLtoMarkdown extends AsyncService {

    constructor(
        protected logger: Logger,
    ) {
        super(...arguments);
    }


    override async init() {
        await this.dependencyReady();

        this.emit('ready');
    }

}


class MarkdownASTNode extends AutoCastable {
    @Prop({
        required: true
    })
    type!: string;
}

class MDCode extends MarkdownASTNode {
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

class MDHTML extends MarkdownASTNode {
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


class MarkdownASTParentNode extends MarkdownASTNode {

    @Prop({
        default: [],
        arrayOf: MarkdownASTNode
    })
    children!: MarkdownASTNode[];
}


class MarkdownASTRoot extends MarkdownASTParentNode {
    @Prop({
        default: 'root'
    })
    override type!: 'root';
}

class MDParagraph extends MarkdownASTParentNode {
    @Prop({
        default: 'paragraph'
    })
    override type!: 'paragraph';
}

class MDHeading extends MarkdownASTParentNode {
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

class MDList extends MarkdownASTParentNode {
    @Prop({
        default: 'list'
    })
    override type!: 'list';

    @Prop({
        default: false,
    })
    ordered!: boolean;
}

class MDListItem extends MarkdownASTParentNode {
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

class MDLink extends MarkdownASTParentNode {
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

class MDStrong extends MarkdownASTParentNode {
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

class MDEmphasis extends MarkdownASTParentNode {
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

class MDDelete extends MarkdownASTParentNode {
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


class MDLiteral extends MarkdownASTNode {
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

class MDLineBreak extends MarkdownASTNode {
    @Prop({
        default: 'break'
    })
    override type!: 'break';
}

class MDThematicBreak extends MarkdownASTNode {
    @Prop({
        default: 'thematicBreak'
    })
    override type!: 'thematicBreak';
}

class MDImage extends MarkdownASTNode {
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

class MDInlineCode extends MarkdownASTNode {
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

class MDMath extends MarkdownASTNode {
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

class MDInlineMath extends MarkdownASTNode {
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


class MDTableHeading extends MarkdownASTNode {
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

class MDTableHeader extends MarkdownASTParentNode {
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
class MDTableCell extends MarkdownASTParentNode {
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

class MDTableRow extends MarkdownASTParentNode {
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

class MDTable extends MarkdownASTParentNode {
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

class MDBlockQuote extends MarkdownASTParentNode {
    @Prop({
        default: 'blockquote'
    })
    override type!: 'blockquote';
}

export class HTMLToMarkdownJob {



}
