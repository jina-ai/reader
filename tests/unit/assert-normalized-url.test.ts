/**
 * Unit tests for assertNormalizedUrlImpl SSRF checks on DNS-resolved IPs.
 *
 * Self-hosted / non-prod (no GCLOUD_PROJECT, NODE_ENV not prod) used to skip the
 * resolved-IP check because it was gated on `privateIpNotAcceptable`. Direct IP
 * literals in non-public ranges are already rejected; these tests cover hostnames
 * whose A/AAAA records point at private, link-local, or metadata addresses.
 *
 * DNS is injected — no live lookups and no exploit PoC.
 */
import 'reflect-metadata';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { LookupAddress } from 'node:dns';
import { assertNormalizedUrlImpl, privateIpNotAcceptable } from '../../build/services/misc.js';
import { SecurityCompromiseError } from '../../build/services/errors.js';

function mkCtx(addresses: LookupAddress[]) {
    const lookupCalls: string[] = [];
    return {
        lookupCalls,
        ctx: {
            logger: {
                warn() { /* no-op */ },
            },
            geoIpService: {
                lookupCities: async () => [],
            },
            lookup: async (hostname: string, _opts: { all: true }) => {
                lookupCalls.push(hostname);
                return addresses;
            },
        },
    };
}

describe('assertNormalizedUrlImpl: self-hosted resolved-IP SSRF guard', () => {
    it('runs with privateIpNotAcceptable false (no GCLOUD_PROJECT / non-prod)', () => {
        assert.equal(privateIpNotAcceptable, false);
        assert.equal(process.env['GCLOUD_PROJECT'], undefined);
    });

    it('rejects a hostname that resolves to an RFC1918 address', async () => {
        const { ctx, lookupCalls } = mkCtx([{ address: '10.0.0.1', family: 4 }]);
        await assert.rejects(
            () => assertNormalizedUrlImpl('http://internal.example.test/', ctx),
            (err: unknown) => {
                assert.ok(err instanceof SecurityCompromiseError);
                assert.match((err as Error).message, /non-public IP: 10\.0\.0\.1/);
                return true;
            }
        );
        assert.deepEqual(lookupCalls, ['internal.example.test']);
    });

    it('rejects a hostname that resolves to a link-local / metadata address', async () => {
        const { ctx } = mkCtx([{ address: '169.254.169.254', family: 4 }]);
        await assert.rejects(
            () => assertNormalizedUrlImpl('http://metadata.example.test/', ctx),
            (err: unknown) => {
                assert.ok(err instanceof SecurityCompromiseError);
                assert.match((err as Error).message, /non-public IP: 169\.254\.169\.254/);
                return true;
            }
        );
    });

    it('rejects a hostname that resolves to an IPv6 unique-local address', async () => {
        const { ctx } = mkCtx([{ address: 'fd00::1', family: 6 }]);
        await assert.rejects(
            () => assertNormalizedUrlImpl('http://ula.example.test/', ctx),
            (err: unknown) => {
                assert.ok(err instanceof SecurityCompromiseError);
                assert.match((err as Error).message, /non-public IP: fd00::1/);
                return true;
            }
        );
    });

    it('rejects when any resolved record is non-public', async () => {
        const { ctx } = mkCtx([
            { address: '8.8.8.8', family: 4 },
            { address: '192.168.1.20', family: 4 },
        ]);
        await assert.rejects(
            () => assertNormalizedUrlImpl('http://mixed.example.test/', ctx),
            SecurityCompromiseError
        );
    });

    it('allows a hostname that resolves only to a public address', async () => {
        const { ctx } = mkCtx([{ address: '8.8.8.8', family: 4 }]);
        const result = await assertNormalizedUrlImpl('http://public.example.test/', ctx);
        assert.equal(result.url.hostname, 'public.example.test');
        assert.deepEqual(result.ips, ['8.8.8.8']);
    });
});
