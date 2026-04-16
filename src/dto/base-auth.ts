import _ from 'lodash';
import {
    Also, AuthenticationRequiredError,
    RPC_CALL_ENVIRONMENT,
    AutoCastable,
} from 'civkit/civ-rpc';
import { htmlEscape } from 'civkit/escape';

import type { Context } from 'koa';

import { InjectProperty } from '../services/registry';
import { AsyncLocalContext } from '../services/async-context';

import { TierFeatureConstraintError } from '../services/errors';
import { isIPInNonPublicRange } from '../utils/ip';

@Also({
    openapi: {
        operation: {
            parameters: {
                'Authorization': {
                    description: htmlEscape`Token for authentication.\n\n` +
                        htmlEscape`- Member of <BaseAuthDTO>\n\n` +
                        `- Authorization: Bearer {YOUR_JINA_TOKEN}`
                    ,
                    in: 'header',
                    schema: {
                        anyOf: [
                            { type: 'string', format: 'token' }
                        ]
                    }
                }
            }
        }
    }
})
export class BaseAuthDTO<U extends object = object> extends AutoCastable {
    uid?: string;
    bearerToken?: string;
    user?: U;

    ip?: string;
    isInternal?: boolean;

    @InjectProperty(AsyncLocalContext)
    ctxMgr!: AsyncLocalContext;

    static override from(input: any) {
        const instance = super.from(input) as BaseAuthDTO;
        instance.isInternal = false;

        const ctx = input[RPC_CALL_ENVIRONMENT] as Context;

        if (ctx) {
            const authorization = ctx.get('authorization');

            if (authorization) {
                const authToken = authorization.split(' ')[1] || authorization;
                instance.bearerToken = authToken;
            }

            if (ctx.ip) {
                instance.ip = ctx.ip;
                instance.isInternal = ctx.ips.length <= 2 && isIPInNonPublicRange(ctx.ip);
            }
        }

        if (!instance.bearerToken && input._token) {
            instance.bearerToken = input._token;
        }

        return instance;
    }

    async solveUID() {
        if (this.uid) {
            this.ctxMgr.set('uid', this.uid);
            this.ctxMgr.set('bearerToken', this.bearerToken);

            return this.uid;
        }

        if (this.isInternal) {
            return undefined;
        }

        if (this.bearerToken) {
            throw new Error('Not implemented');
        }

        return undefined;
    }

    async assertUID() {
        const uid = await this.solveUID();

        if (!uid) {
            throw new AuthenticationRequiredError('Authentication failed');
        }

        return uid;
    }

    async assertUser() {
        if (this.user) {
            return this.user;
        }

        throw new Error('Not implemented');
    }

    async assertTier(n: number, feature?: string) {
        if (this.isInternal) {
            return true;
        }
        let user;
        try {
            user = await this.assertUser();
        } catch (err) {
            if (err instanceof AuthenticationRequiredError) {
                throw new AuthenticationRequiredError({
                    message: `Authentication is required to use this feature${feature ? ` (${feature})` : ''}. Please provide a valid API key.`
                });
            }

            throw err;
        }

        const tier = user ? 2 : 0;
        if (isNaN(tier) || tier < n) {
            throw new TierFeatureConstraintError({
                message: `Your current plan does not support this feature${feature ? ` (${feature})` : ''}. Please upgrade your plan.`
            });
        }

        return true;
    }
}
