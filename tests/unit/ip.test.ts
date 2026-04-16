/**
 * Unit tests for IP-address utilities.
 * No server or network required.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
    parseIp,
    parseCIDR,
    CIDR,
    isIPInNonPublicRange,
    ipBufferToString,
} from '../../build/utils/ip.js';

// ── parseIp ──────────────────────────────────────────────────────────────────

describe('parseIp – IPv4', () => {
    it('parses 0.0.0.0 to a 4-byte all-zero buffer', () => {
        const buf = parseIp('0.0.0.0');
        assert.strictEqual(buf.byteLength, 4);
        assert.deepStrictEqual([...buf], [0, 0, 0, 0]);
    });

    it('parses 255.255.255.255 to a 4-byte all-FF buffer', () => {
        const buf = parseIp('255.255.255.255');
        assert.deepStrictEqual([...buf], [255, 255, 255, 255]);
    });

    it('parses 192.168.1.100 correctly', () => {
        const buf = parseIp('192.168.1.100');
        assert.deepStrictEqual([...buf], [192, 168, 1, 100]);
    });

    it('parses 10.0.0.1 correctly', () => {
        const buf = parseIp('10.0.0.1');
        assert.deepStrictEqual([...buf], [10, 0, 0, 1]);
    });
});

describe('parseIp – IPv6', () => {
    it('parses ::1 (loopback) to a 16-byte buffer ending in 1', () => {
        const buf = parseIp('::1');
        assert.strictEqual(buf.byteLength, 16);
        assert.strictEqual(buf[15], 1);
        assert.deepStrictEqual([...buf.slice(0, 15)], Array(15).fill(0));
    });

    it('parses :: (all-zeros) to a 16-byte zero buffer', () => {
        const buf = parseIp('::');
        assert.strictEqual(buf.byteLength, 16);
        assert.deepStrictEqual([...buf], Array(16).fill(0));
    });

    it('parses a full IPv6 address without compression', () => {
        const buf = parseIp('2001:0db8:0000:0000:0000:0000:0000:0001');
        assert.strictEqual(buf.byteLength, 16);
        assert.strictEqual(buf.readUInt16BE(0), 0x2001);
        assert.strictEqual(buf.readUInt16BE(2), 0x0db8);
        assert.strictEqual(buf.readUInt16BE(14), 0x0001);
    });

    it('parses a compressed IPv6 address with ::', () => {
        const buf = parseIp('2001:db8::1');
        assert.strictEqual(buf.byteLength, 16);
        assert.strictEqual(buf.readUInt16BE(0), 0x2001);
        assert.strictEqual(buf.readUInt16BE(2), 0x0db8);
        assert.strictEqual(buf.readUInt16BE(14), 0x0001);
    });
});

describe('parseIp – invalid input', () => {
    it('throws for a non-IP string', () => {
        assert.throws(() => parseIp('not-an-ip'), /Invalid IP/);
    });

    it('throws for an empty string', () => {
        assert.throws(() => parseIp(''), /Invalid IP/);
    });
});

// ── parseCIDR ─────────────────────────────────────────────────────────────────

describe('parseCIDR', () => {
    it('returns two buffers of equal length for an IPv4 CIDR', () => {
        const [ip, mask] = parseCIDR('10.0.0.0/8');
        assert.strictEqual(ip.byteLength, 4);
        assert.strictEqual(mask.byteLength, 4);
    });

    it('masks higher bits correctly for /8', () => {
        const [ip, mask] = parseCIDR('10.0.0.0/8');
        assert.strictEqual(ip[0], 10);
        assert.strictEqual(ip[1], 0);
        assert.strictEqual(mask[0], 0xff);
        assert.strictEqual(mask[1], 0);
    });

    it('masks higher bits correctly for /24', () => {
        const [ip, mask] = parseCIDR('192.168.1.0/24');
        assert.strictEqual(ip[0], 192);
        assert.strictEqual(ip[1], 168);
        assert.strictEqual(ip[2], 1);
        assert.strictEqual(ip[3], 0);
        assert.strictEqual(mask[2], 0xff);
        assert.strictEqual(mask[3], 0);
    });

    it('handles /32 (host route) with all bits masked', () => {
        const [ip, mask] = parseCIDR('8.8.8.8/32');
        assert.deepStrictEqual([...mask], [0xff, 0xff, 0xff, 0xff]);
        assert.deepStrictEqual([...ip], [8, 8, 8, 8]);
    });
});

// ── CIDR.test() ───────────────────────────────────────────────────────────────

describe('CIDR', () => {
    it('matches an IP that belongs to the subnet', () => {
        const cidr = new CIDR('10.0.0.0/8');
        assert.strictEqual(cidr.test('10.1.2.3'), true);
    });

    it('does not match an IP outside the subnet', () => {
        const cidr = new CIDR('10.0.0.0/8');
        assert.strictEqual(cidr.test('192.168.1.1'), false);
    });

    it('matches the network address itself', () => {
        const cidr = new CIDR('192.168.0.0/16');
        assert.strictEqual(cidr.test('192.168.0.0'), true);
    });

    it('matches the broadcast-like address at the top of the range', () => {
        const cidr = new CIDR('192.168.0.0/16');
        assert.strictEqual(cidr.test('192.168.255.255'), true);
    });

    it('does not match an IPv4 address against an IPv6 CIDR', () => {
        const cidr = new CIDR('::1/128');
        assert.strictEqual(cidr.test('127.0.0.1'), false);
    });

    it('exposes the correct address family for IPv4', () => {
        assert.strictEqual(new CIDR('10.0.0.0/8').family, 4);
    });

    it('exposes the correct address family for IPv6', () => {
        assert.strictEqual(new CIDR('::1/128').family, 6);
    });

    it('toString() returns the original CIDR string', () => {
        assert.strictEqual(new CIDR('10.0.0.0/8').toString(), '10.0.0.0/8');
    });
});

// ── isIPInNonPublicRange ──────────────────────────────────────────────────────

describe('isIPInNonPublicRange', () => {
    it('recognises 10.x.x.x as non-public (RFC 1918)', () => {
        assert.strictEqual(isIPInNonPublicRange('10.0.0.1'), true);
    });

    it('recognises 172.16.x.x as non-public (RFC 1918)', () => {
        assert.strictEqual(isIPInNonPublicRange('172.16.0.1'), true);
    });

    it('recognises 192.168.x.x as non-public (RFC 1918)', () => {
        assert.strictEqual(isIPInNonPublicRange('192.168.1.1'), true);
    });

    it('recognises 127.0.0.1 as non-public (loopback)', () => {
        assert.strictEqual(isIPInNonPublicRange('127.0.0.1'), true);
    });

    it('recognises 169.254.0.1 as non-public (link-local)', () => {
        assert.strictEqual(isIPInNonPublicRange('169.254.0.1'), true);
    });

    it('recognises ::1 as non-public (IPv6 loopback)', () => {
        assert.strictEqual(isIPInNonPublicRange('::1'), true);
    });

    it('classifies a public IP as public', () => {
        assert.strictEqual(isIPInNonPublicRange('8.8.8.8'), false);
    });

    it('classifies another public IP (1.1.1.1) as public', () => {
        assert.strictEqual(isIPInNonPublicRange('1.1.1.1'), false);
    });
});

// ── ipBufferToString ──────────────────────────────────────────────────────────

describe('ipBufferToString', () => {
    it('converts a 4-byte IPv4 buffer back to dotted notation', () => {
        const buf = parseIp('192.168.1.100');
        assert.strictEqual(ipBufferToString(buf), '192.168.1.100');
    });

    it('converts 0.0.0.0 buffer correctly', () => {
        const buf = parseIp('0.0.0.0');
        assert.strictEqual(ipBufferToString(buf), '0.0.0.0');
    });

    it('throws for a buffer of unexpected length', () => {
        const bad = Buffer.alloc(3);
        assert.throws(() => ipBufferToString(bad));
    });

    it('round-trips a public IPv4 address', () => {
        const original = '8.8.8.8';
        assert.strictEqual(ipBufferToString(parseIp(original)), original);
    });
});
