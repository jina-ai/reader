import { AsyncService, AutoCastable, Prop } from 'civkit';
import { Logger } from '../shared/services/logger';

const pMdAstToMarkdown = import('mdast-util-to-markdown');
const pUnistVisitParents = import('unist-util-visit-parents');


export class HTMLtoMarkdown extends AsyncService {

    mdAstToMarkdown!: Awaited<typeof pMdAstToMarkdown>;
    unistVisitParents!: Awaited<typeof pUnistVisitParents>;

    constructor(
        protected logger: Logger,
    ) {
        super(...arguments);
    }


    override async init() {
        await this.dependencyReady();

        this.mdAstToMarkdown = await pMdAstToMarkdown;
        this.unistVisitParents = await pUnistVisitParents;

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
    value!: string;
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
    value!: string;
}


class MarkdownASTParentNode extends MarkdownASTNode {

    @Prop({
        default: [],
        arrayOf: MarkdownASTNode
    })
    children!: MarkdownASTNode[];
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
            return v >=1 && v<=6
        }
    })
    level!: 1|2|3|4|5|6;
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


class MDLiteral extends MarkdownASTNode {
    @Prop({
        default: 'literal'
    })
    override type!: 'literal';

    @Prop({
        required: true,
        default: ''
    })
    value!: string;
}




export class HTMLToMarkdownJob {



}
