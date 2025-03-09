import { AutoCastable, Prop } from 'civkit/civ-rpc';
import {Context} from '../services/registry';
import _ from 'lodash';


export class TurnDownTweakableOptions extends AutoCastable {
    @Prop({
        desc: 'Turndown options > headingStyle',
        type: new Set(['setext', 'atx']),
    })
    headingStyle?: 'setext' | 'atx';

    @Prop({
        desc: 'Turndown options > hr',
        validate: (v: string) => v.length > 0 && v.length <= 128
    })
    hr?: string;

    @Prop({
        desc: 'Turndown options > bulletListMarker',
        type: new Set(['-', '+', '*']),
    })
    bulletListMarker?: '-' | '+' | '*';

    @Prop({
        desc: 'Turndown options > emDelimiter',
        type: new Set(['_', '*']),
    })
    emDelimiter?: '_' | '*';

    @Prop({
        desc: 'Turndown options > strongDelimiter',
        type: new Set(['__', '**']),
    })
    strongDelimiter?: '__' | '**';

    @Prop({
        desc: 'Turndown options > linkStyle',
        type: new Set(['inlined', 'referenced']),
    })
    linkStyle?: 'inlined' | 'referenced';

    @Prop({
        desc: 'Turndown options > linkReferenceStyle',
        type: new Set(['full', 'collapsed', 'shortcut']),
    })
    linkReferenceStyle?: 'full' | 'collapsed' | 'shortcut';

    static fromCtx(ctx: Context, prefix= 'x-md-') {
        const draft: Record<string, string> = {};
        for (const [k, v] of Object.entries(ctx.headers)) {
            if (k.startsWith(prefix)) {
                const prop = k.slice(prefix.length);
                const sk = _.camelCase(prop);
                draft[sk] = v as string;
            }
        }

        return this.from(draft);
    }
}
